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
| B1 | The action the user picked decides the mode; MTGit never guesses. **"Merge A into B"** runs `--no-ff` and always produces a merge commit — a user who chose "merge" and got a silently fast-forwarded branch has lost the record of the merge. **"Fast-forward B to A"** runs `--ff-only` and never produces one. Git's own default (ff when possible) is used only where no explicit action was chosen — e.g. the merge half of a `pull`. |
| B2 | Dirty working tree: allowed if git allows it; if git refuses, offer auto-stash like checkout B3. |
| B3 | Conflicts → shared conflict state (overview §5), banner "Merge in progress". **Continue** creates the merge commit with staged resolutions; **Abort** = `git merge --abort`, restoring pre-merge state exactly. |
| B4 | Merging an already-merged/ancestor branch: toast "Already up to date", no commit. |
| B5 | Undo after a clean merge resets B to its pre-merge tip (only if not pushed since). |
| B6 | Merge in progress blocks checkout/pull/rebase/cherry-pick; their triggers toast and link to the banner. |

## 5. Conflict Editor Specifics (merge)

- Left pane = checked-out branch (B), right pane = incoming (A); both labeled with branch names + lane colors, never the bare words "ours"/"theirs" (overview §5.2 gives the labels for every operation).
- Hunk controls: take left, take right, or both (order: left then right). These are *actions*, so render them as buttons — a checkbox implies a state that persists and can be unticked, which is not what applying a side to the output does. Output pane editable; per-file "Take all left / Take all right" bulk buttons.
- **One panel, every file.** GitLens collects all conflicted files into a single panel showing both sides, rather than making resolution a per-file mode you enter and leave. Ours should too: the file list and the three panes live in the same view, selecting a file swaps the panes, and the resolved count updates in place. The reason is not tidiness — a rebase that stops with eleven conflicted files is navigated dozens of times, and a mode boundary per file is dozens of round trips.
- File-level shortcuts in the conflicted list: "Resolve using \<branch\> / \<incoming\>" without opening the editor — labelled by ref, per overview §5.2, never "Ours / Theirs".
- Region navigation with `n` / `p` across the *whole* set, not per file: `p` at the first conflict of a file moves to the last conflict of the previous one. The counter reads "conflict 3 of 17 · file 2 of 5".
- Non-text conflicts (binary, delete/modify): present as file-level choices only. A delete/modify conflict gets all three — "Keep ours / Keep theirs / Keep deleted" — spelled out with what each side actually is ("Keep the file as modified on `feature`" / "Delete it, as on `main`"); a binary conflict gets the two content choices.

## 6. Acceptance Criteria

> Status audited 2026-09-08 — see `STATUS.md`.

- [◐] Drag-and-drop merge works from left panel and graph pills, with the drop menu exactly as specified; Escape cancels. — works from both; the graph uses a cursor menu with Escape, the sidebar a modal `choiceDialog` (STATUS C5), and neither highlights only *legal* targets
- [◐] Explicit "Merge" always produces a merge commit; "Fast-forward" never does; availability of ff option computed correctly. — modes are right (`--no-ff` / `--ff-only`); the ff entry is offered unconditionally (STATUS C6)
- [◐] Conflict flow: banner, file list, three-pane editor with hunk controls and editable output, Continue/Abort both correct. — all present; panes are labelled "Ours"/"Theirs" (STATUS C4) and the hunk controls are checkboxes acting as buttons
- [x] "Already up to date" and dirty-tree cases behave per B2/B4. — `--autostash`; `MergeKind::UpToDate`
- [x] Undo restores pre-merge tip after a clean merge.
- [x] All merge actions available via context menu (no DnD-only functionality). — sidebar branch menu; graph *pills* still have no ref menu (STATUS B1)
- [x] A paused operation blocks merge with a pointer to the banner (B6). — `requireNoPausedOperation`, applied to all six entry points §5.3 names, not merge alone

**New in this revision (GitLens-derived) — none implemented:**

- [ ] All conflicted files live in one panel; selecting a file swaps the panes without leaving the view (§5).
- [ ] `n` / `p` navigate conflict regions across every conflicted file, with an `i of n · file j of k` counter.
- [ ] Take-side shortcuts and pane headers are labelled by ref, not "Ours"/"Theirs" (STATUS C4).
