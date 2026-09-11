# Feature: Push (GitKraken-style)

> Read `00-overview.md` first for shared concepts.

## 1. Summary

One-click push of the current branch from the toolbar, with smart upstream handling and a safe, explicit force-push flow.

## 2. Entry Points

- Toolbar **Push** button (badge shows count of unpushed commits on current branch). Shortcut `⌘/Ctrl+P`.
- Left panel / graph pill context menu on any local branch: **Push \<branch\>** (works for non-checked-out branches).
- Push button dropdown: **Push (force)** → runs force-with-lease flow (§4 B4).

## 3. UI Requirements

- Push button disabled (with tooltip "Nothing to push") when ahead count is 0 and upstream exists.
- **Unpushed commits are marked in the graph itself.** Every row between the upstream tip and the local tip carries an "unpushed" marker (GitLens shows ahead/behind state per row, not only per branch). The push button's badge says *how many*; the graph says *which* — and "which" is the question you actually have before a force push, or before pushing a branch you rebased an hour ago.
- While pushing: button shows spinner; progress toast with byte/object progress from git; Cancel where possible.
- On success: toast "Pushed N commits to origin/\<branch\>", ahead arrow clears, remote pill moves to the local tip (graph animates the remote ref label to the new row).
- On rejection: persistent toast with the git error and contextual actions (§4 B3/B4).

## 4. Behavior

| # | Rule |
|---|---|
| B1 | Branch has upstream → `git push` to it. |
| B2 | No upstream → dialog: "Push \<branch\> to:" remote selector (default `origin`) + remote branch name input (pre-filled with local name) + "Set as upstream" checkbox (default on). Submit pushes with `-u` when checked. |
| B3 | Rejected (non-fast-forward) → toast: "Push rejected — remote has new commits" with actions **Pull (rebase) then push**, **Pull (merge) then push**, **Force push**, **Cancel**. The pull-then-push actions chain automatically and stop on conflicts (conflict UX, overview §5). |
| B4 | Force push always uses `--force-with-lease` and always confirms with a dialog naming the branch and remote, stating that remote history will be overwritten. The confirm button is red; it needs no typed confirmation, but it is **not** focused when the dialog opens and it is not what Enter activates — Cancel is. If the lease fails (the remote moved since our last fetch), do not re-offer the same button: explain that someone else pushed, and offer **Fetch and review** (which fetches, then leaves the user in front of the new remote commits) alongside Cancel. Never fall back to plain `--force`. |
| B5 | Pushing a branch other than HEAD from the context menu pushes without checkout (`git push origin local:remote`). |
| B6 | Push is not undoable; Undo tooltip explains this after a push. |
| B7 | Multiple remotes: the Push dropdown lists each remote; default remote is the branch upstream's remote, else `origin`. |

## 5. Edge Cases

- Protected branch rejection (server-side hook): show server message verbatim; no force option offered if server declined. Distinguish this from a non-fast-forward rejection by the presence of a server-side `remote: ` message rather than by pattern-matching the word "rejected" — a pre-receive hook decline contains it too, and offering Force there is offering an action the server will refuse again.
- Auth failure: dialog explaining credential issue, "Open terminal" action (xterm panel) so the user can authenticate; never store credentials ourselves — rely on git credential helpers.
- Push of a branch with no commits ahead but no upstream: B2 dialog still applies (publishing a branch).
- Tags are not pushed by default; ref context menu on a tag offers **Push tag**.
- Pushing from inside a secondary worktree pushes that worktree's HEAD branch, not the main worktree's — the toolbar must be reading the active worktree (`02-checkout.md` B9), or this silently pushes the wrong branch.

## 6. Acceptance Criteria

> Status audited 2026-09-08 — see `STATUS.md`.

- [x] Push with upstream is one click, updates remote pill position and clears the ahead badge. — pill moves on refresh, no animation
- [◐] First push shows the upstream dialog and sets tracking correctly. — tracking is correct, but it is a yes/no confirm: no remote selector, no editable remote branch name, no opt-out of `-u` (B2, STATUS C1)
- [x] Non-fast-forward rejection offers the three recovery paths and each works, including stopping on conflict. — the chained pull stops, but a conflict there raises no banner (STATUS A1)
- [x] Force push uses `--force-with-lease` and its confirmation dialog; plain `--force` is never issued.
- [x] Pushing a non-checked-out branch works without switching branches. — sidebar context menu, `git push <remote> <branch>`
- [x] Progress + success/failure toasts appear per overview §4. — progress + Cancel in the status bar; no spinner on the button
- [x] Push dropdown lists every remote and defaults to the upstream's (B7). — landed in P1; upstream tracking is deliberately left alone, so picking a second remote once does not silently retarget every later push.
- [x] Lease failure explains itself and offers fetch-and-review (B4). — `net.ts:classifyFailure` reads it out of git's text (invariant 6 leaves nothing structured to read), and the dialog offers a fetch. It never force-pushes on its own: that is the accident `--force-with-lease` exists to prevent, and a test asserts no `--force` reaches git from this path.
- [x] Auth failure gets a dialog with an "Open terminal" action (§5). — we run git without a terminal, so a password or passphrase prompt has nowhere to appear; the dialog says so and opens the panel where the credential helper can run.
- [x] Tag context menu offers **Push tag** (§5). — one row per remote when there is more than one, so "push" never silently means origin. Also on the graph's tag pills.
- [x] Push is reachable from the graph pill context menu (§2). — pills have their own ref menu now (STATUS B1): checkout, merge, rebase, push, rename, delete, and scope-the-graph, mirroring the sidebar's deliberately.

**New in this revision (GitLens-derived) — none implemented:**

- [x] Rows ahead of the upstream carry an unpushed marker in the graph (§3). — `graph::sync_sets` walks the divergence once (bounded by ahead/behind, not by history) and each row carries `unpushed`. No upstream means no marks at all, which is the honest answer rather than marking everything.
- [x] Push from a secondary worktree targets that worktree's branch (§5). *A worktree opened as a tab is the repo handle, so `push_target` reads its HEAD; the toolbar names the worktree (`02-checkout.md` B9), which is what §5 says this depends on.*

> Deferred (overview §8.3): creating a pull request from the branch after a push, and the
> Launchpad-style PR list. `GITKRAKEN_PARITY_PLAN.md` §2.5 already holds the line here; the
> drop menu's "Create pull request" entry (`05-merge.md` §2) stays absent until it does not.
