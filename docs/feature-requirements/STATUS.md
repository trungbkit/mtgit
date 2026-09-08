# Implementation Status — audited 2026-09-08

Audit of `docs/feature-requirements/*` against the code at `12e1909`. Every claim below was
read out of the source, not inferred from the plan. The gate is green at this commit:
40 Rust tests pass, `clippy -D warnings` clean, `tsc --noEmit` clean.

> **Scope note (revised after the GitLens pass).** This audit covers the docs *as they stood on
> 2026-09-08*, before `gitkraken/vscode-gitlens` was folded in as a second reference
> (`00-overview.md` §0). The specs have since grown a set of GitLens-derived criteria, each
> marked "New in this revision" in its own doc and **none of them implemented** — plus a whole
> new doc, `08-search-and-filter.md`. §6 below inventories them. Nothing in §1–§5 changed
> meaning: no verdict here was downgraded by the new material, because the new criteria are
> additions rather than corrections. Read the per-doc verdicts as "complete against the
> original seven-feature spec", not as "complete against the docs in front of you".

**Headline:** all seven features are implemented end-to-end — including the three the parity
plan still lists as future work (hunk/line staging, the 3-pane conflict editor, interactive
rebase). What is missing is not capability but *finish*: a handful of entry points, a few
dialogs that were collapsed into simpler confirms, and the polish items in §1.2/§3/§4 of the
overview.

`GITKRAKEN_PARITY_PLAN.md` was stale as a result — it marked P2 as "next" while P2–P5 had
landed. That record has since been corrected, and the plan now also carries the GitLens gap
analysis (its §2.6 and P8).

| Doc | Feature | Verdict |
|---|---|---|
| `01-commit.md` | Commit & staging | **Complete** — 6 of 7 acceptance criteria; missing "Continue \<operation\>" in the commit button |
| `02-checkout.md` | Checkout | **Complete** — all 6 criteria; polish gaps only (busy-gating, progress counter) |
| `03-push.md` | Push | **Substantially complete** — 4 of 6; publish dialog is a confirm, no per-remote push target |
| `04-pull.md` | Pull & fetch | **Substantially complete** — 5 of 6; auto-fetch lifecycle bugs, sidebar entry points missing |
| `05-merge.md` | Merge | **Complete** — 5 of 6; conflict panes are labelled "Ours/Theirs", not by branch |
| `06-rebase.md` | Rebase + interactive | **Complete** — 5 of 6; no in-progress graph ghosting, no force-push hint |
| `07-cherry-pick.md` | Cherry-pick | **Complete** — 5 of 6; no per-commit sequence progress, no dirty-tree auto-stash |
| `08-search-and-filter.md` | Commit search & filtering | **Not started** — `search_commits` does not exist; new doc, nothing to audit |

---

## 1. Defects — wrong behaviour, not missing polish

| # | Defect | Where | Why it matters |
|---|---|---|---|
| **A1** | **A conflicting pull leaves no conflict banner.** `Toolbar.net()` reports the failure as a toast and invalidates queries, but never calls `syncOperation` / sets `useConflict`. Menu-driven merge/rebase/cherry-pick set it from their own result; pull cannot, because `gitNetwork` returns a `GitOpResult` with no conflict list. The fs watcher would eventually cover it, but `git_network` holds an op guard, so the watcher's 300 ms debounce fires *inside* the 600 ms quiet window and the event is dropped. | `features/toolbar/Toolbar.tsx:120-170`, `ipc/events.ts:14-36`, `state.rs` `QUIET_MS` | The user is left in a conflicted tree with no banner, no Abort, and no Continue until they happen to touch a file. Breaks `04-pull.md` B4 and overview §5.1. **Fix: every mutating path calls `syncOperation(path)` after it completes — put it in the shared `refresh()`, not at the call sites.** |
| **A2** | **`DetachedHeadBanner` never invalidates queries.** Its "Create branch here" and "Return to previous branch" both await the backend and then rely on the watcher — which is suppressed for 600 ms after the guarded command. | `components/DetachedHeadBanner.tsx:22-40` | The banner stays on screen after it has been resolved, and the graph keeps the old HEAD. Same class of bug as A1. |
| **A3** | **Nothing blocks a second operation while one is paused.** `05-merge.md` B6, `02-checkout.md` B6 and `07-cherry-pick.md` §5 all require checkout/pull/rebase/cherry-pick to be refused with a toast pointing at the banner. There is no such check anywhere in `src/`. | all mutating call sites | git itself refuses most of these, so the user gets a raw git error instead of the specified pointer — recoverable, but it is the one place the spec asks us to be gentler than git. |
| **A4** | **Auto-fetch never runs at open and ignores its own setting until reopen.** The interval effect is keyed on `repo?.path` only, so writing `mtgit.autoFetch.<path>` does not restart it — the code says so in its own toast ("takes effect when the repository is reopened"). No fetch fires on mount either, so ahead/behind is stale for the first interval. | `features/toolbar/Toolbar.tsx:62-81` | Violates `04-pull.md` §2 ("Ahead/behind state is always visible without any user action"). **Fix: read the interval into state, key the effect on it, and fetch once immediately.** |
| **A5** | **Sidebar filter placeholder lies.** Placeholder reads `Filter (⌘ Option + f)`; the handler binds `⌘/Ctrl+F`. | `features/sidebar/Sidebar.tsx:57-66, 352` | Trivial, but it is the discoverability affordance for the shortcut. |

## 2. Missing entry points (capability exists, no way to reach it)

| # | Gap | Spec |
|---|---|---|
| B1 | **No ref context menu on graph pills.** Right-clicking a pill falls through to the *commit* menu, so push/rename/delete/merge-from-here are sidebar-only. | overview §1.2, `03-push.md` §2 |
| B2 | **No "Push tag".** The tag context menu offers Copy SHA and Delete only; `git_network` can already push a refspec. | `03-push.md` §5 |
| B3 | **No "Pull (fast-forward)" on the current branch and no "Fetch \<remote\>" on remote nodes** in the sidebar — the REMOTE section has no per-remote root node to hang it on. | `04-pull.md` §2 |
| B4 | **Push dropdown does not list remotes.** Multi-remote repos can only push to the upstream's remote (or `origin`). | `03-push.md` B7 |
| B5 | **`⌘⇧C` only works when the commit panel is already open** — the listener lives in `StagingView`, which mounts only when the WIP row is selected. It should select WIP *and* focus the summary. | `01-commit.md` §2 |
| B6 | **Commit button never becomes "Continue \<operation\>".** Continue lives only in the banner. | `01-commit.md` §5 |
| B7 | **Command palette lists local branches only** — remote branches are not checkout targets there. | `02-checkout.md` §2 |
| B8 | **Interactive rebase ignores a multi-select range**; it always plans `<clicked commit>..HEAD`. Equivalent only when the selection ends at HEAD. | overview §1.3 |
| B9 | **Cherry-pick `-x` has no toggle.** `cherryPickMany(..., appendOrigin)` is plumbed all the way through and hardcoded `false` at the call site. Needs the settings flag (or a popover checkbox). | `07-cherry-pick.md` B1 |

## 3. Dialogs simplified below spec

| # | Gap | Spec |
|---|---|---|
| C1 | **First push is a yes/no confirm, not a publish dialog.** `net.ts:publish` asks "Push it to \<remote\> and track it?" — no remote selector, no editable remote branch name, and upstream is always set. | `03-push.md` B2 |
| C2 | **No lease-failure recovery.** A rejected `--force-with-lease` surfaces raw; there is no "the remote moved — fetch and retry" path. | `03-push.md` B4 |
| C3 | **No auth-failure dialog.** Credential failures are a plain error toast; the spec wants an explanation plus an "Open terminal" action so the user can authenticate. (The conflict banner already does exactly this — copy that button.) | `03-push.md` §5 |
| C4 | **Conflict panes are labelled "Ours"/"Theirs"**, not by branch name and lane colour. During a rebase or cherry-pick those two words mean the opposite of what most users expect, so this is worse than cosmetic — see the new overview §5.2 rule. | `05-merge.md` §5 |
| C5 | **Sidebar drag-drop opens a modal `choiceDialog`**, not a drop menu at the cursor. The graph does it correctly with `ContextMenu`. | `05-merge.md` §3 |
| C6 | **"Fast-forward" is always offered** in both drop menus, even when the target cannot fast-forward — the spec asks for the option to be computed. | `05-merge.md` §2, §6 |
| C7 | **No dedicated toast for a conflicting autostash pop.** Checkout has one (`lib/checkout.ts:finish`); pull relies on `git pull --autostash`, whose failure is only visible in the raw output. | `04-pull.md` B3 |
| C8 | **Orphaned upstream after prune is silent** — no offer to unset upstream or delete the local branch. | `04-pull.md` §5 |

## 4. Visual / feedback polish outstanding

- **WIP row is not on the lane.** It renders as a strip above the scroll container, so it has no
  lane node, no lane colour, and it sits above the top row even when HEAD is not the top row
  (`GraphView.tsx:640-651`). Everything else about it — dashed node, `// WIP`, pencil, file
  count, live watcher updates — is correct.
- **Commit-message column shows the subject only**, not "subject + inline summary of body".
- **No progress on a cherry-pick sequence** ("Cherry-picking 3 of 7…"); the whole list is one
  `git cherry-pick` invocation, so there is nothing to report per commit. Either drive the
  sequence commit-by-commit or drop the requirement.
- **No "picked" flash** on source commits after a cherry-pick; **no highlight flash** on the new
  HEAD row after checkout (it scrolls to it, which is the load-bearing half).
- **No remote-pill animation** after a push, and **no in-progress ghosting** of not-yet-replayed
  commits during a rebase (`06-rebase.md` B4).
- **Squash/fixup rows are not visually attached** to the row above in the rebase plan editor
  (no indent, no connector), and rows carry no avatar.
- **Toolbar buttons do not spin.** Progress and Cancel live in the status bar instead of a
  bottom-left toast — a deliberate, better placement; the requirement now says so.
- **`Pop` is enabled with no stash** and fails with "No stashes to pop" instead of being
  disabled with a tooltip (overview §3).
- **No busy-gating**: during a checkout only the target pill shows `◌`; every other mutating
  control stays live (`02-checkout.md` §3).
- **Rebase onto an ancestor** toasts "Rebased 0 commit(s)" rather than "Already up to date"
  (`06-rebase.md` B7).
- **Merge commits are silently excluded** from the interactive plan (`advanced.rs:351`); the
  spec asks for them to be flagged. The standard-rebase pre-warning does count them.

## 5. Test coverage gaps

`core/advanced.rs` carries the whole of checkout recovery, merge modes, the operation
sequencer, conflict resolution and interactive rebase — and has three tests
(`native_commit_uses_staged_snapshot`, `interactive_rebase_rewords_without_touching_tree`,
`no_commit_cherry_pick_leaves_changes_staged`). The behaviours a regression would silently
break, none of which are covered:

- `checkout` with `Stash` recovery when the pop conflicts (must keep the stash, report it).
- `checkout` `REMOTE_NAME_CONFLICT` encoding — the frontend parses it with a regex.
- `merge` kind classification: `UpToDate` / `FastForward` / `Normal` across all three modes.
- `operation_continue` / `_skip` / `_abort` for each of merge, rebase, cherry-pick, revert.
- `resolve_conflict_side` on a delete/modify conflict (the `git rm` fallback path).
- `rewrite_info` counts (pushed / merges) — these drive a destructive-action warning.
- Sequence-meta bookkeeping (`i of n` in the banner) across continue and skip.
- `apply_patch` round-trip for line-level staging: CRLF, no trailing newline, added-lines-only.

There is still no frontend test runner (P7). Given how much behaviour now lives in
`net.ts`, `lib/checkout.ts` and the stores, Vitest is worth pulling forward.

---

## 6. GitLens-derived criteria — added after this audit, none implemented

Folded in from `gitkraken/vscode-gitlens` (`00-overview.md` §0 explains why it counts as a
GitKraken reference, and §8 records what was ruled out). This is the backlog the specs grew;
it is listed in one place so the unchecked boxes scattered through seven docs are countable.

| Doc | New criteria | Weight |
|---|---|---|
| `08-search-and-filter.md` | 15 — the whole doc | **Large.** New backend command, a grammar parser in Rust, result modes, hit navigation. This is `GITKRAKEN_PARITY_PLAN.md` G10, and it is the largest single gap remaining in the set. |
| `00-overview.md` | configurable/reorderable graph columns · Changes column · minimap · scroll markers · ref overflow `+N` · ghost refs on hover · stacked detail sheets · WORKTREES + CONTRIBUTORS sidebar sections · sidebar-scopes-the-graph · jump to HEAD/upstream/merge target · one date-style setting · terminal links · autolinks · rich hovers · blame heatmap · file/line history following renames · revision navigation · guided command palette | **Medium, and mostly independent.** Several are a day each (terminal links, heatmap, date style, `+N` overflow); the column model and the detail stack are refactors. |
| `01-commit.md` | 5 — per-worktree WIP row · co-author picker · `commit.template` · autolinks in preview · stash / copy-to-worktree actions | Small each; the per-worktree WIP row depends on the graph carrying worktrees at all. |
| `02-checkout.md` | 5 + new §7 — `/` branch finder · remote branches in the palette · **Open in worktree…** · worktree-holds-branch dialog · sidebar worktree management | Medium. `core/worktree.rs` already lists and adds; this is almost entirely UI. |
| `03-push.md` | 2 — unpushed row markers · worktree-aware push target | Small. |
| `04-pull.md` | 3 — unpulled row markers · jump-to controls · merge-target resolution + display | Small–medium; merge target needs a resolution rule and a place to live. |
| `05-merge.md` | 3 — unified conflict panel · cross-file region navigation · ref-labelled take-side | Medium. Subsumes STATUS C4, and the panel rework is the prerequisite for the rebase items. |
| `06-rebase.md` | 3 — conflict prediction · unified panel mid-plan · undo from the completion toast | **Conflict prediction is the one genuinely new algorithm** in this list: trial-apply the plan against a scratch index without moving refs. |
| `07-cherry-pick.md` | 3 — search-fed multi-pick · unified panel · worktree composite action | Small, given the two dependencies above. |

**Dependency order, if this is picked up as a block:**

1. **Worktrees in the graph** (per-worktree WIP rows) — unblocks four docs' worth of criteria
   and uses backend that already exists.
2. **The unified conflict panel** — subsumes an existing defect (C4) and is a prerequisite for
   two of the three rebase items.
3. **Search** (`08-search-and-filter.md`) — the largest item, and the one users notice missing;
   it is also what makes cherry-pick and interactive rebase reachable on a real repository.
4. Everything else is independent and small enough to land opportunistically. **Terminal links
   are the best value-per-hour item in the whole file**: MTGit already has the pty panel and the
   graph selection API, so it is a regex and a click handler.

### 6.1 What was ruled *out*, so it is not re-proposed

`00-overview.md` §8.2 and §8.3: Git CodeLens and caret-line blame (no editing surface here),
VS Code view/layout management, the treemaps and Visual File History (each a feature-sized
project), and the whole `plus/` half — Launchpad and PR panels, agent sessions, GitKraken MCP,
Cloud Patches, Cloud Workspaces, and every AI feature including Automatic Rebase. That last
group is also non-MIT in GitLens's own repo, which is a second reason not to treat it as a
reference implementation.
