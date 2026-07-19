use crate::core::{
    advanced, blame, branch, commit as commit_mod, diff, graph, history, ops, refs, repo, stash,
    status, worktree,
};
use crate::error::{Error, Result};
use crate::state::{
    AppState, CachedGraph, HistoryEntry, RepoSnapshot, RestoreMode,
};
use crate::{shellout, watcher};
use git2::Repository;
use serde::Serialize;
use tauri::{AppHandle, State};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStatus {
    undo_label: Option<String>,
    redo_label: Option<String>,
    restored_message: Option<String>,
}

fn snapshot(path: &str) -> Result<RepoSnapshot> {
    let repo = open(path)?;
    let head = match repo.head() {
        Ok(head) => head,
        Err(_) if repo.is_empty().unwrap_or(false) => {
            let head_ref = repo
                .find_reference("HEAD")
                .ok()
                .and_then(|head| head.symbolic_target().map(str::to_string));
            return Ok(RepoSnapshot {
                oid: String::new(),
                head_ref,
            });
        }
        Err(error) => return Err(error.into()),
    };
    let oid = head
        .target()
        .or_else(|| head.peel_to_commit().ok().map(|c| c.id()))
        .ok_or_else(|| Error::Msg("HEAD has no commit".into()))?
        .to_string();
    let head_ref = if repo.head_detached().unwrap_or(false) {
        None
    } else {
        head.name().map(str::to_string)
    };
    Ok(RepoSnapshot { oid, head_ref })
}

fn record_history(
    state: &State<'_, AppState>,
    path: &str,
    label: &str,
    before: RepoSnapshot,
    mode: RestoreMode,
) -> Result<()> {
    let after = snapshot(path)?;
    if before.oid == after.oid && before.head_ref == after.head_ref {
        return Ok(());
    }
    let mut all = state.history.lock().map_err(|_| Error::Msg("history lock poisoned".into()))?;
    let stacks = all.entry(path.to_string()).or_default();
    stacks.undo.push(HistoryEntry {
        label: label.to_string(),
        before,
        after,
        mode,
        draft: None,
    });
    if stacks.undo.len() > 100 {
        stacks.undo.remove(0);
    }
    stacks.redo.clear();
    Ok(())
}

fn remember_pending(
    state: &State<'_, AppState>,
    path: &str,
    label: &str,
    before: RepoSnapshot,
    mode: RestoreMode,
) -> Result<()> {
    state
        .pending_history
        .lock()
        .map_err(|_| Error::Msg("history lock poisoned".into()))?
        .insert(path.to_string(), (label.to_string(), before, mode));
    Ok(())
}

fn restore_snapshot(path: &str, snap: &RepoSnapshot, mode: RestoreMode) -> Result<()> {
    let repo = open(path)?;
    if snap.oid.is_empty() {
        if let Some(name) = &snap.head_ref {
            if let Ok(mut reference) = repo.find_reference(name) {
                reference.delete()?;
            }
            repo.set_head(name)?;
        }
        return Ok(());
    }
    let object = repo.revparse_single(&snap.oid)?;
    if matches!(mode, RestoreMode::Checkout) {
        return branch::checkout_ref(&repo, snap.head_ref.as_deref().unwrap_or(&snap.oid));
    }
    match &snap.head_ref {
        Some(name) => {
            repo.reference(name, object.id(), true, "MTGit undo/redo")?;
            repo.set_head(name)?;
        }
        None => repo.set_head_detached(object.id())?,
    }
    if matches!(mode, RestoreMode::Merge) {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(path)
            .args(["reset", "--merge", &snap.oid])
            .output()?;
        if !output.status.success() {
            return Err(Error::Msg(String::from_utf8_lossy(&output.stderr).trim().to_string()));
        }
        return Ok(());
    }
    let kind = match mode {
        RestoreMode::Hard => git2::ResetType::Hard,
        RestoreMode::Soft => git2::ResetType::Soft,
        RestoreMode::Merge | RestoreMode::Checkout => unreachable!(),
    };
    repo.reset(&object, kind, None)?;
    Ok(())
}

fn open(path: &str) -> Result<Repository> {
    Repository::discover(path)
        .map_err(|_| Error::Msg(format!("no git repository found at '{path}'")))
}

// ---- M0/M1: repo, refs, graph ------------------------------------------------

#[tauri::command]
pub fn open_repo(path: String) -> Result<repo::RepoInfo> {
    repo::open(&path)
}

#[tauri::command]
pub fn git_available() -> bool {
    shellout::git_available()
}

#[tauri::command]
pub fn list_refs(path: String) -> Result<refs::RefList> {
    refs::list(&open(&path)?)
}

#[tauri::command]
pub fn get_graph(
    path: String,
    skip: usize,
    limit: usize,
    state: State<'_, AppState>,
) -> Result<graph::GraphPage> {
    let repo = open(&path)?;
    let head = repo.head().ok().and_then(|h| h.target()).map(|o| o.to_string());
    let mut ref_state: Vec<String> = repo
        .references()?
        .flatten()
        .filter_map(|reference| {
            let name = reference.name()?.to_string();
            let target = reference
                .target()
                .or_else(|| reference.peel_to_commit().ok().map(|commit| commit.id()))?;
            Some(format!("{name}:{target}"))
        })
        .collect();
    ref_state.sort();
    let cache_key = Some(format!("{}|{}", head.as_deref().unwrap_or(""), ref_state.join(",")));

    let mut cache = state.graph_cache.lock().map_err(|_| Error::Msg("graph cache poisoned".into()))?;
    let needs_rebuild = match cache.get(&path) {
        Some(c) => c.head != cache_key,
        None => true,
    };
    if needs_rebuild {
        let layouts = graph::layout(&repo)?;
        let badges = refs::badges_by_oid(&repo);
        let rows = graph::build_rows(&repo, &layouts, &badges)?;
        cache.insert(path.clone(), CachedGraph { head: cache_key, rows });
    }

    let cached = cache.get(&path).expect("just inserted");
    let total = cached.rows.len();
    let end = skip.saturating_add(limit).min(total);
    let rows = if skip < total { cached.rows[skip..end].to_vec() } else { Vec::new() };
    Ok(graph::GraphPage { rows, total, head })
}

// ---- M2: commit detail + diff ------------------------------------------------

#[tauri::command]
pub fn get_commit(path: String, oid: String) -> Result<diff::CommitDetail> {
    diff::commit_detail(&open(&path)?, &oid)
}

#[tauri::command]
pub fn get_commit_diff(path: String, oid: String, path_filter: Option<String>) -> Result<Vec<diff::FileDiff>> {
    diff::commit_diff(&open(&path)?, &oid, path_filter.as_deref())
}

#[tauri::command]
pub fn get_worktree_diff(path: String, staged: bool, path_filter: Option<String>) -> Result<Vec<diff::FileDiff>> {
    diff::worktree_diff(&open(&path)?, staged, path_filter.as_deref())
}

#[tauri::command]
pub fn compare_commits(path: String, old: String, new: String) -> Result<Vec<diff::FileDiff>> {
    diff::compare_commits(&open(&path)?, &old, &new)
}

// ---- M3: status, staging, commit ---------------------------------------------

#[tauri::command]
pub fn get_status(path: String) -> Result<status::StatusReport> {
    status::status(&open(&path)?)
}

#[tauri::command]
pub fn stage_paths(path: String, paths: Vec<String>) -> Result<()> {
    status::stage_paths(&open(&path)?, &paths)
}

#[tauri::command]
pub fn unstage_paths(path: String, paths: Vec<String>) -> Result<()> {
    status::unstage_paths(&open(&path)?, &paths)
}

#[tauri::command]
pub fn discard_paths(path: String, paths: Vec<String>) -> Result<()> {
    status::discard_paths(&open(&path)?, &paths)
}

#[tauri::command]
pub fn ignore_path(path: String, file: String) -> Result<()> {
    status::ignore_path(&open(&path)?, &file)
}

#[tauri::command]
pub fn commit(path: String, message: String, amend: bool) -> Result<String> {
    commit_mod::commit(&open(&path)?, &message, amend)
}

#[tauri::command]
pub fn commit_advanced(
    path: String,
    summary: String,
    description: String,
    amend: bool,
    no_verify: bool,
    state: State<'_, AppState>,
) -> Result<advanced::CommandResult> {
    let before = snapshot(&path).ok();
    let result = advanced::commit_cli(&path, &summary, &description, amend, no_verify)?;
    if result.success {
        if let Some(before) = before {
            record_history(
                &state,
                &path,
                if amend { "Amend commit" } else { "Commit" },
                before,
                RestoreMode::Soft,
            )?;
            if !amend {
                let mut all = state
                    .history
                    .lock()
                    .map_err(|_| Error::Msg("history lock poisoned".into()))?;
                if let Some(entry) = all.get_mut(&path).and_then(|stack| stack.undo.last_mut()) {
                    entry.draft = Some(if description.trim().is_empty() {
                        summary.clone()
                    } else {
                        format!("{summary}\n\n{description}")
                    });
                }
            }
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn get_head_message(path: String) -> Result<String> {
    advanced::head_message(&path)
}

#[tauri::command]
pub fn set_upstream(path: String, local: String, upstream: String) -> Result<()> {
    advanced::set_upstream(&path, &local, &upstream)
}

#[tauri::command]
pub fn apply_patch(path: String, patch: String, cached: bool, reverse: bool) -> Result<()> {
    advanced::apply_patch(&path, &patch, cached, reverse)
}

// ---- M4: branches, merge, stash, remotes -------------------------------------

#[tauri::command]
pub fn create_branch(path: String, name: String, target: Option<String>, checkout: bool) -> Result<()> {
    branch::create_branch(&open(&path)?, &name, target.as_deref(), checkout)
}

#[tauri::command]
pub fn delete_branch(path: String, name: String, force: bool) -> Result<()> {
    branch::delete_branch(&open(&path)?, &name, force)
}

#[tauri::command]
pub fn rename_branch(path: String, old: String, new: String) -> Result<()> {
    branch::rename_branch(&open(&path)?, &old, &new)
}

#[tauri::command]
pub fn checkout(path: String, refname: String, state: State<'_, AppState>) -> Result<()> {
    let before = snapshot(&path)?;
    branch::checkout_ref(&open(&path)?, &refname)?;
    record_history(&state, &path, "Checkout", before, RestoreMode::Checkout)
}

#[tauri::command]
pub fn checkout_advanced(
    path: String,
    refname: String,
    recovery: advanced::CheckoutRecovery,
    local_name: Option<String>,
    state: State<'_, AppState>,
) -> Result<advanced::CheckoutResult> {
    let before = snapshot(&path)?;
    let result = advanced::checkout(&path, &refname, recovery, local_name.as_deref())?;
    record_history(&state, &path, "Checkout", before, RestoreMode::Checkout)?;
    Ok(result)
}

#[tauri::command]
pub fn merge_ref(
    path: String,
    their_ref: String,
    mode: branch::MergeMode,
    state: State<'_, AppState>,
) -> Result<branch::MergeResult> {
    let before = snapshot(&path)?;
    let result = branch::merge(&open(&path)?, &their_ref, mode)?;
    if result.kind != branch::MergeKind::Conflicts {
        record_history(&state, &path, "Merge", before, RestoreMode::Merge)?;
    } else {
        remember_pending(&state, &path, "Merge", before, RestoreMode::Merge)?;
    }
    Ok(result)
}

#[tauri::command]
pub fn merge_advanced(
    path: String,
    their_ref: String,
    mode: branch::MergeMode,
    state: State<'_, AppState>,
) -> Result<branch::MergeResult> {
    let before = snapshot(&path)?;
    let result = advanced::merge(&path, &their_ref, mode)?;
    if result.kind != branch::MergeKind::Conflicts {
        record_history(&state, &path, "Merge", before, RestoreMode::Merge)?;
    } else {
        remember_pending(&state, &path, "Merge", before, RestoreMode::Merge)?;
    }
    Ok(result)
}

#[tauri::command]
pub fn cherry_pick(path: String, oid: String, state: State<'_, AppState>) -> Result<ops::ConflictResult> {
    let before = snapshot(&path)?;
    let result = ops::cherry_pick(&open(&path)?, &oid)?;
    if result.conflicts.is_empty() {
        record_history(&state, &path, "Cherry-pick", before, RestoreMode::Merge)?;
    } else {
        remember_pending(&state, &path, "Cherry-pick", before, RestoreMode::Merge)?;
    }
    Ok(result)
}

#[tauri::command]
pub fn cherry_pick_many(
    path: String,
    oids: Vec<String>,
    commit_immediately: bool,
    mainline: Option<usize>,
    append_origin: bool,
    state: State<'_, AppState>,
) -> Result<advanced::CommandResult> {
    let before = snapshot(&path)?;
    let result = advanced::cherry_pick_many(
        &path,
        &oids,
        commit_immediately,
        mainline,
        append_origin,
    )?;
    if result.success && commit_immediately {
        record_history(&state, &path, "Cherry-pick", before, RestoreMode::Merge)?;
    } else if !result.conflicts.is_empty() {
        remember_pending(&state, &path, "Cherry-pick", before, RestoreMode::Merge)?;
    }
    Ok(result)
}

#[tauri::command]
pub fn reset_to(path: String, oid: String, mode: ops::ResetMode, state: State<'_, AppState>) -> Result<()> {
    let before = snapshot(&path)?;
    ops::reset(&open(&path)?, &oid, mode)?;
    record_history(&state, &path, "Reset", before, RestoreMode::Hard)
}

#[tauri::command]
pub fn rebase_onto(path: String, onto: String, state: State<'_, AppState>) -> Result<ops::RebaseResult> {
    let before = snapshot(&path)?;
    let result = ops::rebase(&open(&path)?, &onto)?;
    if result.done {
        record_history(&state, &path, "Rebase", before, RestoreMode::Merge)?;
    } else {
        remember_pending(&state, &path, "Rebase", before, RestoreMode::Merge)?;
    }
    Ok(result)
}

#[tauri::command]
pub fn rebase_continue(path: String) -> Result<ops::RebaseResult> {
    ops::rebase_continue(&open(&path)?)
}

#[tauri::command]
pub fn rebase_abort(path: String) -> Result<()> {
    ops::rebase_abort(&open(&path)?)
}

/// Abort a pending merge / cherry-pick / revert, discarding the half-applied
/// changes and restoring HEAD.
#[tauri::command]
pub fn abort_operation(path: String) -> Result<()> {
    ops::abort_pending(&open(&path)?)
}

#[tauri::command]
pub fn revert_commit(path: String, oid: String, state: State<'_, AppState>) -> Result<ops::ConflictResult> {
    let before = snapshot(&path)?;
    let result = ops::revert(&open(&path)?, &oid)?;
    if result.conflicts.is_empty() {
        record_history(&state, &path, "Revert", before, RestoreMode::Merge)?;
    } else {
        remember_pending(&state, &path, "Revert", before, RestoreMode::Merge)?;
    }
    Ok(result)
}

#[tauri::command]
pub fn rewrite_info(path: String, base: String) -> Result<advanced::RewriteInfo> {
    advanced::rewrite_info(&path, &base)
}

#[tauri::command]
pub fn rebase_commits(path: String, base: String) -> Result<Vec<advanced::RebaseCommit>> {
    advanced::rebase_commits(&path, &base)
}

#[tauri::command]
pub fn rebase_standard(
    path: String,
    onto: String,
    state: State<'_, AppState>,
) -> Result<advanced::CommandResult> {
    let before = snapshot(&path)?;
    let result = advanced::standard_rebase(&path, &onto)?;
    if result.success {
        record_history(&state, &path, "Rebase", before, RestoreMode::Merge)?;
    } else if !result.conflicts.is_empty() {
        remember_pending(&state, &path, "Rebase", before, RestoreMode::Merge)?;
    }
    Ok(result)
}

#[tauri::command]
pub fn interactive_rebase(
    path: String,
    base: String,
    plan: Vec<advanced::RebasePlanItem>,
    state: State<'_, AppState>,
) -> Result<advanced::CommandResult> {
    let before = snapshot(&path)?;
    let result = advanced::interactive_rebase(&path, &base, &plan)?;
    if result.success {
        record_history(&state, &path, "Interactive rebase", before, RestoreMode::Merge)?;
    } else if !result.conflicts.is_empty() {
        remember_pending(&state, &path, "Interactive rebase", before, RestoreMode::Merge)?;
    }
    Ok(result)
}

#[tauri::command]
pub fn operation_info(path: String) -> Result<Option<advanced::OperationInfo>> {
    advanced::operation_info(&path)
}

#[tauri::command]
pub fn operation_continue(path: String, state: State<'_, AppState>) -> Result<advanced::CommandResult> {
    let result = advanced::operation_continue(&path)?;
    if result.success {
        let pending = state
            .pending_history
            .lock()
            .map_err(|_| Error::Msg("history lock poisoned".into()))?
            .remove(&path);
        if let Some((label, before, mode)) = pending {
            record_history(&state, &path, &label, before, mode)?;
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn operation_skip(path: String, state: State<'_, AppState>) -> Result<advanced::CommandResult> {
    let result = advanced::operation_skip(&path)?;
    if result.success {
        let pending = state
            .pending_history
            .lock()
            .map_err(|_| Error::Msg("history lock poisoned".into()))?
            .remove(&path);
        if let Some((label, before, mode)) = pending {
            record_history(&state, &path, &label, before, mode)?;
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn operation_abort(path: String, state: State<'_, AppState>) -> Result<()> {
    advanced::operation_abort(&path)?;
    state
        .pending_history
        .lock()
        .map_err(|_| Error::Msg("history lock poisoned".into()))?
        .remove(&path);
    Ok(())
}

#[tauri::command]
pub fn get_conflict_file(path: String, file: String) -> Result<advanced::ConflictFile> {
    advanced::conflict_file(&path, &file)
}

#[tauri::command]
pub fn resolve_conflict_content(path: String, file: String, content: String) -> Result<()> {
    advanced::resolve_conflict_content(&path, &file, &content)
}

#[tauri::command]
pub fn resolve_conflict_side(path: String, file: String, side: String) -> Result<()> {
    advanced::resolve_conflict_side(&path, &file, &side)
}

#[tauri::command]
pub fn create_patch(path: String, oid: String, out_path: String) -> Result<()> {
    ops::format_patch(&open(&path)?, &oid, &out_path)
}

// ---- Tags, remotes, worktrees, blame, history, file content ------------------

#[tauri::command]
pub fn create_tag(path: String, name: String, target: String, message: Option<String>) -> Result<()> {
    refs::create_tag(&open(&path)?, &name, &target, message.as_deref())
}

#[tauri::command]
pub fn delete_tag(path: String, name: String) -> Result<()> {
    refs::delete_tag(&open(&path)?, &name)
}

#[tauri::command]
pub fn get_remote_url(path: String, remote: String) -> Result<Option<String>> {
    Ok(refs::remote_url(&open(&path)?, &remote))
}

#[tauri::command]
pub fn list_worktrees(path: String) -> Result<Vec<worktree::WorktreeInfo>> {
    worktree::list(&open(&path)?)
}

#[tauri::command]
pub fn list_submodules(path: String) -> Result<Vec<worktree::SubmoduleInfo>> {
    worktree::list_submodules(&open(&path)?)
}

#[tauri::command]
pub fn update_submodules(path: String) -> Result<()> {
    advanced::update_submodules(&path)
}

#[tauri::command]
pub fn create_worktree(
    path: String,
    name: String,
    worktree_path: String,
    target: Option<String>,
) -> Result<()> {
    worktree::add(&open(&path)?, &name, &worktree_path, target.as_deref())
}

#[tauri::command]
pub fn blame_file(path: String, file: String, oid: Option<String>) -> Result<Vec<blame::BlameLine>> {
    blame::blame_file(&open(&path)?, &file, oid.as_deref())
}

#[tauri::command]
pub fn file_history(path: String, file: String, limit: usize) -> Result<Vec<history::HistoryEntry>> {
    history::file_log(&open(&path)?, &file, limit)
}

#[tauri::command]
pub fn file_at_commit(path: String, oid: String, file: String) -> Result<diff::FileContent> {
    diff::file_content(&open(&path)?, &oid, &file)
}

#[tauri::command]
pub fn stash_save(path: String, message: Option<String>, include_untracked: bool) -> Result<String> {
    stash::save(&mut open(&path)?, message.as_deref(), include_untracked)
}

#[tauri::command]
pub fn stash_list(path: String) -> Result<Vec<stash::StashEntry>> {
    stash::list(&mut open(&path)?)
}

#[tauri::command]
pub fn stash_apply(path: String, index: usize) -> Result<()> {
    stash::apply(&mut open(&path)?, index)
}

#[tauri::command]
pub fn stash_pop(path: String, index: usize) -> Result<()> {
    stash::pop(&mut open(&path)?, index)
}

#[tauri::command]
pub fn stash_drop(path: String, index: usize) -> Result<()> {
    stash::drop(&mut open(&path)?, index)
}

#[tauri::command]
pub fn git_network(
    app: AppHandle,
    path: String,
    op: String,
    remote: Option<String>,
    extra: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<shellout::GitOpResult> {
    let before = if op == "pull" { snapshot(&path).ok() } else { None };
    let result = shellout::run(
        &app,
        &path,
        &op,
        remote.as_deref(),
        &extra.unwrap_or_default(),
        &state.network_pids,
    )?;
    if result.success && op == "pull" {
        if let Some(before) = before {
            record_history(&state, &path, "Pull", before, RestoreMode::Merge)?;
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn cancel_git_network(path: String, state: State<'_, AppState>) -> Result<()> {
    let pid = state
        .network_pids
        .lock()
        .map_err(|_| Error::Msg("network process lock poisoned".into()))?
        .get(&path)
        .copied()
        .ok_or_else(|| Error::Msg("no network operation is running".into()))?;
    #[cfg(unix)]
    let status = std::process::Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status()?;
    #[cfg(windows)]
    let status = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(Error::Msg("could not cancel the git process".into()))
    }
}

#[tauri::command]
pub fn git_auto_fetch(path: String) -> Result<shellout::GitOpResult> {
    shellout::run_silent(
        &path,
        "fetch",
        None,
        &["--all".to_string(), "--prune".to_string()],
    )
}

#[tauri::command]
pub fn history_status(path: String, state: State<'_, AppState>) -> Result<HistoryStatus> {
    let all = state.history.lock().map_err(|_| Error::Msg("history lock poisoned".into()))?;
    let stacks = all.get(&path);
    Ok(HistoryStatus {
        undo_label: stacks.and_then(|s| s.undo.last()).map(|e| e.label.clone()),
        redo_label: stacks.and_then(|s| s.redo.last()).map(|e| e.label.clone()),
        restored_message: None,
    })
}

#[tauri::command]
pub fn clear_history(path: String, state: State<'_, AppState>) -> Result<()> {
    state
        .history
        .lock()
        .map_err(|_| Error::Msg("history lock poisoned".into()))?
        .remove(&path);
    Ok(())
}

#[tauri::command]
pub fn undo(path: String, state: State<'_, AppState>) -> Result<HistoryStatus> {
    let entry = {
        let mut all = state.history.lock().map_err(|_| Error::Msg("history lock poisoned".into()))?;
        all.entry(path.clone())
            .or_default()
            .undo
            .pop()
            .ok_or_else(|| Error::Msg("nothing to undo".into()))?
    };
    if let Err(error) = restore_snapshot(&path, &entry.before, entry.mode) {
        let mut all = state.history.lock().map_err(|_| Error::Msg("history lock poisoned".into()))?;
        all.entry(path).or_default().undo.push(entry);
        return Err(error);
    }
    let mut all = state.history.lock().map_err(|_| Error::Msg("history lock poisoned".into()))?;
    let stacks = all.entry(path).or_default();
    let restored_message = entry.draft.clone();
    stacks.redo.push(entry);
    Ok(HistoryStatus {
        undo_label: stacks.undo.last().map(|e| e.label.clone()),
        redo_label: stacks.redo.last().map(|e| e.label.clone()),
        restored_message,
    })
}

#[tauri::command]
pub fn redo(path: String, state: State<'_, AppState>) -> Result<HistoryStatus> {
    let entry = {
        let mut all = state.history.lock().map_err(|_| Error::Msg("history lock poisoned".into()))?;
        all.entry(path.clone())
            .or_default()
            .redo
            .pop()
            .ok_or_else(|| Error::Msg("nothing to redo".into()))?
    };
    if let Err(error) = restore_snapshot(&path, &entry.after, entry.mode) {
        let mut all = state.history.lock().map_err(|_| Error::Msg("history lock poisoned".into()))?;
        all.entry(path).or_default().redo.push(entry);
        return Err(error);
    }
    let mut all = state.history.lock().map_err(|_| Error::Msg("history lock poisoned".into()))?;
    let stacks = all.entry(path).or_default();
    stacks.undo.push(entry);
    Ok(HistoryStatus {
        undo_label: stacks.undo.last().map(|e| e.label.clone()),
        redo_label: stacks.redo.last().map(|e| e.label.clone()),
        restored_message: None,
    })
}

// ---- M3: fs watcher ----------------------------------------------------------

#[tauri::command]
pub fn watch_repo(app: AppHandle, path: String, state: State<'_, AppState>) -> Result<()> {
    let repo = open(&path)?;
    let workdir = repo
        .workdir()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| Error::Msg("cannot watch a bare repo".into()))?;

    let mut watchers = state.watchers.lock().map_err(|_| Error::Msg("watcher lock poisoned".into()))?;
    if watchers.contains_key(&path) {
        return Ok(());
    }
    let debouncer = watcher::watch(app, &path, &workdir).map_err(|e| Error::Msg(e.to_string()))?;
    watchers.insert(path, debouncer);
    Ok(())
}

// ---- M5: terminal ------------------------------------------------------------

#[tauri::command]
pub fn pty_spawn(app: AppHandle, cwd: String, rows: u16, cols: u16, state: State<'_, AppState>) -> Result<String> {
    state.pty.spawn(app, &cwd, rows, cols)
}

#[tauri::command]
pub fn pty_write(id: String, data: String, state: State<'_, AppState>) -> Result<()> {
    state.pty.write(&id, &data)
}

#[tauri::command]
pub fn pty_resize(id: String, rows: u16, cols: u16, state: State<'_, AppState>) -> Result<()> {
    state.pty.resize(&id, rows, cols)
}

#[tauri::command]
pub fn pty_kill(id: String, state: State<'_, AppState>) -> Result<()> {
    state.pty.kill(&id)
}
