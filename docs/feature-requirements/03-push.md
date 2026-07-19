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
- While pushing: button shows spinner; progress toast with byte/object progress from git; Cancel where possible.
- On success: toast "Pushed N commits to origin/\<branch\>", ahead arrow clears, remote pill moves to the local tip (graph animates the remote ref label to the new row).
- On rejection: persistent toast with the git error and contextual actions (§4 B3/B4).

## 4. Behavior

| # | Rule |
|---|---|
| B1 | Branch has upstream → `git push` to it. |
| B2 | No upstream → dialog: "Push \<branch\> to:" remote selector (default `origin`) + remote branch name input (pre-filled with local name) + "Set as upstream" checkbox (default on). Submit pushes with `-u` when checked. |
| B3 | Rejected (non-fast-forward) → toast: "Push rejected — remote has new commits" with actions **Pull (rebase) then push**, **Pull (merge) then push**, **Force push**, **Cancel**. The pull-then-push actions chain automatically and stop on conflicts (conflict UX, overview §5). |
| B4 | Force push always uses `--force-with-lease` and always confirms with a dialog naming the branch and remote, stating that remote history will be overwritten; the confirm button is red and requires typing nothing but is not the default-focused button. If lease fails (remote moved), explain and offer fetch-and-retry. |
| B5 | Pushing a branch other than HEAD from the context menu pushes without checkout (`git push origin local:remote`). |
| B6 | Push is not undoable; Undo tooltip explains this after a push. |
| B7 | Multiple remotes: the Push dropdown lists each remote; default remote is the branch upstream's remote, else `origin`. |

## 5. Edge Cases

- Protected branch rejection (server-side hook): show server message verbatim; no force option offered if server declined.
- Auth failure: dialog explaining credential issue, "Open terminal" action (xterm panel) so the user can authenticate; never store credentials ourselves — rely on git credential helpers.
- Push of a branch with no commits ahead but no upstream: B2 dialog still applies (publishing a branch).
- Tags are not pushed by default; ref context menu on a tag offers **Push tag**.

## 6. Acceptance Criteria

- [ ] Push with upstream is one click, updates remote pill position and clears the ahead badge.
- [ ] First push shows the upstream dialog and sets tracking correctly.
- [ ] Non-fast-forward rejection offers the three recovery paths and each works, including stopping on conflict.
- [ ] Force push uses `--force-with-lease` and its confirmation dialog; plain `--force` is never issued.
- [ ] Pushing a non-checked-out branch works without switching branches.
- [ ] Progress + success/failure toasts appear per overview §4.
