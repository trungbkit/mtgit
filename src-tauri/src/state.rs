use crate::core::graph::GraphRow;
use crate::pty::PtyManager;
use crate::watcher::RepoDebouncer;
use std::collections::HashMap;
use std::sync::Mutex;

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
}
