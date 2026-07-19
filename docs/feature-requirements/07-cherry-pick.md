# Feature: Cherry-pick (GitKraken-style)

> Read `00-overview.md` first for shared concepts, especially §5 Conflict Handling.

## 1. Summary

Apply one or more commits from anywhere in the graph onto the checked-out branch, via context menu or drag-and-drop, with the shared conflict flow.

## 2. Entry Points

- Commit context menu → **Cherry-pick commit**.
- Multi-select (Ctrl/Cmd- or Shift-click) N commits → context menu → **Cherry-pick N commits** (applied oldest → newest regardless of selection order).
- Drag a commit row onto the checked-out branch pill → drop menu → **Cherry-pick commit here**.
- Left panel: dragging is not available; context menu only.

## 3. UI Requirements

- Before executing, a lightweight confirm popover (not a full dialog): "Cherry-pick \<shortsha\> onto \<current branch\>?" with a **Commit immediately** checkbox (default on). Unchecked = `--no-commit`: changes land staged in WIP for the user to commit manually.
- Progress toast for multi-commit picks: "Cherry-picking 3 of 7…".
- Success: new commit(s) appear at the branch tip; toast "Cherry-picked N commits onto \<branch\>"; the source commits get a subtle "picked" flash highlight so the user sees the correspondence.

## 4. Behavior

| # | Rule |
|---|---|
| B1 | Single pick = `git cherry-pick <sha>`; keeps original author, new committer, appends nothing to the message (no `-x`) by default; a settings flag enables `-x` ("(cherry picked from commit …)" line). |
| B2 | Multi-pick executes as a sequence oldest→newest; on conflict, the sequence pauses (git cherry-pick sequencer) with banner "Cherry-pick in progress — stopped at \<shortsha\> (i of n)" and **Continue / Skip / Abort**; Abort cancels the remaining sequence and resets to the pre-pick tip (already-applied picks are rolled back). |
| B3 | Picking a merge commit: context menu item is enabled but opens a parent-selection popover ("Mainline: parent 1 (\<branch-ish\>) / parent 2 (…)") → `-m <n>`. |
| B4 | Dirty working tree: allowed when git allows; auto-stash fallback like pull B3 when git refuses. |
| B5 | Empty result (change already present) → git stops; auto-resolve by skipping with a note in the toast ("1 commit skipped — already applied"). |
| B6 | `--no-commit` mode with multiple commits applies all into the index (single combined WIP), matching git behavior. |
| B7 | Undo after completed pick(s) resets the branch tip to pre-pick (reflog), restoring exactly. |

## 5. Edge Cases

- Cherry-picking onto a branch where HEAD is the same patch → skipped-as-applied (B5).
- Cherry-pick while another operation is in progress → blocked with toast linking to the active banner.
- Picking commits that touch files deleted on the current branch → normal conflict flow with delete/modify file-level resolution (see merge doc §5).
- Detached HEAD target: allowed; detached banner rules from checkout doc apply.

## 6. Acceptance Criteria

- [ ] Single and multi cherry-pick work from context menu and DnD; multi applies oldest→newest.
- [ ] Confirm popover with "Commit immediately" toggle; `--no-commit` leaves staged changes in WIP.
- [ ] Sequence conflict flow: banner with position, Continue/Skip/Abort; Abort rolls back all applied picks of the sequence.
- [ ] Merge-commit pick requires and applies mainline parent selection.
- [ ] Already-applied commits are skipped with notice.
- [ ] Undo restores the pre-pick tip.
