# Feature: Merge (GitKraken-style)

> Read `00-overview.md` first for shared concepts, especially §5 Conflict Handling.

## 1. Summary

Merge is primarily a **drag-and-drop** gesture on the graph/left panel, with context-menu parity, and flows into the shared conflict editor when needed.

## 2. Entry Points

| Surface | Gesture | Result |
|---|---|---|
| Left panel / graph pill | Drag branch A onto checked-out branch B | Drop menu: **Merge A into B**, **Rebase B onto A**, **Fast-forward B to A** (only when possible), **Create pull request** (if remote integration exists later) |
| Branch context menu | "Merge \<A\> into \<current\>" | Immediate merge |
| Remote branch pill | Drag onto local | Same drop menu (merges the remote-tracking ref) |

Dragging onto a branch that is *not* checked out offers only "Checkout B then merge…" composite action.

## 3. UI Requirements

- During drag: valid drop targets highlight; the dragged pill ghosts under the cursor; invalid targets (same branch, ancestors where no action applies) show no highlight.
- Drop menu appears at cursor with the actions above; Escape cancels.
- Merge commit message dialog is **not** shown by default; the standard `Merge branch 'A' into B` message is used. (A settings flag may enable an editable-message dialog later.)
- On success the merge commit appears at the tip with two parent edges; toast "Merged A into B".
- Fast-forward result: no new commit; B's pill simply moves; toast "Fast-forwarded B to A".

## 4. Behavior

| # | Rule |
|---|---|
| B1 | Merge runs `git merge --no-ff`? **No** — default is git's default (ff when possible) *unless* the user picked an explicit action: "Merge A into B" always creates a merge commit (`--no-ff`); "Fast-forward" runs `--ff-only`. |
| B2 | Dirty working tree: allowed if git allows it; if git refuses, offer auto-stash like checkout B3. |
| B3 | Conflicts → shared conflict state (overview §5), banner "Merge in progress". **Continue** creates the merge commit with staged resolutions; **Abort** = `git merge --abort`, restoring pre-merge state exactly. |
| B4 | Merging an already-merged/ancestor branch: toast "Already up to date", no commit. |
| B5 | Undo after a clean merge resets B to its pre-merge tip (only if not pushed since). |
| B6 | Merge in progress blocks checkout/pull/rebase/cherry-pick; their triggers toast and link to the banner. |

## 5. Conflict Editor Specifics (merge)

- "Ours" = checked-out branch (B), "Theirs" = incoming (A); both labeled with branch names + lane colors, not just ours/theirs.
- Hunk checkboxes: take left, take right, or both (order: left then right); output pane editable; per-file "Take all left / Take all right" bulk buttons.
- File-level shortcuts in the conflicted list: "Resolve using Ours / Theirs" without opening the editor.
- Non-text conflicts (binary, delete/modify): present as file-level choices only ("Keep ours / Keep theirs / Keep deleted").

## 6. Acceptance Criteria

- [ ] Drag-and-drop merge works from left panel and graph pills, with the drop menu exactly as specified; Escape cancels.
- [ ] Explicit "Merge" always produces a merge commit; "Fast-forward" never does; availability of ff option computed correctly.
- [ ] Conflict flow: banner, file list, three-pane editor with hunk checkboxes and editable output, Continue/Abort both correct.
- [ ] "Already up to date" and dirty-tree cases behave per B2/B4.
- [ ] Undo restores pre-merge tip after a clean merge.
- [ ] All merge actions available via context menu (no DnD-only functionality).
