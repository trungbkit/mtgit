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
| B5 | Success toast: "Rebased \<branch\> onto \<target\> (n commits replayed)". If the branch now diverges from its upstream (ahead **and** behind both non-zero after a rewrite), the Push button carries a warning marker and its tooltip reads "History was rewritten — this push needs force-with-lease"; clicking it goes straight to the B4 force-push confirmation rather than to a rejection the user then has to recover from. |
| B6 | Undo after completed rebase = reset branch to pre-rebase tip (reflog), only if not pushed since. |
| B7 | Rebasing onto an ancestor / nothing to do → toast "Already up to date". |

## 4. Interactive Rebase — UI

Opening interactive rebase replaces the right panel (or a modal sheet) with the **rebase plan editor**:

- One row per commit, oldest at bottom (matching graph order), each row: drag handle, avatar, short SHA, message, and an action selector: **Pick / Reword / Squash / Fixup / Drop**.
- Rows are drag-reorderable, and reordering re-runs the conflict prediction above. Drop = row struck through. Squash/Fixup visually attach the row to the one above it (indent + connector line); squash allows editing the combined message at execution time, fixup discards the message.
- Reword expands an inline message editor in the row.
- Footer: **Start Rebase** (primary) and **Cancel**. A summary line: "n picks, n squashes, n drops".
- **Conflict prediction.** Before the plan is executed, the editor marks the rows that *will*
  conflict. GitLens does this, and it is the single feature that changes how an interactive
  rebase feels: reordering commits is a guess until you know which of the guesses costs you
  twenty minutes of conflict resolution. Compute it by trial-applying the plan's patches
  against a scratch index (a temporary worktree or an in-memory `git2` merge per step — no
  refs move, nothing is written to the repo), and mark the offending rows with the files that
  clash. It is an *estimate*: label it as one, recompute it on every reorder, and never let a
  clean prediction imply a guarantee.
- Validation: cannot squash/fixup the oldest row; invalid plans disable Start with an explanation.

## 5. Interactive Rebase — Behavior

| # | Rule |
|---|---|
| B8 | Executes the plan non-interactively (backend drives `git rebase -i` via `GIT_SEQUENCE_EDITOR` or reimplements with cherry-picks — implementation detail, semantics must match git). |
| B9 | Conflicts mid-plan use the same banner as standard rebase, including Skip. |
| B10 | Reword-only and message-edit-only plans must not touch the working tree. |
| B11 | "Edit commit message" / "Drop commit" / "Move up" on a commit N-deep is implemented as an auto-generated interactive rebase of N children — with the same pushed-commits warning as B1. |
| B12 | The plan editor shows a persistent warning strip when any affected commit is pushed. |
| B13 | Conflicts raised by an interactive rebase use the unified conflict panel (`05-merge.md` §5) — one panel for every conflicted file, with cross-file region navigation. A mid-plan stop is the case that panel exists for. |
| B14 | Undo after a completed rebase restores the branch to its **exact** pre-rebase tip in one click, from the completion toast as well as the toolbar (overview §3). This is the claim that makes the rest of the feature usable; if it is not one click from where the operation finished, it is not the feature. |

## 6. Edge Cases

- Merge commits inside the rebased range: standard rebase flattens (git default); show a note in the pre-rebase warning when merges will be flattened. Interactive rebase excludes merge commits from the plan — and says so in the plan editor ("2 merge commits in this range are not shown and will be flattened"), because a commit missing from the list with no explanation reads as a bug.
- Rebase of a branch other than HEAD: context menu allows it by checking out first (composite action, stated in the menu item).
- Empty commits created by rebase (patch already applied): auto-skip, note in the completion toast ("2 commits skipped — already applied").

## 7. Acceptance Criteria

> Status audited 2026-09-08 — see `STATUS.md`.

- [x] Drag and context-menu standard rebase both work with pushed-commit pre-warning. — `rewrite_info` drives the warning, and counts flattened merges too
- [x] Conflict stops show commit position (i of n) with Continue/Skip/Abort all correct; Abort restores pre-rebase state exactly.
- [◐] Interactive editor supports reorder, pick/reword/squash/fixup/drop with the specified visuals and validation. — all actions, drag reorder, inline reword and the oldest-row validation are in; squash/fixup rows are not visually attached to the row above, and rows carry no avatar
- [x] Edit-message/drop/move-up context actions work on non-HEAD commits via auto-rebase. — plus squash-into-parent and move-down
- [◐] Post-rebase ahead/behind + force-push hint correct. — badges update; there is no force-push hint on the Push button (B5)
- [x] Undo restores the pre-rebase tip.
- [ ] The graph shows the in-progress state during a rebase — applied commits on the new base, remaining ones ghosted (B4).
- [ ] Rebasing onto an ancestor toasts "Already up to date" (B7) — currently "Rebased 0 commit(s)".
- [ ] Excluded merge commits are flagged in the plan editor (§6).
- [ ] Rebase of a branch other than HEAD, as a composite check-out-then-rebase action (§6).

**New in this revision (GitLens-derived) — none implemented:**

- [ ] The plan editor predicts which rows will conflict, recomputes on reorder, labels the
      prediction as an estimate, and writes nothing to the repo to find out (§4).
- [ ] A mid-plan conflict opens the unified conflict panel with cross-file region navigation (B13).
- [ ] Undo is offered from the rebase completion toast, restoring the exact pre-rebase tip (B14).

> Deferred (overview §8.3): **Automatic Rebase** — GitLens's AI conflict resolution with
> confidence levels and manual-override prompts. Worth naming because it is built directly on
> top of the two items above: prediction plus a one-click undo is the foundation it needs, so
> building those well is not wasted if we ever want it.
