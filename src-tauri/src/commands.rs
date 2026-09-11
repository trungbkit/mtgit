use crate::core::{
    advanced, blame, branch, commit as commit_mod, diff, graph, history, identity, ops, refs,
    remote, repo, search, settings, stash, status, terminal as terminal_tokens, worktree,
};
use crate::error::{Error, Result};
use crate::state::{
    AppState, CachedGraph, CachedSearch, HistoryEntry, RepoSnapshot, RestoreMode,
};
use crate::{shellout, watcher};
use git2::Repository;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use tauri::{AppHandle, Emitter, State};

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

/// Create a repository and open it in one step (G2).
#[tauri::command]
pub fn init_repo(path: String, bare: bool) -> Result<repo::RepoInfo> {
    repo::init(&path, bare)
}

/// Clone a repository and open it (G1).
///
/// Unlike `git_network`, this **rejects** rather than resolving with a failed
/// `GitOpResult`. Every other network op reports into a repository that is
/// already on screen; a clone has no such home — a half-finished clone is not
/// a repo the user can be dropped into, so the only useful outcomes are a
/// `RepoInfo` or an error. Callers get git's own message, which is the one
/// that names the real problem (auth, DNS, a non-empty directory).
#[tauri::command]
pub fn clone_repo(
    app: AppHandle,
    url: String,
    dest: String,
    recurse_submodules: bool,
    depth: Option<u32>,
    branch: Option<String>,
    state: State<'_, AppState>,
) -> Result<repo::RepoInfo> {
    remote::check_url(&url)?;
    let target = std::path::Path::new(&dest);
    let existed = target.exists();
    if target.is_dir()
        && target
            .read_dir()
            .map(|mut entries| entries.next().is_some())
            .unwrap_or(false)
    {
        return Err(Error::Msg(format!("'{dest}' already exists and is not empty")));
    }

    let opts = shellout::CloneOptions {
        recurse_submodules,
        depth,
        branch,
        bare: false,
    };
    let result = shellout::clone(&app, &url, &dest, &opts, &state.network_pids)?;
    if !result.success {
        // git removes the directory it created when a clone fails — except
        // when it is killed, which is exactly what the Cancel button does.
        // Leaving the husk behind turns "cancel, fix the URL, retry" into
        // "already exists and is not empty". Only a directory that did not
        // exist before this call is removed, so nothing of the user's can be
        // caught by it.
        if !existed && target.is_dir() {
            let _ = std::fs::remove_dir_all(target);
        }
        return Err(Error::Msg(clone_failure(&result.output)));
    }
    repo::open(&dest)
}

/// git narrates a clone over many progress lines; the failure is in the last
/// few. Showing the whole transcript in a toast buries it.
fn clone_failure(output: &str) -> String {
    let tail: Vec<&str> = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.contains('\r'))
        .rev()
        .take(3)
        .collect();
    if tail.is_empty() {
        "clone failed".to_string()
    } else {
        tail.into_iter().rev().collect::<Vec<_>>().join("\n")
    }
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
    let mut cache = state
        .graph_cache
        .lock()
        .map_err(|_| Error::Msg("graph cache poisoned".into()))?;
    graph_page(&repo, &mut cache, &path, skip, limit)
}

/// Serve one page of the graph, rebuilding the cached layout when the
/// repository's ref set has changed.
///
/// Split out of [`get_graph`] so the cache-invalidation rule is testable
/// without a Tauri `State`.
fn graph_page(
    repo: &Repository,
    cache: &mut HashMap<String, CachedGraph>,
    path: &str,
    skip: usize,
    limit: usize,
) -> Result<graph::GraphPage> {
    let cached = ensure_cached_rows(repo, cache, path)?;
    let total = cached.rows.len();
    let end = skip.saturating_add(limit).min(total);
    let rows = if skip < total { cached.rows[skip..end].to_vec() } else { Vec::new() };
    let head = repo.head().ok().and_then(|h| h.target()).map(|o| o.to_string());
    Ok(graph::GraphPage { rows, total, head })
}

/// Return the cached full layout, rebuilding it when the ref set has moved.
///
/// Shared by `get_graph` and `search_commits`: a search's page hints are row
/// indices *in this list*, so both have to be looking at the same layout, and
/// keying them both on `refs_digest` is what guarantees it (invariant 4).
fn ensure_cached_rows<'c>(
    repo: &Repository,
    cache: &'c mut HashMap<String, CachedGraph>,
    path: &str,
) -> Result<&'c CachedGraph> {
    let key = graph::refs_digest(repo);
    let needs_rebuild = cache.get(path).map(|c| c.key != key).unwrap_or(true);
    if needs_rebuild {
        let layouts = graph::layout(repo)?;
        let badges = refs::badges_by_oid(repo);
        let rows = graph::build_rows(repo, &layouts, &badges)?;
        cache.insert(path.to_string(), CachedGraph { key, rows });
    }
    Ok(cache.get(path).expect("just inserted"))
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SearchProgress {
    /// Commits matched so far. The walk reports as it goes because a pickaxe
    /// search over a large history is slow enough to look like a hang.
    count: usize,
    done: bool,
}

/// Search history for commits matching a GitLens-grammar query.
///
/// Read-only, so it deliberately takes **no** op guard (invariant 2): a search
/// changes nothing the watcher needs to be shielded from.
#[tauri::command]
pub fn search_commits(
    app: AppHandle,
    path: String,
    query: String,
    opts: Option<search::SearchOptions>,
    limit: usize,
    state: State<'_, AppState>,
) -> Result<search::SearchResults> {
    let opts = opts.unwrap_or_default();
    let repo = open(&path)?;
    let parsed = search::parse(&query)?;
    let summary = parsed.describe();
    if parsed.terms.is_empty() {
        return Ok(search::SearchResults { summary, ..Default::default() });
    }

    // Results are only valid for the ref set they were computed against: a
    // fetch or a branch move can rewrite the very commits a hit points at
    // (B3), and it also renumbers every row index below.
    let key = graph::refs_digest(&repo);
    let fingerprint = search_fingerprint(&query, &opts, limit);
    if let Ok(cache) = state.search_cache.lock() {
        if let Some(hit) = cached_search(&cache, &path, &key, &fingerprint) {
            return Ok(hit);
        }
    }

    let pids = &state.search_pids;
    let outcome = search::execute(
        &repo,
        &path,
        &parsed,
        &opts,
        limit,
        |pid| {
            if let Ok(mut active) = pids.lock() {
                active.insert(path.clone(), pid);
            }
        },
        |count| {
            let _ = app.emit("search-progress", SearchProgress { count, done: false });
        },
    );
    if let Ok(mut active) = pids.lock() {
        active.remove(&path);
    }
    let _ = app.emit("search-progress", SearchProgress { count: 0, done: true });
    let outcome = outcome?;

    // Turn oids into row indices, and order the hits the way the graph does —
    // hit navigation walks this list, so "next" has to mean "next row down".
    let mut cache = state
        .graph_cache
        .lock()
        .map_err(|_| Error::Msg("graph cache poisoned".into()))?;
    let cached = ensure_cached_rows(&repo, &mut cache, &path)?;
    let hits = place_hits(&cached.rows, &outcome.oids, opts.page_size);
    drop(cache);

    let results = search::SearchResults {
        hits,
        truncated: outcome.truncated,
        cancelled: outcome.cancelled,
        summary,
        notes: outcome.notes,
    };
    // A cancelled search is a partial answer; caching it would make the
    // partial list look authoritative on the next identical query.
    if !results.cancelled {
        if let Ok(mut cache) = state.search_cache.lock() {
            store_search(&mut cache, &path, key, fingerprint, &results);
        }
    }
    Ok(results)
}

/// Identify one query's results: the query text, the modifiers that change
/// what git is asked, and the cap that decided where the list stopped.
fn search_fingerprint(query: &str, opts: &search::SearchOptions, limit: usize) -> String {
    format!(
        "{query}\u{1}{}{}{}{}\u{1}{limit}",
        opts.match_case as u8,
        opts.match_all as u8,
        opts.match_regex as u8,
        opts.match_whole_word as u8
    )
}

/// Cached results for this query, or `None` if the ref set has moved since —
/// in which case every row index in them is stale too (B3).
fn cached_search(
    cache: &HashMap<String, CachedSearch>,
    path: &str,
    key: &str,
    fingerprint: &str,
) -> Option<search::SearchResults> {
    let cached = cache.get(path)?;
    if cached.key != key {
        return None;
    }
    cached.entries.get(fingerprint).cloned()
}

fn store_search(
    cache: &mut HashMap<String, CachedSearch>,
    path: &str,
    key: String,
    fingerprint: String,
    results: &search::SearchResults,
) {
    let entry = cache
        .entry(path.to_string())
        .or_insert_with(|| CachedSearch { key: key.clone(), entries: HashMap::new() });
    if entry.key != key {
        entry.key = key;
        entry.entries.clear();
    }
    entry.entries.insert(fingerprint, results.clone());
}

/// Order matching oids the way the graph orders its rows, and record which
/// page each one falls on.
///
/// Hit navigation steps through this list, so "next hit" has to mean "next row
/// down" — `git log`'s own order is close to that but not identical, because
/// the graph walks topologically. Oids the graph does not contain (a stash
/// commit, or one no ref reaches) still count as hits; they simply cannot be
/// scrolled to, and carry no index to say otherwise.
fn place_hits(
    rows: &[graph::GraphRow],
    oids: &[String],
    page_size: usize,
) -> Vec<search::SearchHit> {
    let matched: HashSet<&str> = oids.iter().map(String::as_str).collect();
    let mut hits: Vec<search::SearchHit> = Vec::with_capacity(oids.len());
    for (index, row) in rows.iter().enumerate() {
        if matched.contains(row.oid.as_str()) {
            hits.push(search::SearchHit {
                oid: row.oid.clone(),
                index: Some(index),
                page_hint: Some(index.checked_div(page_size).unwrap_or(0)),
            });
        }
    }
    let placed: HashSet<&str> = hits.iter().map(|hit| hit.oid.as_str()).collect();
    let unplaced: Vec<&String> = oids.iter().filter(|oid| !placed.contains(oid.as_str())).collect();
    for oid in unplaced {
        hits.push(search::SearchHit { oid: oid.clone(), index: None, page_hint: None });
    }
    hits
}

/// Kill an in-flight search. Partial results are kept (§4: a long search is
/// cancellable, not discardable).
#[tauri::command]
pub fn cancel_search(path: String, state: State<'_, AppState>) -> Result<()> {
    let pid = state
        .search_pids
        .lock()
        .map_err(|_| Error::Msg("search process lock poisoned".into()))?
        .get(&path)
        .copied()
        .ok_or_else(|| Error::Msg("no search is running".into()))?;
    #[cfg(unix)]
    let status = std::process::Command::new("kill").args(["-TERM", &pid.to_string()]).status()?;
    #[cfg(windows)]
    let status = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(Error::Msg("could not cancel the search".into()))
    }
}

// ---- M2: commit detail + diff ------------------------------------------------

#[tauri::command]
pub fn get_commit(path: String, oid: String) -> Result<diff::CommitDetail> {
    diff::commit_detail(&open(&path)?, &oid)
}

#[tauri::command]
pub fn get_commit_diff(
    path: String,
    oid: String,
    path_filter: Option<String>,
    ignore_whitespace: Option<bool>,
) -> Result<Vec<diff::FileDiff>> {
    diff::commit_diff(
        &open(&path)?,
        &oid,
        path_filter.as_deref(),
        ignore_whitespace.unwrap_or(false),
    )
}

#[tauri::command]
pub fn get_worktree_diff(
    path: String,
    staged: bool,
    path_filter: Option<String>,
    ignore_whitespace: Option<bool>,
) -> Result<Vec<diff::FileDiff>> {
    diff::worktree_diff(
        &open(&path)?,
        staged,
        path_filter.as_deref(),
        ignore_whitespace.unwrap_or(false),
    )
}

#[tauri::command]
pub fn compare_commits(
    path: String,
    old: String,
    new: String,
    ignore_whitespace: Option<bool>,
) -> Result<Vec<diff::FileDiff>> {
    diff::compare_commits(&open(&path)?, &old, &new, ignore_whitespace.unwrap_or(false))
}

// ---- M3: status, staging, commit ---------------------------------------------

#[tauri::command]
pub fn get_status(path: String) -> Result<status::StatusReport> {
    status::status(&open(&path)?)
}

#[tauri::command]
pub fn stage_paths(path: String, paths: Vec<String>, state: State<'_, AppState>) -> Result<()> {
    let _op = state.begin_op();
    status::stage_paths(&open(&path)?, &paths)
}

#[tauri::command]
pub fn unstage_paths(path: String, paths: Vec<String>, state: State<'_, AppState>) -> Result<()> {
    let _op = state.begin_op();
    status::unstage_paths(&open(&path)?, &paths)
}

#[tauri::command]
pub fn discard_paths(path: String, paths: Vec<String>, state: State<'_, AppState>) -> Result<()> {
    let _op = state.begin_op();
    status::discard_paths(&open(&path)?, &paths)
}

#[tauri::command]
pub fn ignore_path(path: String, file: String) -> Result<()> {
    status::ignore_path(&open(&path)?, &file)
}

#[tauri::command]
pub fn commit(path: String, message: String, amend: bool, state: State<'_, AppState>) -> Result<String> {
    let _op = state.begin_op();
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
pub fn create_branch(
    path: String,
    name: String,
    target: Option<String>,
    checkout: bool,
    state: State<'_, AppState>,
) -> Result<()> {
    let _op = state.begin_op();
    branch::create_branch(&open(&path)?, &name, target.as_deref(), checkout)
}

#[tauri::command]
pub fn delete_branch(path: String, name: String, force: bool, state: State<'_, AppState>) -> Result<()> {
    let _op = state.begin_op();
    branch::delete_branch(&open(&path)?, &name, force)
}

#[tauri::command]
pub fn rename_branch(path: String, old: String, new: String, state: State<'_, AppState>) -> Result<()> {
    let _op = state.begin_op();
    branch::rename_branch(&open(&path)?, &old, &new)
}

#[tauri::command]
pub fn checkout(path: String, refname: String, state: State<'_, AppState>) -> Result<()> {
    let _op = state.begin_op();
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
    let _op = state.begin_op();
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
    let _op = state.begin_op();
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
    let _op = state.begin_op();
    let before = snapshot(&path)?;
    ops::reset(&open(&path)?, &oid, mode)?;
    record_history(&state, &path, "Reset", before, RestoreMode::Hard)
}

#[tauri::command]
pub fn rebase_onto(path: String, onto: String, state: State<'_, AppState>) -> Result<ops::RebaseResult> {
    let _op = state.begin_op();
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
pub fn rebase_continue(path: String, state: State<'_, AppState>) -> Result<ops::RebaseResult> {
    let _op = state.begin_op();
    ops::rebase_continue(&open(&path)?)
}

#[tauri::command]
pub fn rebase_abort(path: String, state: State<'_, AppState>) -> Result<()> {
    let _op = state.begin_op();
    ops::rebase_abort(&open(&path)?)
}

/// Abort a pending merge / cherry-pick / revert, discarding the half-applied
/// changes and restoring HEAD.
#[tauri::command]
pub fn abort_operation(path: String, state: State<'_, AppState>) -> Result<()> {
    let _op = state.begin_op();
    ops::abort_pending(&open(&path)?)
}

#[tauri::command]
pub fn revert_commit(path: String, oid: String, state: State<'_, AppState>) -> Result<ops::ConflictResult> {
    let _op = state.begin_op();
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
pub fn create_tag(
    path: String,
    name: String,
    target: String,
    message: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    let _op = state.begin_op();
    refs::create_tag(&open(&path)?, &name, &target, message.as_deref())
}

#[tauri::command]
pub fn delete_tag(path: String, name: String, state: State<'_, AppState>) -> Result<()> {
    let _op = state.begin_op();
    refs::delete_tag(&open(&path)?, &name)
}

#[tauri::command]
pub fn get_remote_url(path: String, remote: String) -> Result<Option<String>> {
    Ok(refs::remote_url(&open(&path)?, &remote))
}

#[tauri::command]
pub fn list_remotes(path: String) -> Result<Vec<remote::RemoteInfo>> {
    remote::list(&open(&path)?)
}

#[tauri::command]
pub fn add_remote(path: String, name: String, url: String, state: State<'_, AppState>) -> Result<()> {
    let _op = state.begin_op();
    remote::add(&open(&path)?, &name, &url)
}

#[tauri::command]
pub fn remove_remote(path: String, name: String, state: State<'_, AppState>) -> Result<()> {
    let _op = state.begin_op();
    remote::remove(&open(&path)?, &name)
}

/// Rename a remote. Returns the refspecs git2 could not rewrite — empty for a
/// remote with the default refspec, which is nearly all of them.
#[tauri::command]
pub fn rename_remote(
    path: String,
    old: String,
    new: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>> {
    let _op = state.begin_op();
    remote::rename(&open(&path)?, &old, &new)
}

#[tauri::command]
pub fn set_remote_url(path: String, name: String, url: String, state: State<'_, AppState>) -> Result<()> {
    let _op = state.begin_op();
    remote::set_url(&open(&path)?, &name, &url)
}

/// Branch / remote / upstream facts the push flow needs (D5).
#[tauri::command]
pub fn push_target(path: String) -> Result<refs::PushTarget> {
    refs::push_target(&open(&path)?)
}

#[tauri::command]
pub fn list_worktrees(path: String) -> Result<Vec<worktree::WorktreeInfo>> {
    worktree::list(&open(&path)?)
}

/// One WIP row per dirty worktree, placed on its HEAD's lane (G18).
///
/// Separate from `get_graph` on purpose: this costs a `git status` per
/// worktree, and `get_graph` is called once per scroll page. It reuses the
/// same cached layout, so the lanes it reports are the lanes the graph drew.
#[tauri::command]
pub fn wip_rows(path: String, state: State<'_, AppState>) -> Result<Vec<graph::WipRow>> {
    let repo = open(&path)?;
    let worktrees = worktree::list(&repo)?;
    let mut cache = state
        .graph_cache
        .lock()
        .map_err(|_| Error::Msg("graph cache poisoned".into()))?;
    let cached = ensure_cached_rows(&repo, &mut cache, &path)?;
    Ok(graph::wip_rows(&worktrees, &cached.rows))
}

/// Resolve the refs / shas / ranges on one hovered terminal line (G19).
///
/// The frontend sends every plausible token on the line and gets back only
/// the ones this repository knows, so deciding what is a link stays on the
/// git side (invariant 5's principle) and prose stays prose.
#[tauri::command]
pub fn resolve_terminal_tokens(
    path: String,
    tokens: Vec<String>,
) -> Result<Vec<terminal_tokens::TerminalToken>> {
    terminal_tokens::resolve_many(&open(&path)?, &tokens)
}

#[tauri::command]
pub fn remove_worktree(
    path: String,
    name: String,
    force: bool,
    state: State<'_, AppState>,
) -> Result<()> {
    let _op = state.begin_op();
    worktree::remove(&open(&path)?, &name, force)
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
    state: State<'_, AppState>,
) -> Result<()> {
    let _op = state.begin_op();
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
pub fn stash_save(
    path: String,
    message: Option<String>,
    include_untracked: bool,
    state: State<'_, AppState>,
) -> Result<String> {
    let _op = state.begin_op();
    stash::save(&mut open(&path)?, message.as_deref(), include_untracked)
}

#[tauri::command]
pub fn stash_list(path: String) -> Result<Vec<stash::StashEntry>> {
    stash::list(&mut open(&path)?)
}

#[tauri::command]
pub fn stash_apply(path: String, index: usize, state: State<'_, AppState>) -> Result<()> {
    let _op = state.begin_op();
    stash::apply(&mut open(&path)?, index)
}

#[tauri::command]
pub fn stash_pop(path: String, index: usize, state: State<'_, AppState>) -> Result<()> {
    let _op = state.begin_op();
    stash::pop(&mut open(&path)?, index)
}

#[tauri::command]
pub fn stash_drop(path: String, index: usize, state: State<'_, AppState>) -> Result<()> {
    let _op = state.begin_op();
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
    let _op = state.begin_op();
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
    let debouncer = watcher::watch(app, &path, &workdir, std::sync::Arc::clone(&state.ops))
        .map_err(|e| Error::Msg(e.to_string()))?;
    watchers.insert(path, debouncer);
    Ok(())
}

// ---- M5: terminal ------------------------------------------------------------

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    cwd: String,
    rows: u16,
    cols: u16,
    shell: Option<String>,
    state: State<'_, AppState>,
) -> Result<String> {
    state.pty.spawn(app, &cwd, rows, cols, shell.as_deref())
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

// ---- P6: settings and git identity ------------------------------------------

/// Where `settings.json` lives. Resolved from the app handle rather than
/// hardcoded so it lands in the platform's own config location.
fn config_dir(app: &AppHandle) -> Result<std::path::PathBuf> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .map_err(|e| Error::Msg(format!("no config directory: {e}")))
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Result<settings::Settings> {
    Ok(settings::load(&config_dir(&app)?))
}

/// Persist settings and hand back what was actually stored — the clamped
/// values, so the UI shows what it will get rather than what it asked for.
///
/// No op guard (invariant 2): this writes no file the repository watcher is
/// watching.
#[tauri::command]
pub fn save_settings(app: AppHandle, settings: settings::Settings) -> Result<settings::Settings> {
    settings::save(&config_dir(&app)?, &settings)
}

/// The git identity, at both levels. `path` is optional: the settings screen
/// shows the global identity with no repository open.
#[tauri::command]
pub fn get_identity(path: Option<String>) -> Result<identity::IdentityInfo> {
    match path {
        Some(path) => identity::read(Some(&open(&path)?)),
        None => identity::read(None),
    }
}

#[tauri::command]
pub fn set_identity(
    scope: identity::IdentityScope,
    path: Option<String>,
    name: String,
    email: String,
) -> Result<identity::IdentityInfo> {
    let repo = match path {
        Some(ref path) => Some(open(path)?),
        None => None,
    };
    identity::write(scope, repo.as_ref(), &name, &email)?;
    identity::read(repo.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestRepo;

    /// D1: the layout cache was keyed on HEAD alone, so anything that changed
    /// the ref set without moving HEAD — a fetch, a branch create, a tag —
    /// kept serving stale rows and stale ref badges.
    #[test]
    fn graph_cache_rebuilds_when_a_branch_moves() {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        let path = t.dir.path().to_str().unwrap().to_string();
        let mut cache: HashMap<String, CachedGraph> = HashMap::new();

        let first = graph_page(&t.repo, &mut cache, &path, 0, 100).unwrap();
        assert_eq!(first.total, 1);

        // Poison the cached row. A second call that returns the poison proves
        // the cache was hit rather than silently rebuilt, which is what makes
        // the assertions below meaningful.
        cache.get_mut(&path).unwrap().rows[0].summary = "STALE".into();
        let cached = graph_page(&t.repo, &mut cache, &path, 0, 100).unwrap();
        assert_eq!(cached.rows[0].summary, "STALE", "unchanged refs must hit the cache");

        // Move a branch without touching HEAD (TestRepo commits with `None` as
        // the update ref, so HEAD stays put — exactly the missed case).
        let b = t.commit("b", &[a]);
        t.repo.branch("topic", &t.repo.find_commit(b).unwrap(), true).unwrap();

        let rebuilt = graph_page(&t.repo, &mut cache, &path, 0, 100).unwrap();
        assert_eq!(rebuilt.total, 2, "the new commit must appear");
        assert!(
            rebuilt.rows.iter().all(|r| r.summary != "STALE"),
            "moving a branch must invalidate the cache",
        );
        assert!(
            rebuilt.rows.iter().any(|r| r.refs.iter().any(|b| b.name == "topic")),
            "ref badges must be rebuilt too",
        );
    }

    #[test]
    fn graph_page_honours_skip_and_limit() {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        let b = t.commit("b", &[a]);
        t.commit("c", &[b]);
        let path = t.dir.path().to_str().unwrap().to_string();
        let mut cache: HashMap<String, CachedGraph> = HashMap::new();

        let page = graph_page(&t.repo, &mut cache, &path, 0, 2).unwrap();
        assert_eq!(page.total, 3);
        assert_eq!(page.rows.len(), 2);

        let tail = graph_page(&t.repo, &mut cache, &path, 2, 2).unwrap();
        assert_eq!(tail.rows.len(), 1, "last page is short, not wrapped");
        assert_eq!(tail.total, 3);

        let past_end = graph_page(&t.repo, &mut cache, &path, 99, 2).unwrap();
        assert!(past_end.rows.is_empty());
    }

    /// B2: a hit is a sha plus the page it lives on. The order is the graph's,
    /// not `git log`'s, because hit navigation means "next row down".
    #[test]
    fn search_hits_are_ordered_by_row_with_a_page_hint_each() {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        let b = t.commit("b", &[a]);
        let c = t.commit("c", &[b]);
        let path = t.dir.path().to_str().unwrap().to_string();
        let mut cache: HashMap<String, CachedGraph> = HashMap::new();
        let rows = graph_page(&t.repo, &mut cache, &path, 0, 100).unwrap().rows;

        // Hand them over oldest-first; they must come back newest-first, the
        // order the rows are in.
        let hits = place_hits(&rows, &[a.to_string(), c.to_string()], 2);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].oid, c.to_string(), "row 0 first: {hits:?}");
        assert_eq!(hits[0].index, Some(0));
        assert_eq!(hits[0].page_hint, Some(0));
        assert_eq!(hits[1].oid, a.to_string());
        assert_eq!(hits[1].index, Some(2));
        assert_eq!(hits[1].page_hint, Some(1), "row 2 with 2-row pages is page 1");
        assert!(!hits.iter().any(|h| h.oid == b.to_string()));

        // A commit the graph does not hold (a stash) still counts, with no
        // index — silently dropping it would under-report the hit count.
        let orphan = "0".repeat(40);
        let hits = place_hits(&rows, std::slice::from_ref(&orphan), 2);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].index, None);
        assert_eq!(hits[0].page_hint, None);
    }

    /// B3: results are only true of the ref set they were computed against.
    /// A branch move rewrites row indices even when it rewrites no commit, so
    /// the search cache has to fall with the graph cache, not outlive it.
    #[test]
    fn search_cache_is_invalidated_by_a_branch_move() {
        let t = TestRepo::new();
        let a = t.commit("a", &[]);
        let path = t.dir.path().to_str().unwrap().to_string();
        let opts = search::SearchOptions::default();
        let fingerprint = search_fingerprint("fix", &opts, 0);
        let mut cache: HashMap<String, CachedSearch> = HashMap::new();

        let key = graph::refs_digest(&t.repo);
        let results = search::SearchResults {
            hits: vec![search::SearchHit { oid: a.to_string(), index: Some(0), page_hint: Some(0) }],
            summary: "matching fix".into(),
            ..Default::default()
        };
        store_search(&mut cache, &path, key.clone(), fingerprint.clone(), &results);
        assert!(
            cached_search(&cache, &path, &key, &fingerprint).is_some(),
            "the same ref set must hit the cache, or every keystroke re-walks history",
        );

        // Move a branch without touching HEAD — D1's exact shape.
        let b = t.commit("b", &[a]);
        t.repo.branch("topic", &t.repo.find_commit(b).unwrap(), true).unwrap();
        let moved = graph::refs_digest(&t.repo);
        assert_ne!(key, moved);
        assert!(
            cached_search(&cache, &path, &moved, &fingerprint).is_none(),
            "stale hits must not survive a ref move",
        );

        // Storing under the new digest evicts the old entries rather than
        // letting the map grow a generation per fetch.
        store_search(&mut cache, &path, moved.clone(), fingerprint.clone(), &results);
        assert_eq!(cache.get(&path).unwrap().entries.len(), 1);
    }

    /// The modifiers change what git is asked, so they have to change the
    /// cache key — otherwise turning on `regex` returns the fixed-string hits.
    #[test]
    fn every_search_modifier_changes_the_cache_key() {
        let base = search::SearchOptions::default();
        let key = search_fingerprint("a.b", &base, 0);
        let variants = [
            search::SearchOptions { match_case: true, ..base.clone() },
            search::SearchOptions { match_all: true, ..base.clone() },
            search::SearchOptions { match_regex: true, ..base.clone() },
            search::SearchOptions { match_whole_word: true, ..base.clone() },
        ];
        for opts in &variants {
            assert_ne!(key, search_fingerprint("a.b", opts, 0), "{opts:?}");
        }
        assert_ne!(key, search_fingerprint("a.b", &base, 100), "the cap is part of the answer");
        assert_ne!(key, search_fingerprint("a.c", &base, 0));
    }
}
