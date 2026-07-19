use crate::core::graph::GraphRow;
use crate::pty::PtyManager;
use crate::watcher::RepoDebouncer;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Clone)]
pub struct RepoSnapshot {
    pub oid: String,
    pub head_ref: Option<String>,
}

#[derive(Clone, Copy)]
pub enum RestoreMode {
    Hard,
    Soft,
    Merge,
    Checkout,
}

#[derive(Clone)]
pub struct HistoryEntry {
    pub label: String,
    pub before: RepoSnapshot,
    pub after: RepoSnapshot,
    pub mode: RestoreMode,
    pub draft: Option<String>,
}

#[derive(Default)]
pub struct HistoryStacks {
    pub undo: Vec<HistoryEntry>,
    pub redo: Vec<HistoryEntry>,
}

/// A computed full-graph layout, cached so pagination doesn't re-walk history
/// on every scroll. Invalidated when HEAD (tracked via `head`) changes — the
/// frontend passes the head oid as a cache key.
pub struct CachedGraph {
    pub head: Option<String>,
    pub rows: Vec<GraphRow>,
}

#[derive(Default)]
pub struct AppState {
    /// repo path -> cached layout
    pub graph_cache: Mutex<HashMap<String, CachedGraph>>,
    /// repo path -> live fs watcher (kept alive so it keeps watching)
    pub watchers: Mutex<HashMap<String, RepoDebouncer>>,
    /// terminal sessions
    pub pty: PtyManager,
    /// Local operation history used by the first-class Undo / Redo controls.
    pub history: Mutex<HashMap<String, HistoryStacks>>,
    /// Pre-operation snapshots retained while Git's sequencer is paused.
    pub pending_history: Mutex<HashMap<String, (String, RepoSnapshot, RestoreMode)>>,
    /// Active network-process PID by repository, used by progress Cancel.
    pub network_pids: Mutex<HashMap<String, u32>>,
}
