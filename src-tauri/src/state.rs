use crate::core::graph::GraphRow;
use crate::pty::PtyManager;
use crate::watcher::RepoDebouncer;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

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
/// on every scroll. Keyed on a digest of the repository's whole ref set plus
/// HEAD (`graph::refs_digest`) — keying on HEAD alone served stale rows after a
/// fetch, a branch create, or a tag, none of which move HEAD.
pub struct CachedGraph {
    pub key: String,
    pub rows: Vec<GraphRow>,
}

/// How long after one of our own operations finishes the fs watcher stays
/// quiet. Must comfortably exceed the watcher's 300ms debounce so the final
/// batch of writes an operation produced is still swallowed.
const QUIET_MS: u64 = 600;

/// Watcher self-op suppression.
///
/// A checkout of a large branch rewrites thousands of working-tree files, and
/// every one of them wakes the debounced watcher — which then tells the
/// frontend to refetch everything, repeatedly, while the operation is still
/// running. Mutating commands hold an [`OpGuard`] for their duration; the
/// watcher drops events while a guard is live and for [`QUIET_MS`] afterwards.
///
/// Dropping those events is safe because the command that caused them returns
/// to the frontend, which invalidates its own queries — the refresh happens
/// once, on completion, instead of N times mid-flight.
#[derive(Default)]
pub struct OpSuppressor {
    in_flight: AtomicUsize,
    /// Unix millis until which events stay suppressed after the last guard.
    quiet_until_ms: AtomicU64,
}

impl OpSuppressor {
    /// Mark the start of one of our own mutating operations. The returned
    /// guard re-arms the quiet window when it drops.
    pub fn begin(self: &Arc<Self>) -> OpGuard {
        self.in_flight.fetch_add(1, Ordering::SeqCst);
        OpGuard(Arc::clone(self))
    }

    /// True while a mutating command is running, or within the quiet window
    /// that follows one.
    pub fn is_suppressed(&self) -> bool {
        self.in_flight.load(Ordering::SeqCst) > 0
            || now_ms() < self.quiet_until_ms.load(Ordering::SeqCst)
    }
}

pub struct OpGuard(Arc<OpSuppressor>);

impl Drop for OpGuard {
    fn drop(&mut self) {
        // Arm the quiet window *before* dropping the in-flight count, so there
        // is no instant in which neither condition holds.
        self.0.quiet_until_ms.store(now_ms() + QUIET_MS, Ordering::SeqCst);
        self.0.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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
    /// suppresses watcher events caused by our own operations
    pub ops: Arc<OpSuppressor>,
}

impl AppState {
    /// Hold for the duration of a mutating git operation (see [`OpSuppressor`]).
    pub fn begin_op(&self) -> OpGuard {
        self.ops.begin()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;
    use std::time::Duration;

    #[test]
    fn suppressor_is_quiet_during_and_shortly_after_an_op() {
        let s = Arc::new(OpSuppressor::default());
        assert!(!s.is_suppressed(), "idle suppressor must let events through");

        let guard = s.begin();
        assert!(s.is_suppressed(), "suppressed while an op is in flight");
        drop(guard);
        assert!(s.is_suppressed(), "still suppressed inside the quiet window");

        sleep(Duration::from_millis(QUIET_MS + 150));
        assert!(!s.is_suppressed(), "quiet window must expire");
    }

    #[test]
    fn nested_ops_keep_suppression_until_the_last_one_ends() {
        let s = Arc::new(OpSuppressor::default());
        let outer = s.begin();
        let inner = s.begin();
        drop(inner);
        assert!(s.is_suppressed());
        drop(outer);
        assert!(s.is_suppressed());
    }
}
