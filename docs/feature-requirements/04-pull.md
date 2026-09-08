# Feature: Pull & Fetch (GitKraken-style)

> Read `00-overview.md` first for shared concepts.

## 1. Summary

Fetch is continuous and invisible; Pull is a deliberate toolbar action with selectable strategy. Ahead/behind state is always visible without any user action.

## 2. Entry Points

- Toolbar **Fetch** button with a dropdown caret: **Fetch All**, **Pull (fast-forward if possible)**, **Pull (rebase)**, **Pull (fast-forward only)**. The dropdown also lets the user set the *default* click behavior of the main button (persisted per repo).
- Shortcut: `⌘/Ctrl+Shift+P` = pull with default strategy.
- Left panel branch context menu: **Pull (fast-forward)** on the current branch; **Fetch \<remote\>** on remote nodes.
- Auto-fetch: once on repo open and then every N minutes (default 1, configurable, 0 = off) runs `git fetch --all --prune` in the background. Changing N restarts the timer immediately — the setting must not require reopening the repository (see overview §4).

## 3. UI Requirements

- Behind/ahead counts render next to branch names in the left panel (`41↓ 2↑`) and on the toolbar after every fetch.
- **Unpulled commits are marked in the graph**, mirroring the unpushed markers in `03-push.md` §3: the remote-tracking rows a pull would bring in are visually distinguished, so "what is this pull going to do to me" is answerable before running it.
- **Jump to upstream / merge target** (overview §3) scroll to and select those tips. Merge target is resolved as the upstream's base branch, falling back to the repo's default branch, and is the branch this one is expected to merge into — being 40 commits behind *it* matters even when the upstream is level.
- Auto-fetch is silent: no toasts, no focus steal; only counts and remote pills update. Manual fetch shows a brief progress indicator on the button.
- Pull progress toast; on completion, graph animates: remote and local pills converge on the new tip.
- If pull produces a merge commit, the graph shows it immediately with both parent edges.

## 4. Behavior

| # | Rule |
|---|---|
| B1 | Fetch never touches working tree or local branches; prunes deleted remote refs (`--prune`) and removes their pills. |
| B2 | Pull (default) = fetch + fast-forward if possible, otherwise merge. Pull (rebase) = fetch + `rebase` onto upstream. Pull (ff-only) = fail with toast "Cannot fast-forward — branch has diverged" offering Pull (merge) / Pull (rebase) actions if ff impossible. |
| B3 | Dirty working tree + pull that requires merge/rebase → `git pull --autostash` (git's own, not a hand-rolled stash/pop pair, so an interrupted pull leaves the stash where git's own recovery expects it). If the autostash pop conflicts, git keeps the stash: detect that and toast "Your changes are still in the stash" with a link that selects it in the sidebar — do not leave it to be read out of the raw git output. |
| B4 | Conflicts during pull enter the shared conflict UX (overview §5) as a merge or rebase conflict; Abort restores pre-pull state. |
| B5 | No upstream configured → dialog to pick remote branch to pull from, with "set as upstream" checkbox. |
| B6 | Pull is undoable when it only moved refs locally (Undo = reset to pre-pull tip, per reflog); tooltip explains. |

## 5. Edge Cases

- Remote branch deleted upstream: after prune, orphaned tracking info shows a toast offering to unset upstream or delete the local branch.
- Diverged after remote force-push: behind/ahead both non-zero and remote pill "detaches" visually; pull (rebase) recommended in the rejection toast.
- Auth failure / offline: auto-fetch fails silently but sets a small warning icon on the Fetch button (tooltip: last successful fetch time + error); manual pull shows the full error.
- Multiple remotes: Fetch All fetches every remote; pull uses upstream only.
- Behind the **merge target** but level with the upstream: no ahead/behind badge fires, so this state is invisible today. Surface it where the merge target is shown, not as another toolbar count — it is information, not an action.

## 6. Acceptance Criteria

> Status audited 2026-09-08 — see `STATUS.md`.

- [x] Auto-fetch updates counts/pills silently on the configured interval and prunes deleted refs. — the interval is state, so saving it restarts the timer, and one fetch fires at open (STATUS A4 fixed)
- [x] All three pull strategies work and the default is persisted per repo. — `localStorage`, per repo path
- [◐] Dirty-tree pull auto-stashes and restores, with the conflict-on-pop fallback. — `--autostash` is passed; the pop-conflict case has no dedicated feedback
- [x] Pull conflicts use the shared conflict UI; Abort restores the exact pre-pull state. — the banner now comes from `refreshRepo`'s re-read of `operation_info`, not from the op's return value (STATUS A1 fixed)
- [x] No-upstream pull shows the upstream dialog. — remote-branch chooser; "set as upstream" is implicit, not a checkbox
- [x] Offline auto-fetch degrades silently with a warning icon; manual operations surface errors fully. — icon tooltip carries the error and last success time
- [ ] Sidebar entry points: **Pull (fast-forward)** on the current branch, **Fetch \<remote\>** on remote nodes (§2) — the REMOTE section has no per-remote root node.
- [ ] Prune that orphans an upstream offers to unset it or delete the local branch (§5).

**New in this revision (GitLens-derived) — none implemented:**

- [ ] Rows behind the upstream carry an unpulled marker in the graph (§3).
- [ ] Jump-to-HEAD / upstream / merge-target controls exist and select the right rows (overview §3).
- [ ] Merge target is resolved and displayed, and being behind it is visible even when the upstream is level (§5).
