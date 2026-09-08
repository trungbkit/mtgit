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
| Command palette / fuzzy finder | Type branch name → Enter | Checkout (local **and** remote branches — STATUS B7) |
| Graph, any pane | `/` | **Branch finder** — an inline type-to-jump over refs. Unlike the palette it does not check out on Enter; it *scrolls to and selects* the branch tip, which is what you want nine times out of ten when you are reading history rather than switching work. |
| Left panel branch / graph pill | Context menu → **Open in worktree…** | Check the branch out into a *new* worktree instead of switching this one (§7) |

## 3. UI Requirements

- The checked-out branch is marked everywhere simultaneously: checkmark + highlight in left panel, checkmark + computer icon on graph pill, name in top-left branch selector.
- During checkout, the target pill shows a small spinner. Reads stay live; **every mutating control is disabled for the duration** — one `busyOp` flag in the session store, set by all write paths and read by the toolbar, context menus and drop menus, so this does not have to be remembered per call site.
- After checkout the graph scrolls to the new HEAD row and briefly highlights it.
- Checking out a remote branch names the new local branch after the remote branch (strip `origin/`) and sets upstream automatically.

## 4. Behavior

| # | Rule |
|---|---|
| B1 | Clean tree → plain `git checkout` / `switch`. No dialog. |
| B2 | Dirty tree, no path collision with target → checkout proceeds carrying changes (git default). WIP row follows to the new branch. |
| B3 | Dirty tree with collision (git refuses) → dialog with three options: **Stash changes and continue** (auto-pops after checkout if pop is clean; if pop conflicts, leave stash and notify), **Discard changes** (confirm again, red button), **Cancel**. |
| B4 | Checkout of a commit/tag → detached HEAD. Persistent amber banner above graph: "You are in a detached HEAD state at \<shortsha\>" with **Create branch here** and **Return to \<previous branch\>** buttons — the second names the branch, resolved from `@{-1}`, so the user knows where it will land. Branch selector shows the short SHA, not the word "detached". |
| B5 | Checkout is undoable: Undo returns to the previous HEAD (branch or commit), restoring stashed-by-us changes if we auto-stashed. |
| B6 | If another operation is in progress (merge/rebase conflict state), checkout is blocked with a toast pointing to the conflict banner. |

## 5. Edge Cases

- Remote branch whose local name conflicts with an existing local tracking a *different* remote branch → dialog asking to checkout the existing local or create `name-1`.
- Branch names with `/` render as flat names on pills but as folders in the left panel tree.
- Submodule pointer changes after checkout: show a toast "Submodules changed — update?" with an Update action (never auto-run). Toasts therefore need to carry actions, not just text — the same mechanism `03-push.md` B3 needs for push recovery.
- Very large checkouts (many files changed): progress toast with file counter.
- A branch already checked out in another worktree cannot be checked out here — git refuses. Do not surface that error raw: say which worktree holds it and offer **Open that worktree** / **Open in a new worktree**.

## 6. Acceptance Criteria

> Status audited 2026-09-08 — see `STATUS.md`.

- [x] Double-click checkout works from left panel and graph pills, for local and remote branches.
- [x] Clean checkout requires zero dialogs and completes with visual confirmation (checkmark moves, graph scrolls to HEAD). — no post-scroll highlight flash
- [x] Collision dialog offers Stash-and-continue / Discard / Cancel and each path behaves as specified. — `lib/checkout.ts`
- [x] Detached HEAD banner appears with working "Create branch here" and "Return to previous branch" actions. — neither action invalidates queries, so the banner outlives its own fix (STATUS A2); previous branch is not named
- [x] Remote checkout creates a correctly named local branch with upstream set. — `switch --track -c`, incl. the `name-1` conflict path
- [x] Undo restores previous HEAD including auto-stashed changes.
- [ ] Mutating controls are gated while a checkout runs (§3). — only the target pill reflects it
- [ ] Checkout is refused with a pointer to the banner while an operation is paused (B6).
- [ ] Large checkouts show a progress toast with a file counter (§5).

**New in this revision (GitLens-derived) — none implemented:**

- [ ] `/` opens the branch finder and selects the branch tip in the graph without checking out.
- [ ] Command palette offers remote branches as checkout targets (STATUS B7).
- [ ] **Open in worktree…** creates and opens a worktree per §7, from a branch, a commit, or a remote branch.
- [ ] A branch held by another worktree produces the named-worktree dialog, not git's raw refusal.
- [ ] Worktree list, add and remove are reachable from the sidebar WORKTREES section.

---

## 7. Worktrees as an alternative to switching

GitLens's answer to "I need to look at another branch" is often *not* checkout — it is a
worktree, because checkout drags your working tree with it and a worktree does not. MTGit
already has the backend for this (`core/worktree.rs`: list + add); what is missing is that it
is not offered anywhere checkout is offered, which is the only place a user would think of it.

| # | Rule |
|---|---|
| B7 | **Open in worktree…** is available on any ref or commit, next to Checkout. It prompts for a location (defaulting to a sibling directory named after the branch, which is the convention worth defaulting to) and then opens that worktree — in this window, replacing the repo tab's working directory, or in a new tab. |
| B8 | Creating a worktree from a **remote** branch creates the local tracking branch in it, exactly as remote checkout does (§4, `switch --track -c`). From a **commit**, the worktree is detached, and the detached-HEAD banner rules (B4) apply inside it. |
| B9 | The current worktree is shown in the toolbar next to the branch selector whenever it is not the main one — a user who forgets which worktree they are in will commit to the wrong branch, and nothing else in the UI tells them. |
| B10 | Removing a worktree with uncommitted changes confirms and names what will be lost; it is *not* covered by Undo (working-tree content was never committed — same rule as discard, `01-commit.md` §3.3). |
| B11 | Every worktree of the repo contributes its WIP row to the one graph (`01-commit.md` §3.1); the graph is per repository, not per worktree. |
