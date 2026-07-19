# Feature: Pull & Fetch (GitKraken-style)

> Read `00-overview.md` first for shared concepts.

## 1. Summary

Fetch is continuous and invisible; Pull is a deliberate toolbar action with selectable strategy. Ahead/behind state is always visible without any user action.

## 2. Entry Points

- Toolbar **Fetch** button with a dropdown caret: **Fetch All**, **Pull (fast-forward if possible)**, **Pull (rebase)**, **Pull (fast-forward only)**. The dropdown also lets the user set the *default* click behavior of the main button (persisted per repo).
- Shortcut: `⌘/Ctrl+Shift+P` = pull with default strategy.
- Left panel branch context menu: **Pull (fast-forward)** on the current branch; **Fetch \<remote\>** on remote nodes.
- Auto-fetch: every N minutes (default 1, configurable, 0 = off) runs `git fetch --all --prune` in the background.

## 3. UI Requirements

- Behind/ahead counts render next to branch names in the left panel (`41↓ 2↑`) and on the toolbar after every fetch.
- Auto-fetch is silent: no toasts, no focus steal; only counts and remote pills update. Manual fetch shows a brief progress indicator on the button.
- Pull progress toast; on completion, graph animates: remote and local pills converge on the new tip.
- If pull produces a merge commit, the graph shows it immediately with both parent edges.

## 4. Behavior

| # | Rule |
|---|---|
| B1 | Fetch never touches working tree or local branches; prunes deleted remote refs (`--prune`) and removes their pills. |
| B2 | Pull (default) = fetch + fast-forward if possible, otherwise merge. Pull (rebase) = fetch + `rebase` onto upstream. Pull (ff-only) = fail with toast "Cannot fast-forward — branch has diverged" offering Pull (merge) / Pull (rebase) actions if ff impossible. |
| B3 | Dirty working tree + pull that requires merge/rebase → auto-stash before, auto-pop after (like checkout B3); if pop conflicts, keep the stash and toast with a link to the stash. |
| B4 | Conflicts during pull enter the shared conflict UX (overview §5) as a merge or rebase conflict; Abort restores pre-pull state. |
| B5 | No upstream configured → dialog to pick remote branch to pull from, with "set as upstream" checkbox. |
| B6 | Pull is undoable when it only moved refs locally (Undo = reset to pre-pull tip, per reflog); tooltip explains. |

## 5. Edge Cases

- Remote branch deleted upstream: after prune, orphaned tracking info shows a toast offering to unset upstream or delete the local branch.
- Diverged after remote force-push: behind/ahead both non-zero and remote pill "detaches" visually; pull (rebase) recommended in the rejection toast.
- Auth failure / offline: auto-fetch fails silently but sets a small warning icon on the Fetch button (tooltip: last successful fetch time + error); manual pull shows the full error.
- Multiple remotes: Fetch All fetches every remote; pull uses upstream only.

## 6. Acceptance Criteria

- [ ] Auto-fetch updates counts/pills silently on the configured interval and prunes deleted refs.
- [ ] All three pull strategies work and the default is persisted per repo.
- [ ] Dirty-tree pull auto-stashes and restores, with the conflict-on-pop fallback.
- [ ] Pull conflicts use the shared conflict UI; Abort restores the exact pre-pull state.
- [ ] No-upstream pull shows the upstream dialog.
- [ ] Offline auto-fetch degrades silently with a warning icon; manual operations surface errors fully.
