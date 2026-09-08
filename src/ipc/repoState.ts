import type { QueryClient } from "@tanstack/react-query";
import { operationInfo } from "./commands";
import {
  conflictLabel,
  revealConflictBanner,
  useConflict,
  type ConflictKind,
} from "../stores/conflict";

/**
 * Re-read the repository's in-progress operation straight from git and push it
 * into the conflict store.
 *
 * `docs/feature-requirements/00-overview.md` §5.1: this state is *discovered*,
 * never remembered. An operation's own return value cannot be the only source —
 * `gitNetwork` resolves with a `GitOpResult` carrying no conflict list, so a
 * conflicting pull reported nothing at all, and a conflict the user created in
 * the terminal panel, or one that survived a restart, has no return value to
 * report in the first place. `operation_info` reads git's own record
 * (`MERGE_HEAD`, `rebase-merge/`, `CHERRY_PICK_HEAD`, the index's stage 1/2/3
 * entries) and owns the `i of n` counter via its sequence meta, so callers must
 * not compute either one themselves.
 */
export async function syncOperation(path: string): Promise<void> {
  try {
    const info = await operationInfo(path);
    const conflict = useConflict.getState();
    // `kind: "operation"` is the backend's "in some state I don't model" — not
    // something the banner can describe, so it is treated as no operation.
    if (info && info.kind !== "operation") {
      conflict.set({
        repoPath: path,
        kind: info.kind as ConflictKind,
        files: info.conflicts,
        currentSha: info.currentSha,
        current: info.current,
        total: info.total,
        canSkip: info.canSkip,
      });
    } else if (conflict.active?.repoPath === path) {
      conflict.clear();
    }
  } catch {
    /* operation discovery is best-effort */
  }
}

/**
 * Refuse a mutating action while a merge / rebase / cherry-pick / revert is
 * paused, and point the user at the banner (`00-overview.md` §5.3).
 *
 * Refusing here rather than letting git refuse is the entire point: git's own
 * message is correct but never says where the Abort button is. The list §5.3
 * names — checkout, pull, merge, rebase, cherry-pick, reset — is the list of
 * callers; staging, commit and the banner's own continue/skip/abort must stay
 * open, because they are how the user gets *out* of the paused state.
 *
 * This throws instead of returning a verdict. Every mutating call site in
 * `src/` already funnels failures into `toastError`, so a throw reports itself
 * exactly once and, in a composite flow (check out the target, *then* merge),
 * stops the rest of the sequence for free.
 *
 * The state is re-read from git before the check (§5.1). The banner is only as
 * fresh as the last refresh, and a stale "no operation" would pass the action
 * through to the raw git error this gate exists to replace. `syncOperation`
 * swallows its own errors, so a repo we cannot interrogate fails *open* — a
 * gate that has lost its footing must not become a wall.
 */
export async function requireNoPausedOperation(path: string, action: string): Promise<void> {
  await syncOperation(path);
  const active = useConflict.getState().active;
  if (!active || active.repoPath !== path) return;
  revealConflictBanner();
  throw new Error(
    `Cannot ${action} while a ${conflictLabel(active.kind).toLowerCase()} is in progress — ` +
      "finish it with Continue, or Abort, in the banner above the graph.",
  );
}

/**
 * What every mutating path does when it finishes: invalidate this repo's
 * queries *and* re-read its operation state.
 *
 * The two halves have to stay welded together, which is the only reason this
 * function exists. Invalidation alone was `refresh()`, hand-copied into six
 * components, and it is why a conflicting pull used to leave the user in a
 * conflicted tree with no banner, no Abort and no Continue: the fs watcher
 * would have caught it, but mutating commands hold an op guard (`CLAUDE.md`
 * invariant 2), so the watcher's 300 ms debounce fires inside the 600 ms quiet
 * window and the event is dropped. Nothing else was going to tell the UI.
 *
 * The returned promise resolves once the operation state has been re-read.
 * Awaiting it is optional — the store update re-renders either way — but a
 * caller that navigates or closes a dialog on completion should await it so the
 * banner is up before the view changes underneath it.
 */
export function refreshRepo(qc: QueryClient, path: string): Promise<void> {
  // queryKey[1] is the repo path by convention (`CLAUDE.md` invariant 3).
  qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === path });
  return syncOperation(path);
}
