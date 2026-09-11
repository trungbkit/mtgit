# Feature: Cherry-pick (GitKraken-style)

> Read `00-overview.md` first for shared concepts, especially §5 Conflict Handling.

## 1. Summary

Apply one or more commits from anywhere in the graph onto the checked-out branch, via context menu or drag-and-drop, with the shared conflict flow.

## 2. Entry Points

- Commit context menu → **Cherry-pick commit**.
- Multi-select (Ctrl/Cmd- or Shift-click) N commits → context menu → **Cherry-pick N commits** (applied oldest → newest regardless of selection order).
- Drag a commit row onto the checked-out branch pill → drop menu → **Cherry-pick commit here**.
- Left panel: dragging is not available; context menu only.
- Search (`08-search-and-filter.md`) is the practical entry point for the common case — "pick the commit that fixed this" is a `change:` or `message:` query, and `select` result mode hands the whole matching set to a multi-commit pick. Cherry-pick is the operation that most needs search to exist, which is why the two are specified together.

## 3. UI Requirements

- Before executing, a lightweight confirm popover (not a full dialog): "Cherry-pick \<shortsha\> onto \<current branch\>?" with a **Commit immediately** checkbox (default on). Unchecked = `--no-commit`: changes land staged in WIP for the user to commit manually.
- Progress for multi-commit picks: "Cherry-picking 3 of 7…" in the status bar (overview §4). Note the cost: `git cherry-pick a b c` is one invocation with no per-commit output, so reporting position means driving the sequence one commit at a time from the backend. Do that only if the sequencer state (`i of n` on the banner, Skip, Abort-rolls-back-everything) is preserved exactly; a progress counter is not worth trading those for.
- Success: new commit(s) appear at the branch tip; toast "Cherry-picked N commits onto \<branch\>"; the source commits get a subtle "picked" flash highlight so the user sees the correspondence.

## 4. Behavior

| # | Rule |
|---|---|
| B1 | Single pick = `git cherry-pick <sha>`; keeps original author, new committer, appends nothing to the message (no `-x`) by default; a settings flag enables `-x` ("(cherry picked from commit …)" line). |
| B2 | Multi-pick executes as a sequence oldest→newest; on conflict, the sequence pauses (git cherry-pick sequencer) with banner "Cherry-pick in progress — stopped at \<shortsha\> (i of n)" and **Continue / Skip / Abort**; Abort cancels the remaining sequence and resets to the pre-pick tip (already-applied picks are rolled back). |
| B3 | Picking a merge commit: context menu item is enabled but opens a parent-selection popover ("Mainline: parent 1 (\<branch-ish\>) / parent 2 (…)") → `-m <n>`. |
| B4 | Dirty working tree: allowed when git allows. When git refuses, fall back to stash-and-restore — but note `git cherry-pick` has no `--autostash`, so unlike pull B3 this must be an explicit `stash push` / `stash pop` pair around the pick, with the pick's failure path popping the stash back before it reports. |
| B5 | Empty result (change already present) → git stops; auto-resolve by skipping with a note in the toast ("1 commit skipped — already applied"). |
| B6 | `--no-commit` mode with multiple commits applies all into the index (single combined WIP), matching git behavior. |
| B7 | Undo after completed pick(s) resets the branch tip to pre-pick (reflog), restoring exactly. |

## 5. Edge Cases

- Cherry-picking onto a branch where HEAD is the same patch → skipped-as-applied (B5).
- Cherry-pick while another operation is in progress → blocked with toast linking to the active banner.
- Picking commits that touch files deleted on the current branch → normal conflict flow with delete/modify file-level resolution (see merge doc §5).
- Detached HEAD target: allowed; detached banner rules from checkout doc apply.
- Multiple worktrees: the pick applies to the active worktree's HEAD (`02-checkout.md` B9). Picking "onto another branch" that a second worktree has checked out is a composite action — open that worktree, then pick — and the menu item says so rather than failing on git's refusal.

## 6. Acceptance Criteria

> Status audited 2026-09-08 — see `STATUS.md`.

- [x] Single and multi cherry-pick work from context menu and DnD; multi applies oldest→newest. — dropping on a non-checked-out pill toasts a pointer instead of offering the pick
- [x] Confirm popover with "Commit immediately" toggle; `--no-commit` leaves staged changes in WIP.
- [x] Sequence conflict flow: banner with position, Continue/Skip/Abort; Abort rolls back all applied picks of the sequence.
- [x] Merge-commit pick requires and applies mainline parent selection. — radio list of parents → `-m <n>`
- [x] Already-applied commits are skipped with notice. — `cherry-pick --skip` + "already applied" in the toast
- [x] Undo restores the pre-pick tip.
- [x] A pick attempted while another operation is paused is refused with a pointer to the banner (§5).
- [ ] Dirty-tree stash fallback (B4) — a refused pick surfaces git's error instead.
- [x] `-x` settings flag (B1) — Settings → General → Commits; `CherryPickPopover` passes `settings().cherryPickAppendOrigin` at the call site that used to be hardcoded `false` (P6).
- [ ] Per-commit sequence progress and the "picked" flash on source commits (§3).

**New in this revision (GitLens-derived):**

- [x] A `select`-mode search result feeds a multi-commit pick directly (§2). — the row menu picks the whole multi-selection oldest-first, and select mode is what puts every hit into it.
- [x] Conflicts during a sequence use the unified conflict panel (`05-merge.md` §5). — the panel names the picked commit as the incoming side rather than "theirs".
- [ ] Picking onto a branch held by another worktree is offered as a composite action, not a git error (§5).
