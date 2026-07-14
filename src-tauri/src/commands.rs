use crate::core::{branch, commit as commit_mod, diff, graph, ops, refs, repo, stash, status};
use crate::error::{Error, Result};
use crate::state::{AppState, CachedGraph};
use crate::{shellout, watcher};
use git2::Repository;
use tauri::{AppHandle, State};

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

    let mut cache = state.graph_cache.lock().map_err(|_| Error::Msg("graph cache poisoned".into()))?;
    let needs_rebuild = match cache.get(&path) {
        Some(c) => c.head != head,
        None => true,
    };
    if needs_rebuild {
        let layouts = graph::layout(&repo)?;
        let badges = refs::badges_by_oid(&repo);
        let rows = graph::build_rows(&repo, &layouts, &badges)?;
        cache.insert(path.clone(), CachedGraph { head: head.clone(), rows });
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
pub fn commit(path: String, message: String, amend: bool) -> Result<String> {
    commit_mod::commit(&open(&path)?, &message, amend)
}

// ---- M4: branches, merge, stash, remotes -------------------------------------

#[tauri::command]
pub fn create_branch(path: String, name: String, target: Option<String>, checkout: bool) -> Result<()> {
    branch::create_branch(&open(&path)?, &name, target.as_deref(), checkout)
}

#[tauri::command]
pub fn delete_branch(path: String, name: String) -> Result<()> {
    branch::delete_branch(&open(&path)?, &name)
}

#[tauri::command]
pub fn rename_branch(path: String, old: String, new: String) -> Result<()> {
    branch::rename_branch(&open(&path)?, &old, &new)
}

#[tauri::command]
pub fn checkout(path: String, refname: String) -> Result<()> {
    branch::checkout_ref(&open(&path)?, &refname)
}

#[tauri::command]
pub fn merge_ref(path: String, their_ref: String, mode: branch::MergeMode) -> Result<branch::MergeResult> {
    branch::merge(&open(&path)?, &their_ref, mode)
}

#[tauri::command]
pub fn cherry_pick(path: String, oid: String) -> Result<ops::ConflictResult> {
    ops::cherry_pick(&open(&path)?, &oid)
}

#[tauri::command]
pub fn reset_to(path: String, oid: String, mode: ops::ResetMode) -> Result<()> {
    ops::reset(&open(&path)?, &oid, mode)
}

#[tauri::command]
pub fn rebase_onto(path: String, onto: String) -> Result<ops::RebaseResult> {
    ops::rebase(&open(&path)?, &onto)
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
) -> Result<shellout::GitOpResult> {
    shellout::run(&app, &path, &op, remote.as_deref(), &extra.unwrap_or_default())
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
