# Feature: Rebase & Interactive Rebase (GitKraken-style)

> Read `00-overview.md` first for shared concepts, especially §5 Conflict Handling.

## 1. Summary

Two modes: **standard rebase** (drag or context menu, "Rebase X onto Y") and **interactive rebase** (visual todo-list editor replacing the git-rebase-todo file). Both share conflict handling and are fully abortable.

## 2. Entry Points

- Drag checked-out branch pill onto another branch/commit → drop menu → **Rebase \<current\> onto \<target\>**.
- Commit context menu → **Rebase \<current branch\> onto this commit**.
- Commit context menu → **Interactive rebase \<current branch\> onto this commit** ("Interactive Rebase N children of \<sha\>").
- Single-commit shortcuts that are sugar over interactive rebase, exposed directly in the commit context menu: **Edit commit message**, **Drop commit**, **Move commit up/down**, **Squash into parent** (multi-select), **Reword**.

## 3. Standard Rebase — Behavior

| # | Rule |
|---|---|
| B1 | Runs `git rebase <target>` for the checked-out branch. Pre-check: if any commit being rewritten is on a remote, show a warning dialog ("N of these commits are pushed — you will need to force push") before starting. |
| B2 | Dirty tree → auto-stash / restore (same pattern as pull B3). |
| B3 | Conflicts pause at the offending commit → shared conflict banner: "Rebase in progress — stopped at \<shortsha\> (i of n)" with **Continue**, **Skip commit**, **Abort**. Continue requires all conflicts staged; Skip drops the current commit; Abort restores the exact pre-rebase state. |
| B4 | During rebase the graph shows the in-progress state: already-applied commits on the new base, remaining ones ghosted at their old location. |
| B5 | Success toast: "Rebased \<branch\> onto \<target\> (n commits replayed)". If upstream now diverges, ahead/behind badges update and the Push button hints force-with-lease will be needed. |
| B6 | Undo after completed rebase = reset branch to pre-rebase tip (reflog), only if not pushed since. |
| B7 | Rebasing onto an ancestor / nothing to do → toast "Already up to date". |

## 4. Interactive Rebase — UI

Opening interactive rebase replaces the right panel (or a modal sheet) with the **rebase plan editor**:

- One row per commit, oldest at bottom (matching graph order), each row: drag handle, avatar, short SHA, message, and an action selector: **Pick / Reword / Squash / Fixup / Drop**.
- Rows are drag-reorderable. Drop = row struck through. Squash/Fixup visually attach the row to the one above it (indent + connector line); squash allows editing the combined message at execution time, fixup discards the message.
- Reword expands an inline message editor in the row.
- Footer: **Start Rebase** (primary) and **Cancel**. A summary line: "n picks, n squashes, n drops".
- Validation: cannot squash/fixup the oldest row; invalid plans disable Start with an explanation.

## 5. Interactive Rebase — Behavior

| # | Rule |
|---|---|
| B8 | Executes the plan non-interactively (backend drives `git rebase -i` via `GIT_SEQUENCE_EDITOR` or reimplements with cherry-picks — implementation detail, semantics must match git). |
| B9 | Conflicts mid-plan use the same banner as standard rebase, including Skip. |
| B10 | Reword-only and message-edit-only plans must not touch the working tree. |
| B11 | "Edit commit message" / "Drop commit" / "Move up" on a commit N-deep is implemented as an auto-generated interactive rebase of N children — with the same pushed-commits warning as B1. |
| B12 | The plan editor shows a persistent warning strip when any affected commit is pushed. |

## 6. Edge Cases

- Merge commits inside the rebased range: standard rebase flattens (git default); show a note in the pre-rebase warning when merges will be flattened. Interactive rebase excludes/flags merge commits.
- Rebase of a branch other than HEAD: context menu allows it by checking out first (composite action, stated in the menu item).
- Empty commits created by rebase (patch already applied): auto-skip, note in the completion toast ("2 commits skipped — already applied").

## 7. Acceptance Criteria

- [ ] Drag and context-menu standard rebase both work with pushed-commit pre-warning.
- [ ] Conflict stops show commit position (i of n) with Continue/Skip/Abort all correct; Abort restores pre-rebase state exactly.
- [ ] Interactive editor supports reorder, pick/reword/squash/fixup/drop with the specified visuals and validation.
- [ ] Edit-message/drop/move-up context actions work on non-HEAD commits via auto-rebase.
- [ ] Post-rebase ahead/behind + force-push hint correct.
- [ ] Undo restores the pre-rebase tip.
