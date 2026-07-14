# MTGit — Verify & Harden Plan

The nine target features (graph, cherry-pick, merge, rebase, reset, checkout, create
branch, delete branch, fetch) are already implemented end-to-end and compile clean
(`tsc` ✓, `cargo check` ✓). This plan does **not** rebuild them. It (1) proves each
flow works against a repo with known topology, and (2) fixes the rough edges found —
prioritized by how likely they are to bite a real user.

---

## Phase 0 — Build & smoke (½ day)

1. **Backend unit tests** — the correctness core already has tests:
   ```
   cd src-tauri && cargo test
   ```
   Expect green: `reset_soft_moves_branch_only`, `cherry_pick_applies_commit_onto_head`,
   `revert_creates_inverse_commit`, `create_and_delete_branch`, `fast_forward_merge`.
2. **Launch the app**: `pnpm tauri:dev`. Confirm window opens, no console errors.
3. **Open a repo** via the toolbar → repo name + HEAD branch show; graph renders.
4. Confirm `git_available()` is true (fetch depends on system git).

**Exit:** app runs, opens a repo, tests pass.

---

## Phase 1 — Build a fixture repo (½ day)

Every operation needs a *predictable target*. Script a throwaway repo so results are
verifiable, not accidental. Save as `scripts/make-fixture.sh`:

```
topology to create:
  main:    A─B─C─────M   (M = merge of feature)
                \   /
  feature:       D─E
  release:  B─F         (diverged, for rebase/cherry-pick targets)
  origin/*  a bare clone set as 'origin' so fetch/ahead-behind have meaning
```

- Distinct files per branch so merges/cherry-picks apply cleanly, plus **one shared
  file with divergent edits** to force a conflict on demand.
- Add a bare `origin` remote (local path is fine) and push, then add one commit to
  `origin/main` directly so `fetch` produces a visible behind-count.

**Exit:** one command rebuilds a repo exercising clean *and* conflicting paths.

---

## Phase 2 — Verify the nine flows

For each: **do it in the UI → assert with `git log`/`git status` in the terminal panel.**
"Watch for" lists the concrete risk I saw in the code.

| # | Flow | UI path | Assert | Watch for |
|---|------|---------|--------|-----------|
| 1 | **Graph** | opens on repo load | lanes/edges/badges match `git log --graph`; HEAD badge correct | `getGraph` loads **all** commits (`limit 1_000_000`) in one query — test on a 20k+ repo for lag; cache keyed on HEAD oid only |
| 2 | **Cherry-pick** | graph row → "Cherry pick commit" | new commit on HEAD, original author preserved | conflict path leaves repo in cherry-pick state with **no in-app abort** |
| 3 | **Merge** | sidebar branch menu (ff/no-ff/ff-only) + drag branch→branch | correct commit shape per mode | drag-merge auto-checks-out target; ff uses `force` checkout — can it clobber dirty tree?; conflicts leave `MERGE_HEAD`, no abort |
| 4 | **Rebase** | graph "Rebase onto" / sidebar | branch replayed, `applied` count right | **aborts on first conflict — cannot complete a conflicting rebase in-app**; no continue/interactive |
| 5 | **Reset** | graph submenu soft/mixed/hard | HEAD moves; index/worktree state per mode | hard-reset confirm fires; verify on detached HEAD |
| 6 | **Checkout** | dbl-click branch / menu / toolbar | HEAD switches | dirty tree → safe checkout errors; **remote branch → detached HEAD** (no tracking branch created) |
| 7 | **Create branch** | `+` / graph / toolbar | branch at expected target, optional checkout | `prompt()` allows invalid names (spaces/`~^:`) → raw git2 error |
| 8 | **Delete branch** | sidebar menu | branch gone; HEAD blocked | **no unmerged-branch warning** (deletes unconditionally); remote branch delete unsupported |
| 9 | **Fetch** | toolbar ⟳ / pull caret | ahead/behind counts update | progress events emitted but **not shown**; auth failure surfaces only last stderr line |

**Cross-cutting checks**
- After each op the fs watcher → `invalidateQueries` refreshes graph/status/refs
  (query keys are `["graph"|"status"|"refs", path]`, predicate matches `queryKey[1]`).
  Confirm no stale UI and no refresh storm on big checkouts.
- Errors route through `toastError`; confirm messages are legible, not raw debug.

**Exit:** a checked table — every flow either ✓ or a filed issue.

---

## Phase 3 — Hardening backlog (prioritized)

Ordered by user impact. Each is small and localized given the backend already exists.

### P0 — correctness / dead-ends
1. ✅ **Conflict escape hatch.** Added `abort_operation` (merge/cherry-pick/revert →
   hard-reset + `cleanup_state`) and `rebase_abort`. Surfaced via a persistent
   `ConflictBanner` with Abort. *Files:* `core/ops.rs` (`abort_pending`, `rebase_abort`),
   `commands.rs`, `stores/conflict.ts`, `components/ConflictBanner.tsx`.
   *Tests:* `abort_pending_clears_cherry_pick_conflict`, `rebase_abort_restores_topic`.
2. ✅ **Continue-able rebase.** `ops::rebase` now stops on conflict leaving the rebase
   in progress (was `abort()`); `rebase_continue` resumes after staging. Banner shows a
   "Continue" button. *File:* `core/ops.rs`. *Test:* `rebase_stops_on_conflict_then_continues`.
3. ✅ **Checkout of a remote branch** creates a local tracking branch instead of
   detaching HEAD. *File:* `branch::checkout_ref`. *Test:* `checkout_remote_branch_creates_local_tracking`.

### P1 — safety & feedback
4. ✅ **Live network progress.** Already implemented — `StatusBar` listens to the
   `git-progress` events `shellout.rs` emits and shows the current transfer line.
5. ✅ **Unmerged-branch guard on delete** — `delete_branch(force)` refuses to delete a
   not-fully-merged branch; UI offers an explicit force-confirm. *File:* `branch.rs`.
   *Test:* `delete_unmerged_branch_requires_force`.
6. ✅ **Replaced `prompt()`/`confirm()`** everywhere with a promise-based modal
   (`stores/dialog.ts` + `components/DialogHost.tsx`) that validates ref names
   (`lib/refname.ts`). Updated Graph, Sidebar, Toolbar, CommandPalette, StagingView.

### P2 — parity polish
7. ⬜ **Undo via reflog** — toolbar Undo/Redo still hardcoded `disabled`. (Large; not done.)
8. ⬜ **Interactive rebase** (reorder/squash/edit/drop) — still missing. (Large; not done.)
9. ✅ **Fetch --prune** (Pull caret + Actions menu) and **delete remote branch**
   (`deleteRemoteBranch` via `git push --delete`, sidebar remote-branch menu).

**Status:** P0 cleared (no dead-ends), P1 cleared (safe + legible), P2 partial
(#9 done; #7/#8 remain as tracked backlog). Backend: **25 tests pass** (5 new).
Frontend: `tsc` clean, `vite build` clean.

---

## Effort

| Phase | Duration |
|---|---|
| 0 Build & smoke | ½ day |
| 1 Fixture | ½ day |
| 2 Verify 9 flows | 1 day |
| 3a P0 fixes | 2 days |
| 3b P1 fixes | 2 days |
| 3c P2 backlog | as scheduled |
| **To a hardened, verified state (P0+P1)** | **~1 week** |
