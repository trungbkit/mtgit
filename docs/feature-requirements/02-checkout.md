# Feature: Checkout (GitKraken-style)

> Read `00-overview.md` first for shared concepts.

## 1. Summary

Checkout is the most frequent operation and must be near-instant and confirmation-free. Every ref surface (left panel, graph pills, context menus) supports it.

## 2. Entry Points

| Surface | Gesture | Action |
|---|---|---|
| Left panel branch | Double-click | Checkout local branch |
| Left panel remote branch | Double-click | Create tracking local branch (if none) and checkout; if a local with the same name exists, checkout that |
| Graph branch pill | Double-click | Same as above |
| Commit row | Context menu → "Checkout this commit" | Detached HEAD checkout (confirmation-free, but see §4) |
| Branch dropdown (top-left, next to repo name) | Click item | Checkout |
| Command palette / fuzzy finder | Type branch name → Enter | Checkout |

## 3. UI Requirements

- The checked-out branch is marked everywhere simultaneously: checkmark + highlight in left panel, checkmark + computer icon on graph pill, name in top-left branch selector.
- During checkout, the target pill shows a small spinner; UI stays interactive but other write operations are queued/disabled.
- After checkout the graph scrolls to the new HEAD row and briefly highlights it.
- Checking out a remote branch names the new local branch after the remote branch (strip `origin/`) and sets upstream automatically.

## 4. Behavior

| # | Rule |
|---|---|
| B1 | Clean tree → plain `git checkout` / `switch`. No dialog. |
| B2 | Dirty tree, no path collision with target → checkout proceeds carrying changes (git default). WIP row follows to the new branch. |
| B3 | Dirty tree with collision (git refuses) → dialog with three options: **Stash changes and continue** (auto-pops after checkout if pop is clean; if pop conflicts, leave stash and notify), **Discard changes** (confirm again, red button), **Cancel**. |
| B4 | Checkout of a commit/tag → detached HEAD. Persistent amber banner above graph: "You are in a detached HEAD state" with **Create branch here** and **Return to \<previous branch\>** buttons. Branch selector shows short SHA. |
| B5 | Checkout is undoable: Undo returns to the previous HEAD (branch or commit), restoring stashed-by-us changes if we auto-stashed. |
| B6 | If another operation is in progress (merge/rebase conflict state), checkout is blocked with a toast pointing to the conflict banner. |

## 5. Edge Cases

- Remote branch whose local name conflicts with an existing local tracking a *different* remote branch → dialog asking to checkout the existing local or create `name-1`.
- Branch names with `/` render as flat names on pills but as folders in the left panel tree.
- Submodule pointer changes after checkout: show a toast "Submodules changed — update?" with an Update action (never auto-run).
- Very large checkouts (many files changed): progress toast with file counter.

## 6. Acceptance Criteria

- [ ] Double-click checkout works from left panel and graph pills, for local and remote branches.
- [ ] Clean checkout requires zero dialogs and completes with visual confirmation (checkmark moves, graph scrolls to HEAD).
- [ ] Collision dialog offers Stash-and-continue / Discard / Cancel and each path behaves as specified.
- [ ] Detached HEAD banner appears with working "Create branch here" and "Return to previous branch" actions.
- [ ] Remote checkout creates a correctly named local branch with upstream set.
- [ ] Undo restores previous HEAD including auto-stashed changes.
