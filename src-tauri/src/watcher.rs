//! Filesystem watcher. A debounced `notify` watcher on the repo emits a single
//! `repo-changed` event to the frontend, which invalidates its TanStack Query
//! caches. This event loop is what makes the app feel live.

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use std::path::Path;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub type RepoDebouncer = Debouncer<RecommendedWatcher, RecommendedCache>;

/// Start watching `workdir` (recursively, so `.git` is covered too). Returns the
/// debouncer, which must be kept alive — dropping it stops the watch.
pub fn watch(app: AppHandle, repo_path: &str, workdir: &Path) -> notify::Result<RepoDebouncer> {
    let emit_path = repo_path.to_string();
    let mut debouncer = new_debouncer(
        Duration::from_millis(300),
        None,
        move |result: DebounceEventResult| {
            if let Ok(events) = result {
                let relevant = events
                    .iter()
                    .flat_map(|e| e.paths.iter())
                    .any(|p| is_relevant(p));
                if relevant {
                    let _ = app.emit("repo-changed", &emit_path);
                }
            }
        },
    )?;
    debouncer.watch(workdir, RecursiveMode::Recursive)?;
    Ok(debouncer)
}

/// Ignore object churn and lockfiles (a checkout writes thousands of objects);
/// everything else — refs, HEAD, index, the working tree — is worth a refresh.
fn is_relevant(p: &Path) -> bool {
    let s = p.to_string_lossy();
    let s = s.replace('\\', "/");
    if s.contains("/.git/objects/") {
        return false;
    }
    if s.ends_with(".lock") {
        return false;
    }
    true
}
