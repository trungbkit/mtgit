# Implementation Status — audited 2026-09-08

Audit of `docs/feature-requirements/*` against the code at `12e1909`. Every claim below was
read out of the source, not inferred from the plan. The gate is green at this commit:
40 Rust tests pass, `clippy -D warnings` clean, `tsc --noEmit` clean.

> **§1 is now closed.** A1 landed with the mutation seam (`6e16ed8`); A2–A5 landed after it, and
> each row below carries its own record. The gate is green with all five fixed: clippy clean at
> `-D warnings`, `tsc --noEmit` clean, `vite build` succeeds. §2–§4 were never defects — they are
> missing entry points, simplified dialogs and polish.
>
> **P5-search (G10) has since landed too** — `08-search-and-filter.md` is implemented bar the
> four items in its new §7.1 — and **P1 landed on 2026-09-11** (clone / init / remote management
> / start screen / first-class tabs), closing G1–G4 and G12 plus **B3** and **B4** below. The
> gate is at **78 Rust tests** (42 + 25 for search + 11 for clone, init and remotes).
> **P8 item 1 (worktrees, G18) and terminal links (G19) landed on 2026-09-11 too**, taking the
> gate to **92 Rust tests**. §6's per-doc backlog below is annotated with what that closed.
> **P6 and most of P7 landed on 2026-09-11 as well.** P6 closed G13–G15 (settings file + git
> identity, both themes, the keybinding registry with its `?` cheat sheet, and the SVG icon set)
> and took the Rust gate to **107**; it also closed **B9** below and added the diff
> ignore-whitespace option. P7 added CI, `scripts/check-ipc.mjs` and a **154-test** Vitest suite
> — which found and fixed four real defects, recorded in §5. `GITKRAKEN_PARITY_PLAN.md` §8 now
> points at **the rest of P8**, with P7's e2e and code signing left over.
>
> P1 has no doc of its own here: `docs/feature-requirements/` specifies the seven core
> operations plus search, and clone / init / remote management are repo *lifecycle*, not one of
> them. The plan's §4/P1 is their record.

> **P8 completed on 2026-09-11**, and with it most of §2–§4 below. Items 2–6 landed together:
> the unified conflict panel (G25), the graph column model and the search minimap (G16/G17), the
> detail stack (G24), interactive-rebase conflict prediction (G26), and all of item 6's cheap
> wins — `--follow` / `-L` and revision navigation (G22), the blame heatmap and rich hovers
> (G21), autolinks (G20), merge target and jump-to with per-row unpushed/unpulled markers (G23),
> the contributors view (G28) and the guided command palette (G27). **Every row in §2 and §3
> below is now closed**, and §4 is down to four polish items. The gate is at **162 Rust tests**
> and **204 frontend tests**, green on all six commands.
> What is left in the plan is **P7's e2e and code signing**, which need a driver on the runner
> and certificates this repository does not have.

> **Scope note (revised after the GitLens pass).** This audit covers the docs *as they stood on
> 2026-09-08*, before `gitkraken/vscode-gitlens` was folded in as a second reference
> (`00-overview.md` §0). The specs have since grown a set of GitLens-derived criteria, each
> marked "New in this revision" in its own doc and, at the time, **none of them implemented** —
> plus a whole new doc, `08-search-and-filter.md`. §6 below inventories them, and records that
> the search doc has since been built while the rest of that list has not. Nothing in §1–§5 changed
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
The verdicts below are as of **2026-09-11, after P8**. Each doc's own §6/§7 has the per-criterion
record; what is unticked there is unticked here.

| Doc | Feature | Verdict |
|---|---|---|
| `01-commit.md` | Commit & staging | **Complete** against the original spec and all but one GitLens criterion; **Stash / Copy-to-worktree from the panel headers** is the remainder |
| `02-checkout.md` | Checkout | **Complete** bar two: the large-checkout progress counter (git gives us no progress for a local checkout) and the `/` branch finder |
| `03-push.md` | Push | **Complete** — publish form, lease and auth recovery, push-tag, the pill menu and unpushed markers all landed |
| `04-pull.md` | Pull & fetch | **Complete** — including the autostash-conflict toast, the prune-orphan recovery, unpulled markers, jump-to and merge target |
| `05-merge.md` | Merge | **Complete** — the unified conflict panel closed the last three |
| `06-rebase.md` | Rebase + interactive | **Complete** bar in-progress graph ghosting (B4) |
| `07-cherry-pick.md` | Cherry-pick | **Substantially complete** — no dirty-tree stash fallback, no per-commit sequence progress, no worktree composite action |
| `08-search-and-filter.md` | Commit search & filtering | **Complete** bar `file:` path autocomplete — the minimap and contributor autocomplete landed with P8. See its §7.1 |

---

## 1. Defects — wrong behaviour, not missing polish — ✅ all five fixed

| # | Defect | Where | Why it matters |
|---|---|---|---|
| ~~**A1**~~ | ✅ **FIXED.** **A conflicting pull left no conflict banner.** `Toolbar.net()` reported the failure as a toast and invalidated queries, but never called `syncOperation` / set `useConflict`. Menu-driven merge/rebase/cherry-pick set it from their own result; pull could not, because `gitNetwork` returns a `GitOpResult` with no conflict list. The fs watcher would eventually have covered it, but `git_network` holds an op guard, so the watcher's 300 ms debounce fires *inside* the 600 ms quiet window and the event is dropped. | was `features/toolbar/Toolbar.tsx:120-170`, `ipc/events.ts:14-36`; now `ipc/repoState.ts` | The user was left in a conflicted tree with no banner, no Abort, and no Continue until they happened to touch a file. Broke `04-pull.md` B4 and overview §5.1. **See §1.1 — the fix was larger than this row described.** |
| ~~**A2**~~ | ✅ **FIXED.** **`DetachedHeadBanner` never invalidates queries.** Its "Create branch here" and "Return to previous branch" both awaited the backend and then relied on the watcher — which is suppressed for 600 ms after the guarded command. | `components/DetachedHeadBanner.tsx` | The banner stayed on screen after it had been resolved, and the graph kept the old HEAD. Same class of bug as A1, and the two-line fix §1.1 predicted: `await refreshRepo(qc, path)` in each handler. Both handlers also gained A3's gate, since both move HEAD. |
| ~~**A3**~~ | ✅ **FIXED.** **Nothing blocks a second operation while one is paused.** `05-merge.md` B6, `02-checkout.md` B6, `07-cherry-pick.md` §5 and overview §5.3 all require checkout/pull/merge/rebase/cherry-pick/reset to be refused with a toast pointing at the banner. There was no such check anywhere in `src/`. | `ipc/repoState.ts:requireNoPausedOperation` + 11 call sites | git itself refused most of these, so the user got a raw git error instead of the specified pointer — recoverable, but it is the one place the spec asks us to be gentler than git. **See §1.2.** |
| ~~**A4**~~ | ✅ **FIXED.** **Auto-fetch never runs at open and ignores its own setting until reopen.** The interval effect was keyed on `repo?.path` only, so writing `mtgit.autoFetch.<path>` did not restart it — the code said so in its own toast ("takes effect when the repository is reopened"). No fetch fired on mount either, so ahead/behind was stale for the first interval. | `features/toolbar/Toolbar.tsx` | Violated `04-pull.md` §2 ("Ahead/behind state is always visible without any user action"). Fixed as prescribed — `autoFetchMinutes` is state, the timer effect is keyed on it, `configureAutoFetch` sets it directly, and one fetch fires on open. A `lastAutoFetch` ref (attempt time, distinct from the tooltip's `lastFetch` success time) keeps StrictMode's second effect pass, and a mere interval change, from re-fetching. |
| ~~**A5**~~ | ✅ **FIXED.** **Sidebar filter placeholder lies.** Placeholder read `Filter (⌘ Option + f)`; the handler binds `⌘/Ctrl+F`. | `features/sidebar/Sidebar.tsx` | Trivial, but it is the discoverability affordance for the shortcut. The placeholder now reads `⌘F` or `Ctrl+F` per platform; the handler was left alone, since it already binds what the spec's other shortcuts bind. |

### 1.1 A1 — what actually shipped, and why the row above understated it

This row said the fix was "one call to `syncOperation` in the shared `refresh()`". Both halves
of that were wrong, and the correction is worth recording so the same mis-sizing does not
happen to A3:

- **There was no shared `refresh()`.** Six components each defined their own identical
  `qc.invalidateQueries({ predicate: q => q.queryKey[1] === path })` — `Toolbar`, `Sidebar`,
  `GraphView`, `StagingView`, `CommandPalette`, `ConflictBanner`.
- **`syncOperation` was not callable.** It was a closure *inside* `useRepoEvents`, so no
  mutation site could have reached it even if it had tried.
- **Seven places derived conflict state independently**, and only `events.ts` did it the way
  overview §5.1 requires. `Sidebar`, `GraphView`, `RebasePlanDialog`, `CherryPickPopover` and
  `ConflictBanner` each rebuilt it from their own operation's return value, and
  `StagingView` + `ConflictEditor` went further: they filtered the resolved file out of the
  store's list locally — remembered state, never reconciled against git, which is exactly what
  §5.1 prohibits.
- **`CherryPickPopover` and `RebasePlanDialog` never invalidated at all**, so even a *successful*
  cherry-pick or interactive rebase left a stale graph.

**What landed** (`src/ipc/repoState.ts`, new):

- `syncOperation(path)` — exported, reads `operation_info` and is the **only** writer to the
  conflict store in the whole frontend.
- `refreshRepo(qc, path)` — invalidate **+** `syncOperation`, welded together so a caller cannot
  do one without the other. It replaced all six `refresh()` copies and all nine raw
  `invalidateQueries` call sites; `grep` now finds exactly one of each in `src/`.
- Every hand-rolled conflict derivation deleted, including both optimistic file-list filters.
  The `i of n` counter now comes from the backend's sequence meta (which `operation_continue` /
  `operation_skip` already bump) instead of `ConflictBanner` computing `min(current+1, total)`
  on top of an already-correct value.
- The two dialogs await `refreshRepo` **before** `onClose()`, so a paused sequence has its
  banner up before the dialog unmounts.

**Test:** `operation_info_reports_a_conflict_it_was_never_told_about` (`core/advanced.rs`) —
conflicts a merge with the `git` binary directly, so nothing in our code ran and reading the
repository is the only way to know, then asserts kind/conflicts/`can_continue`/`(current,
total)` and that `merge --abort` clears it. It pins the contract rather than reproducing A1:
the bug was frontend wiring, and there is still no frontend test runner (P7), so **the
reconciliation logic itself is unverified by machine** — `refreshRepo` was typechecked and
built but not clicked through in the running app. `scripts/make-fixture.sh` ships a
deliberately conflicting branch, which is the fastest manual check.

**Also closed incidentally:** the successful-cherry-pick and successful-interactive-rebase
staleness above, and the §5.1 violation in `StagingView` / `ConflictEditor`. A2 was not touched
by that pass and was fixed afterwards, as the two-line change against the seam this paragraph
predicted.

### 1.2 A3 — where the gate lives, and what it deliberately does not stop

§1.1 warned that A1 was mis-sized and predicted A3 would benefit most from a single chokepoint.
It did, but the chokepoint is not `refreshRepo`: that runs *after* a mutation, and a gate has to
run before one. What landed instead is one function in the same seam module —
`ipc/repoState.ts:requireNoPausedOperation(path, action)` — called from eleven places.

- **It re-reads git before answering** (§5.1). The conflict store is only as fresh as the last
  refresh, and a stale "no operation" would pass the action through to the raw git error the gate
  exists to replace. `syncOperation` swallows its own errors, so a repo we cannot interrogate
  fails **open**: a gate that has lost its footing must not become a wall.
- **It throws rather than returning a verdict.** Every mutating call site in `src/` already
  funnels failures into `toastError`, so a throw reports itself exactly once, and in a composite
  flow (check out the target, *then* merge) it stops the rest of the sequence for free.
- **Two of the eleven are real chokepoints, not repetition.** `lib/checkout.ts:smartCheckout`
  covers all seven checkout entry points — sidebar, graph rows, ref pills, toolbar, palette and
  both drop flows — and `net.ts:runNet` covers the palette's pull. The rest are one helper per
  operation per file (`Sidebar.doMerge` / `doRebase`, `GraphView.doReset` / `standardRebase` /
  `runDrop`, `RebasePlanDialog.start`, `CherryPickPopover.run`), which is why three merge menu
  items and three reset menu items share one call each rather than six.
- **What is *not* gated is the point of the design.** Staging, commit, and the banner's own
  Continue / Skip / Abort stay open, because they are how the user gets *out* of the paused
  state. Fetch and push stay open too: fetch touches no ref the paused operation cares about,
  and pushing the pre-operation tip is still a legal thing to want. §5.3 names pull because it
  is the one that merges into a conflicted tree.
- **The refusal points at the banner, as §5.3 asks.** `revealConflictBanner()` dispatches an
  event the banner listens for; it flashes and calls `scrollIntoView`. The flash is the
  load-bearing half today — the banner sits outside any scroll container — and the scroll is
  insurance for the day the shell grows one. Without it the user is told to look at something
  that never moved.

**Test:** `operation_info_still_reports_a_paused_operation_with_no_conflicts_left`
(`core/advanced.rs`). The gate asks exactly one question, so it is only as good as
`operation_info`'s willingness to report an operation whose conflicts have all been resolved
and staged — and *that* is the dangerous half of the paused state, not the harmless one: a
rebase stopped mid-plan with a clean index still has replays pending, and a checkout there
abandons them. The conflict list is empty at that point, so anything keying off
`conflicts.is_empty()` would wave the checkout through. The test was confirmed to fail against
exactly that simulated regression before being kept.

**Still unverified by machine**, for the same reason A1's fix was: the gate itself is frontend
wiring and there is no frontend test runner (P7, §5 below). The Rust test pins the contract the
gate depends on, not the eleven call sites that consult it. `scripts/make-fixture.sh` ships a
deliberately conflicting branch, which is the fastest manual check — merge it, then try to check
out another branch.

## 2. Missing entry points (capability exists, no way to reach it)

| # | Gap | Spec |
|---|---|---|
| ~~B1~~ | ✅ **FIXED.** Pills carry their own menu (`GraphView.refContextMenu`): checkout, scope-the-graph, merge, rebase, push, rename, delete for a branch; copy / push / delete for a tag. The entries mirror the sidebar's deliberately — two menus for one object that disagree about what you can do to it is worse than either. | overview §1.2, `03-push.md` §2 |
| ~~B2~~ | ✅ **FIXED.** One row per remote when there is more than one, so "push" never silently means origin. In the sidebar's tag menu and on the graph's tag pills. | `03-push.md` §5 |
| ~~B3~~ | ✅ **FIXED in P1.** Both landed once the REMOTE section grew the per-remote root node this row said was missing: the node's menu carries `Fetch <remote>` (with `--prune`), and the checked-out branch's menu carries `Pull (fast-forward) from <upstream>`, disabled when it is not behind. | `04-pull.md` §2 |
| ~~B4~~ | ✅ **FIXED in P1.** The push caret lists every configured remote as `Push <branch> to <remote>` when there is more than one, running an explicit `git push <remote> <branch>`. Upstream tracking is deliberately left alone — picking a second remote once must not silently retarget every later push. | `03-push.md` B7 |
| ~~B5~~ | ✅ **FIXED.** The chord moved to `App`, which selects the WIP row; `StagingView` focuses its summary on mount. Two halves rather than one listener, because the panel that owns the field is the one that can focus it, and it does not exist until the row is selected. | `01-commit.md` §2 |
| ~~B6~~ | ✅ **FIXED.** Mid-operation the primary button is Continue, disabled while files are still conflicted and carrying `i of n` for a sequence. It reads the conflict store, never writes it (the seam is still the single writer, §1.1). The banner keeps its own Continue: this is a second place, not a replacement, because this is where the user's hands already are. | `01-commit.md` §5 |
| ~~B7~~ | ✅ **FIXED** by the guided palette (G27). Checkout is one *step* now, listing local branches, remote branches and tags — which also removed the pre-expanded "Checkout \<branch\>" row per branch that used to crowd out every real command. | `02-checkout.md` §2 |
| ~~B8~~ | ✅ **FIXED.** With a multi-select the base is the *oldest selected commit's parent*, not the clicked commit — rebasing onto the oldest selection itself would leave it out of the plan. The row is labelled with the count so the two cases are distinguishable before clicking. | overview §1.3 |
| ~~B9~~ | ✅ **FIXED in P6.** The settings flag this row asked for exists now (General → Commits, "Record the source of a cherry-pick"), and `CherryPickPopover` passes `settings().cherryPickAppendOrigin` at the call site that was hardcoded `false`. | `07-cherry-pick.md` B1 |

## 3. Dialogs simplified below spec

| # | Gap | Spec |
|---|---|---|
| ~~C1~~ | ✅ **FIXED.** `features/network/PublishDialog.tsx`, raised through the dialog store as a `publish` *kind* so `net.ts` — a plain module with no place in the tree — can still await it. All three values are the user's: remote, the branch's name on the remote, and whether to track. A changed remote name produces a full `local:remote` refspec rather than relying on them matching, which is the point of having a form. | `03-push.md` B2 |
| ~~C2~~ | ✅ **FIXED.** `net.ts:classifyFailure` reads it out of git's text — invariant 6 leaves nothing structured to read — and the dialog offers a fetch. It never force-pushes on its own; a test asserts no `--force` reaches git from this path. | `03-push.md` B4 |
| ~~C3~~ | ✅ **FIXED.** The explanation names the real cause: we run git without a terminal, so a password, token or ssh passphrase prompt has nowhere to appear. "Open terminal" is idempotent (`stores/session.ts:openTerminal`) — "open" must not close an already-open panel, which `toggleTerminal` would. | `03-push.md` §5 |
| ~~C4~~ | ✅ **FIXED** by G25. `conflict_sides` resolves both sides per operation and the panel names them, with each pane topped by that side's lane colour from the graph cache (invariant 5: the colour is Rust's answer to give). Two tests pin it separately for merge and rebase, because the rebase case is the whole point — `ours` is the branch you are rebasing **onto**. | `05-merge.md` §5 |
| ~~C5~~ | ✅ **FIXED.** Both sites now build their menu from one function, `lib/dropMenu.ts` — the same gesture must not behave differently depending on where it lands, and one shared builder is also what made C6 a single change rather than two. | `05-merge.md` §3 |
| ~~C6~~ | ✅ **FIXED.** `refs::merge_relation` answers it; the row is disabled rather than hidden when it is impossible, and the menu says "already contains" when there is nothing to merge — an empty menu on a completed drag reads as a bug. When the lookup *fails* the option stays enabled: hiding a legal action because we could not ask is worse than offering one git will refuse with a clear message. | `05-merge.md` §2, §6 |
| ~~C7~~ | ✅ **FIXED.** `classifyFailure` recognises it, and the toast leads with the fact that decides what happens next: **the stash was kept**. | `04-pull.md` B3 |
| ~~C8~~ | ✅ **FIXED.** `BranchInfo.upstreamGone` separates "configured but the tracking ref is gone" from "never had one" — `branch.upstream()` fails in that state, so the configured name is read from config to keep it nameable and `ahead`/`behind` go null rather than lying. The row is tagged `orphaned`, and its menu offers both recoveries: only the user knows whether the branch is finished or the deletion was a mistake. | `04-pull.md` §5 |

## 4. Visual / feedback polish — four left

Closed since this list was written:

- ~~**WIP row is not on the lane.**~~ ✅ P8 item 1: `graph::wip_rows` computes the lane and the
  colour in Rust (invariant 5), and each dirty worktree gets its own dashed node on it.
- ~~**Commit-message column shows the subject only.**~~ ✅ `build_rows` appends the first
  non-blank body line, and the column autolinks issue references (G20).
- ~~**No "picked" flash / no highlight flash on the new HEAD row after checkout.**~~ ✅ The HEAD
  row flashes once when HEAD *changes* — skipped on first paint, because opening a repository is
  not a checkout and a flash on load reads as a glitch. Honours `prefers-reduced-motion`.
- ~~**Squash/fixup rows are not visually attached.**~~ ✅ Indented, with a `↳` handle and a
  connector, and every row carries its author's avatar.
- ~~**`Pop` is enabled with no stash.**~~ ✅ Disabled, with a tooltip naming the stash it would
  pop. "No stashes to pop" as an error toast is the app telling the user off for pressing a
  button it offered them.
- ~~**No busy-gating.**~~ ✅ The toolbar's mutating controls grey out while a checkout runs, and
  `smartCheckout` refuses re-entry outright. The refusal is the load-bearing half: a greyed
  button does not stop a context menu or a double-clicked ref pill.
- ~~**Rebase onto an ancestor toasts "Rebased 0 commit(s)".**~~ ✅ "Already up to date", in both
  the graph and the sidebar path.
- ~~**Merge commits are silently excluded from the interactive plan.**~~ ✅ Reported with
  `isMerge` and listed greyed in the editor, while still kept out of the todo file — `git
  rebase -i` without `--rebase-merges` never had them in its own list.

Still outstanding:

- **No progress on a cherry-pick sequence** ("Cherry-picking 3 of 7…"); the whole list is one
  `git cherry-pick` invocation, so there is nothing to report per commit. Either drive the
  sequence commit-by-commit or drop the requirement. **Still undecided**, and deliberately so:
  driving it per commit would mean owning the sequencer's restart semantics, which is a larger
  change than the progress bar is worth.
- **No "picked" flash on the source commits** after a cherry-pick. The flash mechanism now
  exists (it is what the HEAD row uses); this is one call site away.
- **No remote-pill animation** after a push.
- **No in-progress ghosting** of not-yet-replayed commits during a rebase (`06-rebase.md` B4).
  The one genuinely hard item left here: the graph has no representation of "a commit that will
  exist", and inventing rows for them collides with `search_commits` returning row indices
  (`08-search-and-filter.md` B3) — the same constraint that kept WIP rows out of the row list.
- **Toolbar buttons do not spin.** Progress and Cancel live in the status bar instead of a
  bottom-left toast — a deliberate, better placement; the requirement now says so.

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

P8 item 1 and terminal links added 14 more: `core/worktree.rs` (main worktree listed and
current decided by working directory — including from *inside* a worktree — remove deletes both
halves, remove refuses a dirty worktree unless forced, add attaches an existing local branch
instead of copying it, add on a remote branch creates a tracking local one), `core/graph.rs`
(a WIP row lands on its own HEAD's lane across a fork; a headless one falls back rather than
disappearing), `core/repo.rs` (open reports the linked worktree it was pointed at) and
`core/terminal.rs` (the four kinds a terminal prints, a range revealing its right end, prose
and filenames staying inert, trailing punctuation). The worktree fixtures put their worktrees
in a dedicated `TempDir`: a first version used fixed names under the shared system temp root
and two concurrent `cargo test` binaries collided on it.

P1 added 11: `core/remote.rs` (list with tracking-branch counts, duplicate refusal leaving the
original URL intact, rename moving the tracking refs, option-shaped URL rejected),
`core/repo.rs` (init unborn / already-a-repo / bare) and `shellout.rs` (clone copies history and
wires up origin, `--depth` truncates, `--depth=0` is dropped rather than forwarded, and a
`--upload-pack=` URL is read as a URL rather than executed). What P1 does **not** cover: the
start screen, the clone form, the tab store and the remote sidebar are all frontend, and the
per-tab selection restore and the Start-tab-is-the-floor rule are exactly the kind of state
machine the argument below is about.

Search added 25 Rust tests — a behavioural test per operator family against a fixture repo,
plus the argument-injection guard (one assertion per operator), the two-walk subtraction for
`message:` + `-message:`, cache invalidation on a branch move, and hit ordering with page hints.
What it does **not** cover: `page_hint` against a real 2000-row page boundary, and the pickaxe
cancellation path (the SIGTERM branch is exercised by no test — killing a child mid-walk
deterministically needs a fixture big enough to still be running).

~~There is still no frontend test runner (P7).~~ **There is now**, and the argument this
paragraph made was right in a way it could not demonstrate. P7 added Vitest + Testing Library +
jsdom and **154 tests**, covering the session store's tab rules and recent-repo migration, the
search store's three modes and hit navigation, the settings store, `lib/keys`, `refname`,
`cloneurl`, `terminalLinks`, `DialogHost`, and the two things §1.1 and §1.2 each closed by
naming them "still unverified by machine": **the mutation seam** and **`net.ts`**.

Writing them found four real defects, each fixed with the test that caught it:

- **`HEAD^` in terminal output produced a link to the wrong commit.** `REVISION`'s trailing
  `\b` cannot match after `^`, so the regex fell back to a bare `HEAD` — which resolves, to
  something else. `(?!\w)` instead.
- **Escape did nothing on a confirm or a choice dialog.** `onKey` is bound to the dialog
  element, and focus never entered it: a prompt got focus through its input, and the other two
  kinds have no input to land in. The container is focused on open now, which also makes
  `aria-modal` true in practice rather than only in markup.
- **The settings store never adopted the backend's clamped values.** Its in-flight guard tested
  the timer handle, which is cleared as the write starts, so the check was always true. A write
  token instead.
- **`isTypingTarget` could return `undefined`** where its signature promised a boolean.

What the frontend suite still does **not** cover: `GraphView` and `Sidebar` (the two largest
components, both needing a virtualizer and a query client to render), `lib/checkout.ts`'s
collision-recovery dialog flow, and the diff renderer. E2E (P7) is unstarted, so no test in
either suite drives the real app.

**P8 added 55 Rust tests (107 → 162) and 50 frontend tests (154 → 204.)** What they pin, and why
each was worth a test rather than a look:

- `core/history.rs` (6) — the `--follow` rule stated both ways round: plain history *stops* at
  the rename and followed history does not. The `-L` range mapping gets its own tests for the
  case a fixed-window filter would get wrong (an insertion above the range moves it) and for
  following a range across a rename.
- `core/blame.rs` (2) — the age ramp is per-file, and an unattributed line (timestamp 0) must
  not drag it back to the epoch and flatten every real line into the coldest bucket.
- `core/autolink.rs` (8) — remote-URL parsing is where this goes quietly wrong: the scp form
  `git@host:o/r.git` parses as a URL with scheme `git` and an empty host. The rule that keeps
  autolinks trustworthy is also pinned: **no built-in pattern for a host we do not know**, since
  a link that 404s is worse than plain text because the user follows it.
- `core/contributors.rs` (5) — a co-author is listed without being credited a commit, or the
  list disagrees with `git shortlog`; identities merge on the lowercased email and keep the
  newest spelling of the name.
- `core/refs.rs` (5) — merge-target resolution, "a branch is not its own merge target", the
  fast-forward relation, and the orphaned-upstream state.
- `core/graph.rs` (2) — the sync sets cover exactly the divergence, and **no upstream marks
  nothing**: marking every commit unpushed is true of a never-pushed branch and misleading
  everywhere else.
- `core/rebase_predict.rs` (7) — including the two cases a naive per-commit check misses (a
  dropped prerequisite, a reorder) and one that is pure discipline: prediction moves no ref,
  leaves `RepositoryState::Clean`, and leaves no conflicts in the index.
- `core/advanced.rs` (6) — conflict-region parsing including an *empty* side (delete/modify,
  which must still produce a region), and the C4 fix pinned separately for merge and rebase
  because the words swap meaning between them. Plus merge commits surviving `rebase_commits`.
- `core/settings.rs` (2), `core/diff.rs` (2), `core/identity.rs` (5), `core/worktree.rs` (2) —
  column-list sanitising, batched commit stats (including that one bad oid does not blank the
  column for the other thirty-nine rows), `commit.template` comment stripping, and the detached
  worktree leaving no branch behind.
- Frontend: `lib/autolinks` (8), `lib/dropMenu` (5), `lib/undoToast` (7), `lib/coauthors` (6),
  `lib/refname`'s folder validator (4), `stores/detailStack` (7), and 11 more in
  `features/network/net` for the three new failure recoveries.

Still uncovered, and worth naming: `ConflictPanel`'s cross-file navigation and the graph's
column rendering are both component-level and share the gap above.

---

## 6. GitLens-derived criteria — closed with P8

Folded in from `gitkraken/vscode-gitlens` (`00-overview.md` §0 explains why it counts as a
GitKraken reference, and §8 records what was ruled out). This was the backlog the specs grew,
listed in one place so the unchecked boxes scattered through seven docs were countable. It is
kept as a record rather than deleted: what each item cost, and where it deviated, is the part
that does not survive in the code.

| Doc | New criteria | State |
|---|---|---|
| ~~`08-search-and-filter.md`~~ | ~~15 — the whole doc~~ | ✅ **Done in P5.** `core/search.rs`, `search_commits` / `cancel_search`, `SearchBar`, `stores/search.ts`, `ScrollMarkers`. 25 tests. The minimap and contributor autocomplete followed in P8; `file:` path autocomplete is the only remainder (that doc's §7.1). |
| ~~`00-overview.md`~~ | columns · Changes column · minimap · scroll markers · `+N` overflow · ghost refs · detail sheets · WORKTREES + CONTRIBUTORS · sidebar-scopes-the-graph · jump-to · date style · terminal links · autolinks · rich hovers · blame heatmap · follow renames · revision navigation · guided palette | ✅ **All but `+N` ref overflow and ghost refs on hover.** The column model is a persisted preference (`settings.graphColumns`), not session state — the old `graphOpts.showAuthor` was exactly the second source of truth the conventions forbid, and it is gone. The **Changes** column is the only one that is not free (a diff per row), so it is off by default and fetched per *visible window*, rounded to a block so dragging the scrollbar is not a fetch per frame. |
| ~~`01-commit.md`~~ | 5 — per-worktree WIP row · co-author picker · `commit.template` · autolinks in preview · stash / copy-to-worktree | ✅ **Four of five.** The WIP row carries one recorded deviation: clicking another worktree's row **opens that worktree as a tab** rather than opening the commit panel on it — a different worktree has a different index, and this tab's handle cannot stage into it honestly. Stash / copy-to-worktree from the panel headers is the one left. |
| ~~`02-checkout.md`~~ | 5 + §7 — `/` finder · remote branches in the palette · Open in worktree… · worktree-holds-branch dialog · sidebar worktree management | ✅ **All but the `/` branch finder.** B8's detached case needed a scratch reference (git2's `WorktreeAddOptions` insists on one) that is deleted after the worktree's HEAD is moved off it — which is what git does internally; a test asserts no `mtgit-worktree-*` branch survives. The holds-branch dialog names the worktree via `worktree_holding` and offers to open it. |
| ~~`03-push.md`~~ | 2 — unpushed row markers · worktree-aware push target | ✅ **Both.** The push target fell out of G18 for free; the markers come from `graph::sync_sets`, which walks the divergence rather than history. |
| ~~`04-pull.md`~~ | 3 — unpulled row markers · jump-to controls · merge-target resolution + display | ✅ **All three.** The resolution rule git does not have is documented at `refs::merge_target` rather than spread across the UI: config override, the remote's advertised default, then a conventional name — and a branch is never its own merge target. |
| ~~`05-merge.md`~~ | 3 — unified conflict panel · cross-file region navigation · ref-labelled take-side | ✅ **All three**, and they subsumed C4 as predicted. |
| ~~`06-rebase.md`~~ | 3 — conflict prediction · unified panel mid-plan · undo from the completion toast | ✅ **All three.** Prediction was indeed the one new algorithm. Two findings worth keeping: conflicts **cascade** (reordering two commits that touch one line predicts two conflicts, because git stops twice), and "writes nothing" turned out to be not quite true — unreferenced tree objects are written, because git2's merge takes `Tree` handles. Both are stated in the module doc rather than glossed. |
| ~~`07-cherry-pick.md`~~ | 3 — search-fed multi-pick · unified panel · worktree composite action | ✅ **Two of three.** The worktree composite action is the remainder. |

**Dependency order, as it actually played out:**

1. ~~**Worktrees in the graph**~~ ✅ — and it did unblock four docs, exactly as predicted:
   `03-push.md`'s worktree-aware push target needed nothing more once a worktree could be a tab.
2. ~~**The unified conflict panel**~~ ✅ — it subsumed C4 and unblocked both rebase items, again
   as predicted. The part the plan did not anticipate: the panel's region cursor has to be
   computed from the **live textarea**, not from `conflict_set`'s list, because the user edits
   the text and a cursor keyed to the server's copy points at a region that no longer exists.
3. ~~**Search**~~ ✅ — select mode hands every hit to the range operations, so cherry-picking or
   planning a rebase over a search result is one gesture.
4. ~~**Everything else, opportunistically**~~ ✅ — and the "cheap wins" ordering held. Terminal
   links were the best value-per-hour item; `--follow` was the most *valuable*, because it is a
   correctness fix: history that stops at a rename reports the wrong author for the code, which
   is a confident wrong answer rather than a missing feature.

### 6.1 What was ruled *out*, so it is not re-proposed

`00-overview.md` §8.2 and §8.3: Git CodeLens and caret-line blame (no editing surface here),
VS Code view/layout management, the treemaps and Visual File History (each a feature-sized
project), and the whole `plus/` half — Launchpad and PR panels, agent sessions, GitKraken MCP,
Cloud Patches, Cloud Workspaces, and every AI feature including Automatic Rebase. That last
group is also non-MIT in GitLens's own repo, which is a second reason not to treat it as a
reference implementation.
