# MTGit — GitKraken Parity Plan

Goal: close the gap between MTGit today and **GitKraken's core feature set**, with a UI/UX
that reads as the same product family.

**"GitKraken" here means the family, not one product.** Two GitKraken products ship the same
Commit Graph: **GitKraken Desktop**, the standalone client this plan started from, and
**GitLens** (`github.com/gitkraken/vscode-gitlens`), its git extension for VS Code. GitLens
matters to us out of proportion to its form factor for one reason: it is *readable*. Everything
in that repo outside a directory named `plus/` is MIT-licensed, so its search grammar, column
model, conflict panel and rebase editor can be specified from source instead of inferred from
screenshots — which is what §2.6 and P8 below are built on. Everything under `plus/` (Launchpad,
the AI features, agent sessions, Cloud Patches) is under `LICENSE.plus`, is not MIT, and is
listed in §2.5 as deferred. Matching behaviour is free; copying MIT *code* still owes
attribution, so cite the file in a comment if you ever do.

Where the two references disagree, **Desktop wins on shell and gesture, GitLens wins on grammar
and detail**. `docs/feature-requirements/00-overview.md` §8 is the authoritative list of which
GitLens features are in scope, adapted, or out — decided once there rather than per PR.

This plan supersedes neither `PLAN.md` (the original MVP roadmap, now largely delivered) nor
`VERIFY_HARDEN_PLAN.md` (P0/P1 hardening, cleared). It started from what was actually in the
tree and describes work that was *not yet done* at the time of writing; phases are struck
through and annotated as they land.

---

## 1. Baseline — verified state of the repo

> **Status: P0–P5 complete against `docs/feature-requirements/`** (audited 2026-09-08 —
> read `docs/feature-requirements/STATUS.md` for the per-criterion verdict and the outstanding
> gaps). **P5 closed with commit search (G10)**, the last item in it; **P1 (clone / init /
> remote management / start screen / tabs) landed 2026-09-11** and closed G1–G4 and G12.
> **P6 landed 2026-09-11** (settings file, both themes, keybinding registry, SVG icon set),
> closing G13–G15; **P7 is half in** — CI and a frontend suite exist, e2e and signing
> do not. **P8 is complete as of 2026-09-11** — all six items, closing G16–G28. Sections 2.4
> and 4/P0 record the P0 work; the P2–P5 sections below
> describe what was intended, not what shipped — where the two differ, STATUS.md is the record.
>
> **Revised after the GitLens pass:** §2.6 adds G16–G28 (gaps visible only once GitLens is
> treated as a reference) and P8 sequences them; §2.5 grew to cover GitLens's account-gated
> tier. The old "P2 is next" marker in §8 was stale — P2 through P5 had already landed — and is
> corrected. Nothing in §2.1–§2.4 changed: the GitLens material is additive, and the P0 defect
> record stands as written.

Measured, not assumed: `pnpm exec tsc --noEmit` exits 0, `vite build` succeeds, `cargo clippy
--all-targets -- -D warnings` is clean, and `cargo test` reports **40 passed, 0 failed,
0 ignored** at the time of that audit — the 50k-commit perf gate runs in the default suite.
The suite is at **78 passed** after P5's search (25 tests for the grammar and its git mapping)
and P1 (11 for clone, init and remote management), at **92** after P8 item 1 and terminal
links (9 for worktrees and WIP-row placement, 5 for token resolution), at **107** after P6
(7 for the settings file, 7 for git identity, 2 for the diff whitespace option), and at
**162** after the rest of P8 — `STATUS.md` §5 lists what those 55 pin and why each needed a
test rather than a look.

**There is now a frontend runner too.** P7 added Vitest; the suite is at **204 tests** after
P8. The gate is five commands rather than four:

```
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings
cd .. && pnpm exec tsc --noEmit && pnpm check:ipc && pnpm test && pnpm build
```

~13k lines across `src/` + `src-tauri/src/`.

**The perf gate no longer flakes.** `perf_50k_commits_under_500ms` was a single wall-clock
sample taken while `cargo test` saturated every core with the other 77 tests, and it measured
the machine's load as much as the layout: the same build was observed at 269 ms alone and
605 ms under load, failing a 500 ms budget nothing had regressed against. It now takes the
**best of up to three** runs and stops at the first clean one, which keeps the gate meaningful
— a real regression is slow in all three — at the cost of one extra layout on a loaded run.
This discharges the P0 carry-over that said to revisit it when CI lands.

**Already working end-to-end:**

| Area | Status |
|---|---|
| Graph | Rust lane layout (`core/graph.rs`) with tests for linear, fork/merge, octopus, orphan roots, edge-target validity. Canvas edges + virtualized DOM rows, avatar-in-node, ref badges, relative dates, WIP row. |
| Commit detail | Author/date/sha/message, changed-file list with **Path/Tree toggle**, per-file diff. |
| Diff | Structured hunks from Rust, inline **and** split modes, intra-line word diff, Shiki highlighting with a 2k-line guard, binary/large-file guards. |
| File tooling | Blame (`core/blame.rs`), file history (`core/history.rs`), file-at-commit viewer. |
| Staging | Whole-file stage / unstage / discard, commit, amend, dirty-tree WIP row. |
| Branch ops | create / rename / delete (with unmerged-branch force guard) / checkout (remote → local tracking branch), merge (default / no-ff / ff-only), drag-branch-onto-branch merge. |
| History ops | cherry-pick, revert, reset (soft/mixed/hard), rebase **with continue + abort**, format-patch. |
| Refs | Tags (lightweight + annotated), worktrees (list + add), stash (save/list/apply/pop/drop). |
| Network | fetch / pull / pull --rebase / push / push --force-with-lease / fetch --prune / push --delete, via system `git` with streamed `git-progress` → status bar. |
| Shell | Toolbar, collapsible sidebar + icon rail, repo tabs, xterm terminal panel, ⌘K palette, toasts, promise-based dialogs with ref-name validation, persistent conflict banner. |

**Infrastructure that does not exist yet:** no CI, no `.github/`, no frontend test runner
(no Vitest), no e2e, no packaging/signing/updater config, no settings persistence beyond
`localStorage` recent-repos.

---

## 2. Gap analysis vs the GitKraken family

§2.1–§2.5 are the original analysis against **GitKraken Desktop**, grouped by how much it hurts
a user who switches from it to MTGit today. §2.6 adds the gaps that only become visible with
**GitLens** as a second reference. Gap IDs are stable — G1–G15 are Desktop, G16–G28 are GitLens.

### 2.1 Blocking — a GitKraken user cannot start work — ✅ **all closed in P1**

| # | Gap | Detail |
|---|---|---|
| ~~G1~~ | ~~**No Clone**~~ ✅ **closed in P1** | `clone_repo` shells out to `git clone --progress` (auth, SSH agent and proxy come free, per invariant 6), with a clone form carrying URL validation, a target-dir picker, recurse-submodules, shallow depth and a single-branch option, and a progress bar fed by the existing `git-progress` stream. Provider browse stays out — that is §2.5 provider integration. |
| ~~G2~~ | ~~**No Init**~~ ✅ **closed in P1** | `init_repo(path, bare)` via git2, reached from the start screen; it refuses a directory that is already a repository rather than silently reinitialising it. |
| ~~G3~~ | ~~**No start/welcome screen**~~ ✅ **closed in P1** | `features/start/StartScreen.tsx`: Clone / Open / Init cards plus a filterable recent list showing name, path, branch and last-opened. Recent repos grew from a `string[]` to a record (with a migration), because the list has to draw without opening anything. |
| ~~G4~~ | ~~**No remote management**~~ ✅ **closed in P1** | `core/remote.rs` (list / add / remove / rename / set-url, all git2 — these are config edits, not network calls). The sidebar's REMOTE section is now one node per remote with a per-remote menu (fetch, copy/edit URL, rename, remove), and the push dropdown lists remotes as push targets. |

### 2.2 Core workflow holes

| # | Gap | Detail |
|---|---|---|
| G5 | **No hunk / line staging** | The single most-used GitKraken feature. Backend has no `stage_hunk`; UI stages whole files only. |
| G6 | **No conflict resolution editor** | GitKraken ships a 3-pane merge tool. MTGit surfaces conflicts and offers Abort/Continue — correct, but the user must leave the app to resolve. |
| G7 | **Thin commit form** | One textarea. Missing summary/description split, 50/72 guidance, amend-message prefill, co-author trailer, commit template, GPG signing toggle, "stage all and commit". |
| G8 | **No interactive rebase** | No reorder / squash / fixup / drop / edit / reword. |
| G9 | **No undo/redo** | Toolbar buttons are hardcoded `disabled`. GitKraken's undo is a signature safety feature. |
| ~~G10~~ | ~~**No commit search / filter**~~ ✅ **closed in P5** | GitLens's grammar, parsed in Rust (`core/search.rs`), with highlight / filter / select modes, hit navigation across unloaded pages, scroll markers, and `ref:` as the branch-scoped ("solo") view. The minimap and contributor autocomplete followed in P8; `file:` path autocomplete is the only remainder — `docs/feature-requirements/08-search-and-filter.md` §7.1. |

### 2.3 Interaction fidelity

| # | Gap | Detail |
|---|---|---|
| G11 | **Graph drag-and-drop is half-built** | Sidebar branch→branch merge works. GitKraken also supports dragging a *branch/commit onto a graph row* and choosing merge / rebase / reset / cherry-pick from a drop menu, with a live drop-target pill. |
| ~~G12~~ | ~~**Tabs are second-class**~~ ✅ **closed in P1** | The strip is always visible, `+` opens the Start tab, middle-click closes, tabs drag to reorder, and per-tab selection is restored by the session store rather than discarded. The Start tab is a first-class member of the strip: it is the app's floor (it cannot be closed when nothing else is open) and `repo === null` exactly while it is active. |
| ~~G13~~ | ~~**Two keyboard shortcuts total**~~ ✅ **closed in P6** | `lib/keys.ts` is the registry: 14 actions, chord parsing and formatting, override resolution, and a conflict check. Every handler in the app asks `matches(event, id)` instead of reading the event itself, so the `?` cheat sheet and the rebinding UI are renders of the registry rather than second copies of it. |
| ~~G14~~ | ~~**No settings screen**~~ ✅ **closed in P6** | A tabbed panel (General / Appearance / Git / Terminal / Shortcuts) over `core/settings.rs`, a JSON file in the platform config dir. Theme, density, font size, date style, diff defaults, default clone dir, auto-fetch interval, terminal font and shell, keybindings — and git identity at both levels, which is written to git's own config rather than kept here. |
| ~~G15~~ | ~~**Dark theme only**~~ ✅ **closed in P6** | Two complete token sets per §3.1, with a system / light / dark selector. The work was not only the light block: six stylesheets reached for tokens that were never defined, using a hardcoded *dark* fallback, and would have stayed dark whatever the theme said. |

### 2.4 Correctness / performance defects found while reading — **all fixed in P0**

| # | Defect | Location | Impact | Status |
|---|---|---|---|---|
| D1 | **Graph cache keyed on HEAD oid only** | `commands.rs:get_graph` — `needs_rebuild = cached.head != head` | After a `fetch`, a branch create, a tag, or a remote-ref update, HEAD is unchanged, so the cached rows and ref badges are served stale. `repo-changed` invalidates the *frontend* query, which then gets the same stale rows back. **Fix: key on a digest of all refs + HEAD.** | ✅ `graph::refs_digest()` (FNV-1a over sorted `refs/**` + HEAD) is the cache key; `CachedGraph.head` → `.key`. Cache logic extracted to a testable `graph_page()`. |
| D2 | **Backend pagination is never used** | `GraphView.tsx:useGraphData` calls `getGraph(path, 0, 1_000_000)` | The whole history crosses IPC and is held in JS on every repo open. `core/graph.rs` already supports `skip`/`limit`. The 50k-commit perf test is `#[ignore]`d, so this is unmeasured. | ✅ `useInfiniteQuery`, 2000-row pages, 400-row prefetch margin off the virtualizer’s last visible index. Perf gate un-`ignore`d. |
| D3 | **Watcher has no self-op suppression** | `watcher.rs` | 300ms debounce is in place, but a checkout of a large branch still fires a refresh storm; the watcher is not paused during MTGit's own operations (a documented mitigation in `PLAN.md` §4.4 that was never implemented). | ✅ `OpSuppressor` in `state.rs`: in-flight count + 600ms post-op quiet window, held via an RAII `OpGuard` by 24 mutating commands. |
| D4 | **`shellout::run` reads stderr to EOF before stdout** | `shellout.rs` | A `git` op that fills the stdout pipe while stderr stays open can deadlock. Needs concurrent draining (a thread per pipe, or `wait_with_output` after spawning a stderr reader thread). | ✅ `drain()` reads stdout on a thread while streaming stderr on the caller’s. The old ordering was confirmed to hang on the regression fixture. |
| D5 | **Push has no upstream handling** | `Toolbar.tsx:net("push")` | A branch with no upstream fails with a raw git error instead of offering `--set-upstream`. | ✅ Backend `push_target()` + a shared `features/network/net.ts`; an unpublished branch gets a “Publish branch” prompt instead of a raw git error. |

### 2.5 Deliberately deferred (post-parity)

Provider integration (GitHub/GitLab/Bitbucket PR + issue panels), LFS UI, submodule UI,
sparse checkout, GPG key management, cloud workspaces, AI commit messages. These are
GitKraken features but not *core git client* features; they are listed here so the boundary
is explicit rather than accidental.

**GitLens's account-gated tier lands in the same bucket, and almost exactly maps onto it.**
Everything GitLens puts behind a sign-in is also everything under its non-MIT `plus/` tree:
**Launchpad** (cross-repo PR triage) and the in-graph Pull Requests panel, **agent sessions**
and the Agent Kanban, **GitKraken MCP**, **Cloud Patches**, **Cloud Workspaces**, and the AI
features — Review Changes, Compose / Recompose Commits, Explain Changes, Generate Commit
Message, Generate Stash Message, Generate PR Title/Description, Generate Changelog,
**Automatic Rebase** (AI conflict resolution), and natural-language graph search. Each drags in
an account system, a network boundary, or a model provider; none is a git operation.

Two are worth naming as the first candidates if that boundary ever moves, because they need no
account of ours and no new data: **Generate commit message** and **Explain changes** are single
prompts over a diff `core/diff.rs` already produces. Also deferred but *not* for licensing
reasons — they are simply feature-sized projects of their own — are GitLens's **Visual File
History** timeline and its three **treemaps** (files, commits, agent activity).

### 2.6 Gap analysis vs GitLens

Gaps that only become visible once GitLens counts as a reference. G10 (commit search) is
already above; GitLens does not add it, it *specifies* it — the grammar in
`docs/feature-requirements/08-search-and-filter.md` was read out of GitLens's source, which
turns G10 from a design problem into an implementation one.

| # | Gap | Detail |
|---|---|---|
| ~~G16~~ | ~~**Graph has three fixed columns**~~ ✅ **closed in P8 item 3** | Author / Changes / Date / SHA, toggleable and reorderable from the gear popover, persisted in `settings.graphColumns` — a preference, not session state, which is why `graphOpts.showAuthor` is gone rather than wrapped. Reorder is ▲/▼ rather than header dragging: the popover is 200px wide and drag inside it would fight the graph's own row dragging. Changes is the one column that costs a diff per row, so it is off by default and fetched per visible window in 50-row blocks. |
| ~~G17~~ | ~~**No minimap**~~ ✅ **closed in P8 item 3** | The markers landed with P5's search; the minimap followed. It is a *density* strip beside them, shown only while a search is submitted — "where are my matches clustered" has no answer when nothing is searched for. Bucketed and shaded by count, because at 12,000 commits in 600px each pixel row is twenty commits and one mark per hit loses every cluster to overlap. |
| ~~G18~~ | ~~**Worktrees exist in the backend and nowhere in the UI**~~ ✅ **closed in P8 item 1** | The sidebar WORKTREES section lists every worktree — main included, which `Repository::worktrees()` omits — with add, open-as-a-tab and remove; "Open in worktree…" sits beside Checkout on branch menus and graph rows; the toolbar names the linked worktree the tab is in; and each *dirty* worktree gets its own WIP row on its own HEAD's lane. Backend grew `remove`, a main-worktree-aware `list`, and ref-aware `add`. |
| ~~G19~~ | ~~**No terminal links**~~ ✅ **closed in P8 item 6** | It was the regex plus a call into the graph-selection path this row predicted, with one correction: the regex alone cannot tell "main" in a branch listing from "main" in a sentence, so candidates are extracted in `lib/terminalLinks.ts` and *resolved* by `core/terminal.rs` against the repository. A token only becomes a link when git can resolve it. Ranges reveal their right end; not-yet-loaded commits pull pages until they turn up. |
| ~~G20~~ | ~~**No autolinks**~~ ✅ **closed in P8 item 6** | `core/autolink.rs` reads per-repo patterns from config and adds a built-in `#` pattern **only** for hosts whose issue URL shape we know — a guess at an unknown host produces a link that 404s, and a broken link is worse than plain text because the user follows it. `lib/autolinks.ts` splits the text (longest match wins; no reference may start mid-word, so `#ff0012` stays a colour). Link out only, exactly as this row said. |
| ~~G21~~ | ~~**File viewer has no annotations**~~ ✅ **closed in P8 item 6** | The heatmap ramp is **per file** (`blame_file` returns an age bucket): "which lines here are recent" is the useful question, and an absolute scale renders an untouched file uniformly cold. One shared `CommitHover`, as this row asked — it fetches on hover rather than prefetching thousands of lines' worth, shares the commit panel's query key, and flips rather than clips near the bottom of a scroll container. The separate *recent-changes* annotation is not built; the heatmap and hover answer the same question. |
| ~~G22~~ | ~~**History does not follow renames; no revision navigation**~~ ✅ **closed in P8 item 6**, pulled forward as a correctness fix | `file_log(.., follow)` keeps the cheap pathspec walk and falls back to a full rename-detected diff only at the commit where the tracked path appears as `Added` — that is the only place a rename can hide, because a pathspec filters the old name out and makes the rename look like an add. `line_log` maps a range backwards hunk by hunk. Following defaults **on**: not following is not a cheaper view of the same answer, it is a wrong one. Revision navigation steps through the *file's* own versions, which on a busy repo is far from "the previous commit". |
| ~~G23~~ | ~~**No merge-target concept, no jump-to navigation**~~ ✅ **closed in P8 item 6** | Git has no config for "merge target", so the resolution rule is ours and lives at `refs::merge_target` rather than spread across the UI: an explicit config override, then `refs/remotes/<remote>/HEAD`, then the first conventional name that exists. A branch is never its own merge target. Jump-to is one control, not three buttons — the destinations are alternatives and only HEAD always exists. Per-row unpushed/unpulled markers came with it. |
| ~~G24~~ | ~~**Detail panel is a single slot**~~ ✅ **closed in P8 item 4** | Sheets with a crumb trail; compare is a sheet rather than a mode, and following a parent link is a detour that leaves the row you came from where it was. The base of the stack stays the graph selection rather than being copied into the new store — one question, one answer, which is the shape defect A1 had. |
| ~~G25~~ | ~~**Conflict resolution is a per-file mode**~~ ✅ **closed in P8 item 2** | One `conflict_set` call feeds a panel whose `n`/`p` cross file boundaries, with `conflict i of n · file j of k`. It did subsume C4: the panes are named by ref and tinted with each side's lane colour. The correction to this row is that naming the sides is not cosmetic — during a rebase `ours` is the branch you are rebasing **onto**, and two tests pin merge and rebase separately for that reason. |
| ~~G26~~ | ~~**Interactive rebase does not predict conflicts**~~ ✅ **closed in P8 item 5** | It was the only genuinely new algorithm, as predicted. `core/rebase_predict.rs` carries a base tree through in-memory three-way merges. Two corrections to this row: conflicts **cascade** (a reorder of two commits touching one line predicts two, because git stops twice), and "without moving any ref" is true but "writes nothing" is not — unreferenced tree objects are written, because git2's merge takes `Tree` handles. Both are stated in the module doc rather than glossed. |
| ~~G27~~ | ~~**Command palette is a flat action list**~~ ✅ **closed in P8 item 6** | Commands declare *steps*; the palette walks them with a breadcrumb, and Escape or Backspace-on-empty undoes the last choice rather than closing — closing is what Escape does at the first step, where there is nothing to undo. It also deleted the row-per-branch expansion that used to crowd out every real command, which is how it closed STATUS B7. |
| ~~G28~~ | ~~**No contributors view**~~ ✅ **closed in P8 item 6** | A collapsed sidebar section, capped with "show all" — a reference list, not a navigation tree, and four hundred contributors would push every other section off the screen. It does serve the two pickers this row named. Co-authorship is counted **separately** from authorship: someone with twenty co-authored commits and none of their own is a name worth offering in a trailer picker and a misleading entry in a "top committers" list. |

`docs/feature-requirements/00-overview.md` §8.2 records what was ruled **out** — Git CodeLens
and caret-line blame (MTGit has no editing surface), VS Code panel/layout management, the
treemaps and Visual File History. Read that before proposing any of them again.

---

## 3. UI/UX fidelity plan

Feature parity without visual parity will not read as GitKraken. Treat this as a track that
runs alongside the phases, not an afterthought.

### 3.1 Design tokens

`src/theme.css` currently holds a GitHub-dark-ish palette. Restructure it as:

- **Two complete token sets.** Define the full light palette on bare `:root`, redefine the same
  token names under `@media (prefers-color-scheme: dark)` guarded as `:root:not([data-theme="light"])`,
  and again under `:root[data-theme="dark"]` so an explicit toggle wins in both directions.
  Never give a color its only definition inside a media block.
- **Lane palette as its own token group.** GitKraken's graph identity is its lane colors —
  a saturated, evenly-spaced hue ring that stays legible on both grounds. `features/graph/palette.ts`
  should read CSS variables (`--lane-0` … `--lane-7`) rather than hardcoding hex, so themes
  can retune lanes.
- **Density tokens.** `--row-height` (28px now) should be switchable across compact / normal /
  comfortable, and `--lane-width` should follow it.
- **A heatmap ramp** (G21). Blame age needs a two-ended scale, not a lane colour: GitLens ships
  `#f66a0a` hot / `#0a60f6` cold as defaults. Define `--heat-hot` / `--heat-cold` and interpolate;
  do not reuse the lane ring, whose whole job is to be *categorical*, and which therefore reads
  as "different branch" rather than "older".

### 3.2 Layout

Target GitKraken's chrome, top to bottom:

```
┌─ tab strip ── [repo A] [repo B] [+] ───────────────────────────────────┐
├─ toolbar ── repo▾  branch▾  ⟳ │ ↶ ↷ │ Pull Push Branch Stash Pop │ ⚙ 🔍 ▥ ┤
├──────────┬─────────────────────────────────────────┬───────────────────┤
│ sidebar  │ graph  (BRANCH/TAG│GRAPH│MSG│AUTH│±│DATE)│ detail stack      │
│ Local    │  ◌ // WIP                            ▏│ │  ‹ back           │
│ Remote   │  ● merge feature into main           ▏│ │  avatar + author  │
│ PRs      │  ● fix: …                            ▏│ │  sha, date        │
│ Tags     │                            search hit ▎│ │  Files changed(N) │
│ Stashes  │                                       │ │   [Path|Tree]     │
│ Worktrees│                          scroll marks ↑│ │                   │
│ Contrib. │                          + minimap     │ │                   │
├──────────┴─────────────────────────────────────────┴───────────────────┤
│ terminal (collapsible)                                                 │
├────────────────────────────────────────────────────────────────────────┤
│ status bar — progress line, ahead/behind, HEAD                          │
└────────────────────────────────────────────────────────────────────────┘
```

Changes from today's shell:
1. **Tab strip always visible** with a `+` that opens the start screen in a new tab (G12, G3).
2. **Sidebar sections in GitKraken order** with per-remote grouping and provider icons (G4),
   plus WORKTREES and CONTRIBUTORS (G18, G28). Sidebar ref selection *is* the graph's `ref:`
   filter — one code path, two entry points, not two parallel filter mechanisms.
3. **Graph column headers become a real column model** (G16): draggable to reorder,
   right-clickable to toggle, with Author / Changes / Date / SHA available beyond the three we
   have. Plus a search field in the header (G10), scroll markers and an on-search minimap in
   the scrollbar gutter (G17), and a density control in the gear popover.
4. **Right panel becomes a stack** (G24): commit header → files → (optionally) inline diff,
   pushed as sheets with a back affordance so selecting a branch or opening a comparison does
   not destroy what the user was reading — with the center panel able to take over for
   full-width diff (GitKraken's "focus view").

### 3.3 Component-level details that carry the look

- **Ref badges → pills.** Rounded, filled pills; checked-out local branch gets the accent fill
  plus a HEAD marker; remote branches get a cloud/provider glyph; tags get the tag glyph.
  Overflow collapses to `+N` with a hover popover.
- **Graph nodes.** Keep the avatar-in-node (already done, and it is the most GitKraken-ish
  detail in the app). Add: hollow dashed node for the WIP row — **one per worktree** (G18) —
  larger ring on the selected row, hover-dimming of unrelated lanes so a commit's ancestry path
  pops, and **ghost refs on row hover**: the nearest containing branch/tag, dimmed, so a commit
  deep in a branch still says which branch it belongs to.
- **Ahead/behind markers per row** (G23). Rows between the upstream tip and the local tip are
  marked unpushed; rows a pull would bring in are marked unpulled. The push badge says *how
  many*; the graph says *which*, which is the question you have before a force push.
- **Edges.** Current bezier is right. Add merge-edge taper and make the color follow the
  *destination* lane consistently (already the intent in `graph.rs`; verify visually).
- **Drop affordances.** While dragging, show a floating pill under the cursor ("Merge `feat/x`
  into `main`") and highlight only legal targets; on drop, open a small action menu rather than
  committing to merge (G11).
- **Undo toast.** Every mutating action emits a toast with an inline **Undo** — this is how
  GitKraken makes destructive ops feel safe, and it is the natural UI for G9.
- **Empty/loading states.** Replace the three bare "Open a repository…" strings with the start
  screen and skeleton rows.

~~Replace the emoji-as-icons currently used throughout (`⑂ ⇩ ⇧ ▤ 🖥 ☁ 🏷 🌿 ≡`) with a single
inline-SVG icon set.~~ ✅ **done in P6.** `components/Icon.tsx` holds 25 shapes on a 16×16 grid,
stroked in `currentColor` — so an icon follows the accent fill of a selected row and gets the
light theme for free, which no emoji can. Two of the emoji were also standing in for meanings
they do not carry (🖥 for "local branches", ≡ for "stashes"). Keyboard glyphs (`⌘ ⇧ ⌥`) are not
icons and stay.

---

## 4. Phased roadmap

Each phase is independently shippable and ends with a stated exit condition.

### P0 — Fix the defects found above — ✅ **DONE**

Everything downstream is built on the graph and the shellout path, so this went first.

1. **D1** ✅ — `graph::refs_digest()` hashes every `refs/**` `name:target` pair (sorted) plus
   HEAD with FNV-1a; `CachedGraph` is keyed on it. The cache logic moved out of the Tauri
   command into a free `graph_page()` so it is testable without a `State`.
   Tests: `graph_cache_rebuilds_when_a_branch_moves` (poisons a cached row to *prove* the
   second call is a cache hit, then moves a branch without touching HEAD),
   `graph_page_honours_skip_and_limit`, plus two digest tests in `graph.rs`.
2. **D2** ✅ — `GraphView` uses `useInfiniteQuery` with 2000-row pages and a 400-row prefetch
   margin driven off the virtualizer's last visible index; a footer shows `N of M commits`.
   `perf_50k_commits_under_500ms` is un-`ignore`d.
3. **D4** ✅ — extracted `shellout::drain()`, which reads stdout on a thread while streaming
   stderr on the caller's. Test: `drain_does_not_deadlock_when_stdout_fills_the_pipe`
   (240KB on stdout before the first stderr line) — the pre-fix ordering was confirmed to
   hang indefinitely on that same fixture.
4. **D5** ✅ — backend `push_target()` returns `{branch, remote, hasUpstream}`, reading the
   upstream from **config** (`branch_upstream_name`, the condition git itself tests) and
   resolving the remote as upstream → `origin` → sole remote. Frontend push moved into a
   shared `src/features/network/net.ts`, which offers "Publish branch" before failing and
   falls back on git's own error text.
5. **D3** ✅ — `OpSuppressor` (in-flight count + 600ms post-op quiet window, comfortably past
   the watcher's 300ms debounce), held as an RAII `OpGuard` by 24 mutating commands. The guard
   arms the quiet window *before* decrementing the count so there is no uncovered instant.
   `create_patch` and the pty commands are deliberately unguarded — terminal-driven changes
   must still refresh.

**Adjacent fix:** the command palette's push/pull/fetch toasted success even when git exited
non-zero, because `gitNetwork` resolves with a `GitOpResult` rather than throwing. Both call
sites now go through `net.ts:runNet`, which is the single place that check lives.

**Exit — met:** the graph is keyed on the full ref set, so it cannot go stale after a fetch or
a branch op; a repo now transfers 2000 rows on open instead of its whole history; `cargo test`
is green (37 passed, 0 ignored) with the perf gate active, and clippy is clean at `-D warnings`.

**Carried into later phases:**
- The perf gate runs at **269ms against its 500ms budget** in a debug build on the dev machine
  and adds ~30s to `cargo test`. A slower runner could flake it — revisit when P7 stands CI up.
- Invalidating the graph query refetches *every* loaded page. The common (unscrolled) case is
  now 2000 rows rather than 50k, but deep scrolling trends back toward the old volume. Page
  boundaries stay consistent because each page refetches with its original `skip`.
- The 600ms quiet window also swallows genuinely external edits that land *during* one of our
  own operations. Documented on `OpSuppressor`; revisit if it is ever felt in practice.
- D2 and D5 are typechecked and built but were not clicked through in the running app.

### P1 — Repo lifecycle + start screen — ✅ **DONE** → closed G1–G4, G12

Shipped as specified. What landed, and the four decisions worth knowing before touching it:

- **Backend.** `clone_repo` (shellout), `init_repo` (git2), and `core/remote.rs` —
  `list_remotes` / `add_remote` / `remove_remote` / `rename_remote` / `set_remote_url`.
  Clone could not go through `shellout::run`: that path is `-C <repo>` and accepts
  fetch/pull/push only, and a clone has no repository to run inside. It reuses `drain()`, so
  it inherits D4's concurrent-pipe fix rather than re-introducing the deadlock.
- **Clone rejects; it does not resolve with a failed `GitOpResult`.** Every other network op
  reports into a repository already on screen, and invariant 8's `.success` check exists for
  them. A half-finished clone is not a repo the user can be dropped into, so the only useful
  outcomes are a `RepoInfo` or an error carrying git's own last three lines — the ones that
  name the real problem (auth, DNS, a non-empty directory).
- **Two guards on user-typed values reaching a real `git` command line.** The URL and the
  destination go after `--`, and `core/remote.rs::check_url` rejects a leading `-` outright, so
  `--upload-pack=<command>` is a bad URL rather than an executed command. This is the same
  class as P5's search guard and is pinned by the same kind of test
  (`a_url_that_looks_like_an_option_is_treated_as_a_url` asserts the payload did **not** run).
- **A failed clone removes only a directory it created itself.** git cleans up after a failed
  clone but not after being killed, and Cancel kills it — leaving a husk that turns "cancel,
  fix the URL, retry" into "already exists and is not empty". The cleanup is scoped to a
  destination that did not exist before the call, so nothing of the user's can be caught by it.
- **Remotes come from `list_remotes`, not from ref-name prefixes.** A remote with no fetched
  branches is exactly the one the user needs to see — the one they just added. Prefixes with
  no configured remote still render, badged "not configured": those are tracking refs left by
  a removed remote, and hiding them would make refs the graph still draws unreachable from the
  sidebar.

Also closed on the way past, because P1 built the thing they were blocked on: **STATUS B3**
("Fetch \<remote\>" on a remote node, and "Pull (fast-forward)" on the checked-out branch) and
**STATUS B4** (the push dropdown lists remotes as targets). **STATUS C1** — the full publish
dialog with a remote selector and an editable remote branch name — did **not** land; publish is
still the yes/no confirm `net.ts:publish` puts up.

**Exit — met:** a user can clone a repo from a URL, init one, manage its remotes and work,
without ever using the CLI. Not clicked through in the running app: `cargo test` (78),
`clippy -D warnings`, `tsc --noEmit` and `vite build` are all green, and the IPC registry was
checked against all four layers of invariant 1 by script, but there is still no frontend test
runner (P7) and no e2e.

### P2 — Hunk and line staging — ✅ **DONE** → closed G5

The highest-value single feature in the plan. Shipped as `applyPatch` plus per-hunk and
per-line UI; `docs/feature-requirements/01-commit.md` §3.3 is the current spec, and STATUS §5
records the test coverage this still owes (CRLF, no-trailing-newline, added-lines-only).

- Backend, hunk level: use git2's `Repository::apply` with `ApplyLocation::Index` and an
  `ApplyOptions` **hunk callback** that accepts only the selected hunk indices. Reverse the
  same call for unstaging. New commands:
  `stage_hunks(file, hunk_ids)`, `unstage_hunks(file, hunk_ids)`, `discard_hunks(file, hunk_ids)`.
- Backend, line level: git2's hunk callback cannot subset lines, so synthesize a patch buffer
  from the selected `DiffLine`s (recomputing hunk headers) and pipe it to
  `git apply --cached [--reverse]` on stdin. Keep this behind the same command surface with a
  `lines: Option<Vec<LineId>>` field.
- Frontend: stage/unstage/discard buttons per hunk header, click-drag line selection in the
  gutter, "stage selection" action, keyboard `s`/`u`/`d` on the focused hunk.
- Tests: stage-one-of-three-hunks, stage-added-lines-only, reverse-unstage round-trip,
  CRLF file, file with no trailing newline.

**Exit:** a mixed-change file can be split into two commits entirely in the UI.

### P3 — Commit experience + undo — ✅ **DONE** → closed G7, G9

Shipped as summary/description, amend, hook handling, and the undo/redo journal. Its three
leftovers — the co-author picker, `commit.template` (G7's last two items, now criteria in
`01-commit.md`) and the inline Undo on mutation toasts (§3.3) — were **closed by P8 item 6**.
`commit.gpgsign` passthrough with a per-commit toggle is still the one unbuilt line below.

- Commit form: summary input (with 50-char soft counter) + description textarea (72-col guide),
  amend prefills the previous message, co-author trailer picker, `commit.template` support,
  `commit.gpgsign` passthrough with a per-commit toggle, "Stage all & commit".
- **Undo journal.** Prefer an in-app action journal over reflog parsing: before each mutating
  op, record `{ kind, head_oid, branch_targets, index_tree }`; expose `undo_last` / `redo_last`
  that restore refs (and, for hard resets, the recorded index tree) for the ops where an inverse
  is well-defined — commit, amend, branch create/delete/rename, checkout, merge, reset, cherry-pick,
  revert, stash apply/pop. Ops with no safe inverse (push, discard of untracked files) are
  journaled as non-undoable and the toolbar reflects that.
- Wire the Undo/Redo toolbar buttons and add an inline Undo to every mutation toast.

**Exit:** every mutating action in the app is either undoable in one click or explicitly
labelled as not undoable.

### P4 — Conflict resolution editor — ✅ **DONE** → closed G6

Shipped as a 3-pane editor with per-file take-side. Its two leftovers — panes labelled
"Ours"/"Theirs" (STATUS C4) and resolution as a per-file mode rather than one unified panel
(G25) — became criteria in `05-merge.md` §5 and were **closed by P8 item 2**.

- Backend: `conflict_detail(file)` reading index stages 1/2/3 (`index.conflicts()`) → base /
  ours / theirs blobs, plus a 3-way merged buffer with markers; `resolve_conflict(file, content)`
  writing the buffer and staging it; `take_ours(file)` / `take_theirs(file)`.
- Frontend: 3-pane view (ours | merged output | theirs), conflict regions navigable with
  `n`/`p`, per-region "take ours / take theirs / take both", a directly editable output pane,
  and a "mark resolved" that stages the file. The existing `ConflictBanner` becomes the entry
  point and its progress counter drives Continue.
- Tests: two-way text conflict, delete/modify conflict, binary conflict (fall back to
  ours/theirs choice only), resolution then `rebase_continue`.

**Exit:** a conflicting merge and a conflicting rebase can both be completed without leaving MTGit.

### P5 — Graph power tools — ✅ **DONE** → closed G10, G11, G8

- **Search & filter (G10)** — ✅ **done.** Shipped as specified below. What landed, and the two
  decisions worth knowing before touching it:
  - `core/search.rs` holds the grammar, its `git log` mapping and its execution; `search_commits`
    returns `{oid, index, pageHint}` per hit, ordered by **graph row** rather than `git log`
    order, because hit navigation means "next row down". `cancel_search` SIGTERMs the walk and
    keeps the partial result. Results cache against `refs_digest()` alongside the graph.
  - Both traps in the note below bit exactly as predicted. `--invert-grep` inverts *every*
    `--grep`, so a query mixing `message:` and `-message:` runs a second, identically scoped
    negative walk and subtracts it — neither term is dropped. And the injection guard is per
    operator, not global: values attach to their flag (`--grep=-x` is one argv word and cannot
    be read as an option) or land after `--`, while `ref:` and `commit:` — the two that must be
    standalone words — reject a leading `-` outright.
  - **Filter mode draws no edges.** With rows hidden, consecutive rows are no longer parent and
    child, and an edge between them asserts a parentage that does not exist. The footer says the
    topology is not continuous, and entering filter mode pulls the rest of the history in,
    because "showing 37 of 12,481" must not be counting our own pagination.
  - The minimap and `author:` autocomplete followed in P8; **`file:` path autocomplete** is the
    only remainder. `docs/feature-requirements/08-search-and-filter.md` §7.1 is the list.

  The original specification, kept because it is still the contract: a graph-header search, specified in full in
  `docs/feature-requirements/08-search-and-filter.md`. **Use GitLens's grammar rather than
  inventing one**: `message:`/`=:`, `-message:`, `author:`/`@:` (with `@me`), `committer:`,
  `commit:`/`#:`, `file:`/`?:`, `change:`/`~:` (pickaxe), `type:`/`is:` (`stash`/`tip`/`merge`),
  `after:`/`since:`/`>:`, `before:`/`until:`/`<:`, `ref:`/`^:` — read out of
  `packages/git/src/models/search.ts` in `gitkraken/vscode-gitlens` (MIT). These map nearly
  one-to-one onto `git log` flags, which is why they are the right shape, and a user arriving
  from either GitKraken product already knows them.
  Backend `search_commits(query, opts, limit)` **parses the grammar in Rust** (git logic belongs
  on the git side — invariant 5's principle) and returns `{oid, page_hint}` rather than rows,
  which the graph cache already holds. Cache results against `graph::refs_digest()` (invariant
  4). Three result modes — highlight (default), filter, select — because filtering a lane graph
  to a subset draws edges between rows that are not parent and child, and that is a lie about
  history unless asked for. A branch-scoped "solo" mode is just `ref:`, seeded from the sidebar.
  Two traps worth knowing before starting: `--invert-grep` inverts *every* `--grep` in the
  command, so `message:` and `-message:` in one query cannot be expressed as one `git log`; and
  a value beginning with `-` reaching `shellout.rs` is command injection, not a formatting bug
  (invariant 6 — we run the real `git`).
- **Graph drag-and-drop:** drag a sidebar branch or a graph row onto another row/branch → drop
  menu offering merge / rebase / reset / cherry-pick, with legal-target highlighting and the
  floating intent pill.
- **Interactive rebase:** UI builds a todo list (pick / reword / edit / squash / fixup / drop,
  reorderable), then runs `git rebase -i` with `GIT_SEQUENCE_EDITOR` set to a helper that copies
  our generated todo file into place. This reuses the existing conflict banner + P4 editor for
  the stop-and-resolve loop, so the interactive part is mostly UI.

**Exit — met:** the three GitKraken interactions users reach for daily — search, drag-to-merge,
interactive rebase — are present.

### P6 — Settings, theming, keyboard — ✅ **DONE** → closed G13–G15

Shipped as specified. What landed, and the five decisions worth knowing before touching it:

- **Backend.** `core/settings.rs` (a JSON file in the platform config dir, `get_settings` /
  `save_settings`) and `core/identity.rs` (`get_identity` / `set_identity`). 14 tests.
- **A field this version does not understand must not cost the user the rest of their
  settings.** Every field deserializes leniently, so a value of the wrong type or an enum
  variant from a newer build falls back to that *one* field's default. A whole-file `from_str`
  would turn one bad key into a factory reset, and a settings file is exactly the thing people
  hand-edit. Writes are atomic (write beside, rename) for the same reason, and `save` returns
  the **clamped** values, which the store adopts — asking for a 200px font and being shown
  200px until restart is a lie the user only finds out about later.
- **Git identity is git's state, not the app's**, so it is a separate module writing
  `user.name` / `user.email` into git's own config at the level git would consult. A commit
  made from the terminal panel therefore carries the same author. Clearing a field *removes*
  the entry rather than writing an empty one: `user.email = ""` is an identity git will
  happily commit under, and the UI cannot show the difference.
- **Every shortcut now goes through `lib/keys.ts`.** They used to be inline
  `event.metaKey && event.key === …` in whichever component owned the action, which is *why*
  there was no cheat sheet and no rebinding — nothing knew the full set, and two handlers could
  claim one chord with nothing to notice. Handlers ask `matches(event, "palette.open")`; the
  chord lives in the registry, the override in settings, and the `?` cheat sheet is a render of
  the registry rather than a second copy of it.
- **The light theme needed more than a token block.** Six stylesheets reached for `--fg`,
  `--bg-elevated`, `--danger` and friends with a hardcoded dark *fallback*, and those tokens
  were never defined — so those rules would have stayed dark whatever the theme said. Defining
  them is what makes the fallback unreachable. The translucent tints (selection, search hit,
  diff add/delete) are per-theme tokens rather than one alpha value over both grounds: the same
  20%-alpha blue that reads as a highlight on near-black is almost invisible on white. The
  terminal is told its colours explicitly, because xterm paints its own canvas and cannot
  inherit.
- **Settings are the single writer for what they own.** `diffMode` and `relativeDates` were
  removed from the session store rather than mirrored into it — a second source of truth for
  one question is the shape of defect A1.

Also closed on the way past, because they were each one flag away once there was somewhere to
put it: **STATUS B9** (cherry-pick `-x`, plumbed all the way through and hardcoded `false` at
the one call site) and the diff **ignore-whitespace** option, which needed real plumbing through
`core/diff.rs` and the three diff commands to be more than a decorative checkbox — it uses
`ignore_whitespace_change`, not `ignore_whitespace`, because the stronger flag also hides a
change that *adds* whitespace where there was none, which in Python or a Makefile is a
behaviour change the user must see.

**Exit — met:** the app is configurable and readable in both themes, and there is no emoji left
in the chrome. Verified by the gate (below) and by launching the app; the individual controls
were not clicked through.

### P7 — Ship it — ◐ **CI and the frontend suite are in; e2e and signing are not**

- **CI** ✅ — `.github/workflows/ci.yml`: a frontend job (tsc, the IPC check, Vitest, build) and
  a Rust job across ubuntu-22.04 / macOS / Windows (clippy at `-D warnings`, `cargo test`).
  **It deliberately does not run `cargo fmt --check`**, which this row asked for: the tree has
  never been rustfmt-clean and `CLAUDE.md` says to match the surrounding style by hand, so a
  format gate would fail on the first run for reasons unrelated to any change. It has still
  never *run* — expect Windows path and line-ending fallout on first green, which is the point
  of standing it up.
- **Frontend tests** ✅ — Vitest + Testing Library + jsdom, **154 tests at the time** (204 after
  P8) over the state machines
  that had nothing checking them: the session store's tab rules and recent-repo migration, the
  search store's three modes and hit navigation, the settings store, `lib/keys`, `refname`,
  `cloneurl`, `terminalLinks`, `DialogHost`, and — the two the STATUS §1 record singled out as
  "unverified by machine" — **the mutation seam** (`syncOperation` / `requireNoPausedOperation`
  / `refreshRepo`, including that it invalidates on `queryKey[1]`) and **`net.ts`** (invariant
  8's `.success` check, and D5's publish flow).
  They found four real defects, all fixed: `HEAD^` in terminal output yielded a candidate of
  `HEAD`, which resolves — to the **wrong commit**; Escape did nothing on a confirm or choice
  dialog, because focus never entered it; the settings store's in-flight-write guard was
  inverted, so clamped values were never adopted; and `isTypingTarget` could return `undefined`.
- **`scripts/check-ipc.mjs`** ✅ (new, and in CI) — invariant 1's fourth layer. A command missing
  from `invoke_handler!` compiles, typechecks, and fails only at runtime, and **neither suite can
  see it**: the Rust tests call `core::` directly and the frontend tests mock the IPC layer. It
  is the only thing that reads `commands.rs`, `lib.rs` and `ipc/commands.ts` together. It cannot
  check `types.ts`, whose mirroring is structural.
- **Packaging** ◐ — `.github/workflows/release.yml` builds .dmg (both Mac architectures), MSI and
  AppImage/deb on a version tag and drafts a release. **The artifacts are unsigned**, and the
  updater is deliberately absent: both need credentials this repository does not have (an Apple
  Developer ID plus a notarytool password, a Windows code-signing certificate, and an updater
  keypair). The secret names tauri-action reads are already in the workflow, so adding them is
  the whole remaining change.
- **E2E** ✗ — not started. `tauri-driver` + WebdriverIO against `scripts/make-fixture.sh` needs a
  built binary and a driver on the runner, neither of which exists yet.

**Exit — not yet met:** a stranger can build all three platforms from a tag, but not install a
signed one.

### ~~P8 — GitLens-derived surfaces~~ → closes G16–G28 — ✅ **DONE (2026-09-11)**

Everything in §2.6. It was one phase because the items share the graph and the detail panel,
not because they shipped together — most were independently landable, and the ordering below is
by dependency, not priority. `docs/feature-requirements/STATUS.md` §6 is the criterion-level
record of what each one closed.

1. **Worktrees in the UI (G18)** — ✅ **DONE.** All four parts landed, plus the backend gaps
   they exposed. Three decisions worth knowing:
   - **`list` now includes the main worktree**, which `Repository::worktrees()` deliberately
     omits because it is not a *linked* one. The section exists to answer "which one am I in",
     and a list that cannot name the answer does not answer it. "Current" is decided by
     comparing working directories, not by assuming the handle is the main repo — opening a
     worktree as its own tab is the whole point, so the handle often *is* a worktree.
   - **WIP rows are emitted with a lane but are not `GraphRow`s.** The plan said "synthetic
     rows"; they are synthetic, and the lane and colour are computed in Rust
     (`graph::wip_rows`, invariant 5). What they are *not* is members of the row list, because
     `search_commits` returns row indices as page hints and the two caches are keyed on the
     same digest precisely so their indices agree (`08-search-and-filter.md` B3). Inserting a
     non-commit into that list would silently shift every hint. They render as a strip above
     the scroll container, each dashed node on its own worktree's lane — which also closes
     STATUS §4's "WIP row is not on the lane".
   - **Clicking another worktree's WIP row opens that worktree as a tab** rather than opening
     the commit panel on it, which is what `01-commit.md` §3.1 asks for. A different worktree
     has a different index, and this tab's handle cannot stage into it without lying about
     which repository it is acting on. Opening it reaches the same place honestly, and the tab
     strip P1 built is what makes that cheap. Recorded as a deviation, not a completion.

   Both `02-checkout.md` §7 leftovers are now closed too: **B8's detached case** goes through a
   scratch reference that is deleted once the worktree's own HEAD is moved off it — which is
   what git does internally, and is the only route git2 offers, since `WorktreeAddOptions`
   insists on a reference — and the **worktree-holds-branch dialog** names the holder via
   `worktree_holding` and offers to open it as a tab.
2. **Unified conflict panel (G25)** — ✅ **DONE.** One panel with cross-file region navigation
   (`n`/`p` crossing file boundaries, `conflict i of n · file j of k`), panes relabelled by ref
   with lane colour. Closes STATUS C4. Two things the plan did not anticipate:
   - **The region cursor is computed from the live textarea, not from `conflict_set`.** The user
     edits the output; a cursor keyed to the server's list points at a region that no longer
     exists. The backend's list is what makes *cross-file* counting possible, which is a
     different question.
   - **Naming the sides is the correctness fix, not the cosmetic one.** `conflict_sides` reads
     the rebase state directory for `head-name` and `onto`, because during a rebase `ours` is
     the branch you are rebasing **onto** — the opposite of what almost everyone assumes.
     `a_merge_conflict_names_both_branches` and
     `a_rebase_conflict_names_the_base_as_ours_and_the_replayed_branch_as_theirs` pin the two
     directions separately for exactly that reason.
3. **Graph column model + gutter (G16, G17)** — ✅ **DONE.** Configurable, reorderable,
   toggleable columns (Author / Changes / Date / SHA), scroll markers (which landed with search
   in P5) and the on-search minimap. Three decisions:
   - **Columns are a persisted preference**, in `core/settings.rs` + `stores/settings.ts`. The
     old `graphOpts.showAuthor` in the session store was exactly the second source of truth the
     conventions forbid, and it is deleted rather than wrapped.
   - **The Changes column is the only expensive one** — a diff per row — so it is off by default
     and fetched per *visible window*, rounded to a 50-row block so dragging the scrollbar is
     not a fetch per frame. A row with no counts yet shows a dash, never a zero.
   - **The minimap is a density strip, not a scaled graph.** At 12,000 commits in 600px of
     height each pixel row is twenty commits; one mark per hit loses every cluster to overlap.
     Clicking a bucket jumps to its first *hit* rather than to the offset, because the user is
     looking for a match and landing near one is not landing on one.
4. **Detail stack (G24)** — ✅ **DONE.** Details push as sheets with a back affordance, and
   compare-two-commits is a sheet rather than a mode. The base of the stack is deliberately
   *not* in the new store: it is the graph selection, which stays the single source of truth
   for "which row is highlighted", and selecting a row clears the stack — clicking a commit
   means "look at this", not "add a layer".
5. **Interactive-rebase conflict prediction (G26)** — ✅ **DONE**, and it was the one genuinely
   new algorithm as predicted. `core/rebase_predict.rs` replays the plan as in-memory
   three-way merges, carrying a base tree forward. Three findings worth recording:
   - **Conflicts cascade, and that is correct.** Reordering two commits that touch the same line
     predicts *two* conflicts, because git stops twice — once on the reorder, once on the
     resolution. The carried-forward guess (favouring the incoming side) is what makes the
     second prediction possible at all, and is also why a later prediction is weaker than an
     earlier one.
   - **"Writes nothing to the repo" turned out not to be quite true**, and the honest version is
     in the module doc: no ref moves, no index writes, no `ORIG_HEAD`, no working tree — but
     *unreferenced tree objects are written*, because git2's merge takes `Tree` handles and the
     only way to turn a merged index back into one is to write it. `git gc` prunes them.
   - **It never gates Start Rebase**, per this document's own risk table, and it is warn-toned
     rather than danger-toned: a red row would read as a refusal rather than a forecast.
6. **The cheap independent wins** — ✅ **all done**, in the value-per-hour order this list gave:
   **terminal links (G19)** — `core/terminal.rs` resolves a token against the repository and
   `lib/terminalLinks.ts` finds the candidates; xterm's link provider asks per hovered line, so
   it is one batched IPC call per line the mouse passes over. The decision "is this a ref" stays
   on the git side, which is what keeps prose from becoming links —
   `prose_and_filenames_do_not_become_links` pins it.
   **`--follow` / `-L` history and revision navigation (G22)** — pulled forward out of order, as
   §8 said to, because it is a correctness fix. Following only pays for a full rename-detected
   diff at the one commit where the tracked path appears as `Added`; a pathspec filters the old
   name out, which is what makes a rename look like an add. `-L` maps the range backwards hunk
   by hunk, so an insertion above it moves it.
   **blame heatmap + rich hovers (G21)** — a per-file ramp, because "which lines here are
   recent" is the useful question; an absolute scale renders an untouched file uniformly cold
   and says nothing. Hovers fetch on hover and share the commit panel's query key.
   **autolinks (G20)** — per-repo patterns plus a built-in only for hosts whose issue URL we
   actually know. Link out only, no API calls — a guess at an unknown host produces a link that
   404s, and a broken link is worse than plain text because the user follows it.
   **merge target + jump-to navigation (G23)** and per-row unpushed/unpulled markers — the
   resolution rule git does not have is documented at `refs::merge_target` rather than spread
   across the UI.
   **contributors view (G28)** — also the `author:` autocomplete and the co-author picker, which
   is why co-authorship is counted separately from authorship.
   **guided command palette (G27)** — commands declare *steps*; the palette walks them with a
   breadcrumb, and Escape or Backspace-on-empty undoes the last choice rather than closing. It
   also deleted the row-per-branch expansion that used to crowd out every real command, which
   is how it closed STATUS B7.

**Exit — met.** The graph answers the three questions it could not: *which* commits are unpushed
(per-row markers), *where* is the commit I am looking for (minimap + scroll markers), and *what
will this rebase cost me* (prediction). No GitLens feature is absent by accident rather than by
the §2.5 / overview §8.2 decision — the two that remain unbuilt, `+N` ref overflow and ghost
refs on hover, are named in `STATUS.md` §6 rather than merely missing.

---

## 5. New backend command surface

Everything P1–P5 needs, so the IPC contract can be reviewed in one place before implementation:

```
# repo lifecycle                          # all DONE in P1
clone_repo(url, dest, recurse_submodules, depth?, branch?) -> RepoInfo  # streams git-progress
init_repo(path, bare) -> RepoInfo
list_remotes() / add_remote(name, url) / remove_remote(name) / rename_remote(old, new)
set_remote_url(name, url)               # not in the original sketch; "Edit URL…" needs it
push_target() -> { branch, remote, hasUpstream }   # DONE in P0 (D5)

# staging
stage_hunks(file, hunk_ids, lines?)     unstage_hunks(file, hunk_ids, lines?)
discard_hunks(file, hunk_ids, lines?)

# commit
commit_ex(summary, description, amend, sign, trailers)

# undo
journal_list() / undo_last() / redo_last()

# conflicts
conflict_detail(file) -> { base, ours, theirs, merged }
resolve_conflict(file, content) / take_ours(file) / take_theirs(file)

# graph
get_graph(skip, limit)                  # DONE — paginated by the frontend since P0
graph::refs_digest()                    # DONE — internal, backs the D1 cache fix
search_commits(query, opts, limit) -> { hits: [{ oid, index, pageHint }], truncated, cancelled,
                                        summary, notes }   # DONE in P5; grammar parsed in Rust
cancel_search()                         # DONE — SIGTERMs the walk, keeps partial results
rebase_interactive(onto, todo[])

# P8 — GitLens-derived (§2.6)
list_worktrees() / create_worktree(name, path, target?) / remove_worktree(name, force)
                                        # DONE — list now includes the main worktree; `target`
                                        # resolves a local branch, a remote branch or an oid
wip_rows() -> [{ worktree, lane, color, headIndex, changed, isCurrent }]
                                        # DONE — its own command, not folded into get_graph:
                                        # it costs a status scan per worktree, and get_graph
                                        # runs once per scroll page
predict_rebase_conflicts(onto, todo[]) -> [{ index, files[] }]   # DONE — moves no ref, writes
                                        # no index; it *does* write unreferenced tree objects,
                                        # because git2's merge takes Tree handles
conflict_set() -> { kind, oursLabel, theirsLabel, files[] }      # DONE — every conflicted file
                                        # at once, plus the two sides named and lane-coloured
blame_file(file, at)                    # DONE — carries a per-file age bucket for the heatmap
file_history(file, limit, follow)       # DONE — --follow (G22)
line_history(file, start, end, limit)   # DONE — -L (G22)
path_at_commit(file, oid)               # DONE — the name a file had before a rename
merge_target(branch) -> { ref, oid, ahead, behind, source }      # DONE — `source` says which
                                        # rule resolved it, so a surprise is explainable
merge_relation(target, source)          # DONE — is a fast-forward even possible (STATUS C6)
list_contributors(limit?)               # DONE — co-authorship counted separately
commit_stats(oids[])                    # DONE — batched, for the graph's Changes column
commit_template()                       # DONE — `commit.template`, comments stripped
worktree_holding(branch)                # DONE — who already has it checked out
unset_upstream(local)                   # DONE — the prune-orphan recovery (STATUS C8)
resolve_terminal_tokens(tokens[]) -> [{ token, kind, oid, label }]   # DONE — batched per
                                        # hovered line; only resolvable tokens come back
autolink_patterns()                     # DONE — per-repo patterns + a built-in only for hosts
                                        # whose issue URL shape we actually know
```

Two contract notes that are easy to get wrong:

- `search_commits` returns SHAs and page hints, **not rows**. The rows are already in the graph
  cache; re-serialising them doubles the payload for nothing. Results cache against
  `refs_digest()` so a fetch cannot leave a hit list pointing at a rewritten commit. It grew one
  field beyond the sketch: a row `index` as well as a `pageHint`, because the frontend needs the
  index to scroll to the hit *after* loading the page the hint named — and a `null` index is how
  a hit the graph does not contain (a stash commit) reports itself instead of being dropped.
- `predict_rebase_conflicts` is read-only and therefore takes **no op guard** (invariant 2), and
  leaves no trace a user can see: no ref moves, no index writes, no `ORIG_HEAD`, no working tree
  — it never needed a temporary one, because git2's `merge_trees` works in memory. The one place
  the promise had to be weakened: **unreferenced tree objects are written**, because that merge
  takes `Tree` handles and the only way to turn a merged index back into one is to write it.
  `git gc` prunes them and nothing points at them; the module doc says so rather than hiding
  behind "read-only".
- `conflict_set` also takes no op guard, and that has to stay true: the panel refetches after
  every resolve, and suppressing the watcher on a *read* would hide the user's own editor saves.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| **Line-level staging is fiddly.** Patch synthesis must get hunk headers, CRLF, and missing-trailing-newline right or it corrupts the index. | Ship hunk-level (git2 callback, no patch synthesis) first; gate line-level behind a broad test matrix and always apply via `git apply --cached`, which validates the patch for us. |
| **Interactive rebase via `GIT_SEQUENCE_EDITOR`** depends on git's todo format. | Format is stable and documented; pin behavior with an e2e test per verb rather than unit tests. |
| **Undo journal can drift** from repo reality if the user runs git in the terminal panel. | Validate each journal entry against current ref state before offering undo; invalidate the entry (and grey the button) on mismatch. |
| **The mutation seam is a single point of failure.** Every banner in the app is now one `operation_info` call (`ipc/repoState.ts`), where it used to be seven independent derivations. A regression there is invisible in seven places at once rather than one. | The single writer is the point — seven copies were how A1 hid. Backed by `operation_info_reports_a_conflict_it_was_never_told_about`, which pins the contract using a conflict made by the `git` binary directly. The seam's own reconciliation is still unverified by machine until P7 lands a frontend runner; that is the strongest remaining argument for pulling Vitest forward. |
| ~~**50k+ repo perf** is unmeasured because the gate is ignored.~~ Now measured: 269ms of a 500ms budget (debug build). | ✅ P0 turned the gate on; **P1 de-noised it.** The flake this row predicted arrived on the dev machine, not on CI: a single sample under a saturated `cargo test` hit 605 ms against the 500 ms budget with nothing regressed. The gate now takes the best of up to three runs. Still add a scroll-frame budget check per release. |
| **Windows has never been built.** | CI on all three OSes lands in P7, but run a manual Windows build **now** — P0 is done, and the longer it waits the worse the path/CRLF debt. (P0 note: the D4 deadlock tests are `#[cfg(unix)]`, so that path is unverified on Windows.) |
| **Scope creep into provider integrations.** | §2.5 is the contract: PR/issue panels are out until P7 ships. `docs/feature-requirements/00-overview.md` §8.2–§8.3 extends that contract over GitLens's whole account-gated tier, so "GitLens has it" is not an argument for building it. |
| **GitLens as a reference is licence-shaped.** Its `plus/` tree (Launchpad, AI, agents, Cloud Patches) is under `LICENSE.plus`, not MIT — and that is precisely the half whose features are most tempting to copy. | Read `plus/` for understanding only; never lift code from it. For the MIT half, matching *behaviour* is free but copying *code* owes attribution — cite the source file in a comment. §2.5 keeps the whole `plus/` feature set deferred anyway, which makes this mostly self-enforcing. |
| ~~**Conflict prediction (G26) can be wrong**, and a wrong prediction is worse than none.~~ | ✅ **Discharged in P8 item 5**, as prescribed: labelled an estimate, recomputed (debounced) on every reorder, warn-toned rather than danger-toned, and never gating Start Rebase. Tested against the reorder case and — in the shape this row asked for, a conflict a per-commit check cannot see — a **dropped prerequisite**, where each commit is individually fine and only the plan conflicts. One thing the row did not foresee: the prediction **cascades**, because carrying a guessed resolution forward is the only way later steps can be predicted at all. That is faithful to git, which also stops twice, and the module doc says a later prediction is weaker than an earlier one. |
| ~~**Search values reach the real `git` binary** (invariant 6), so a term beginning with `-` is command injection rather than a formatting bug.~~ | ✅ **Discharged in P5.** `no_operator_lets_a_leading_dash_reach_git_as_an_option` asserts, per operator, that a value beginning with `-` is either attached to its flag, after `--`, or rejected. `ref:` and `commit:` reject; the rest attach. Note that search does **not** go through `shellout.rs` — that path accepts fetch/pull/push only — so the guard lives in `core/search.rs::guard_standalone`. |

---

## 7. Effort

| Phase | Scope | Duration |
|---|---|---|
| ~~P0~~ | ~~Defect fixes (D1–D5)~~ | ✅ **done** |
| ~~P1~~ | ~~Clone/init/remotes/start screen/tabs~~ | ✅ **done** (clone + init + remote management + start screen + first-class tabs) |
| ~~P2~~ | ~~Hunk + line staging~~ | ✅ **done** (`applyPatch` + per-hunk/per-line UI) |
| ~~P3~~ | ~~Commit form + undo journal~~ | ✅ **done** (summary/description, amend, hooks, undo/redo) |
| ~~P4~~ | ~~Conflict editor~~ | ✅ **done** (3-pane + per-file take-side); the labels and cross-file region nav it left outstanding landed with P8 item 2 |
| ~~P5~~ | ~~Search, drag-drop, interactive rebase~~ | ✅ **done** (search grammar in Rust + three result modes + scroll markers; drag-drop; interactive rebase) |
| ~~P6~~ | ~~Settings, light theme, keybindings, icons~~ | ✅ **done** (settings file + identity, both themes, keybinding registry + cheat sheet, SVG icon set) |
| P7 | CI, tests, packaging | ◐ **partly done** — CI, the frontend suite (204 tests) and the IPC check are in; e2e and signing/updater are not |
| ~~P8~~ | ~~GitLens-derived surfaces (G16–G28)~~ | ✅ **done** — all six items; G16–G28 closed bar `+N` ref overflow and ghost refs on hover, both named in `STATUS.md` §6 |
| **Remaining** | P7's **e2e + code signing**, and the short list in `docs/feature-requirements/STATUS.md` §4 (rebase ghosting, cherry-pick sequence progress, two flashes) | **~3–5 days of feature work, plus whatever the certificates and the runner take** |

The UI/UX fidelity work in §3 was distributed across P1 (shell + start screen), P3 and P8 (undo
toasts), P5 (drop affordances), P6 (tokens, density, icons) and P8 (columns, minimap, detail
stack) rather than batched — a separate "make it look like GitKraken" phase at the end would
have meant rebuilding components twice. It is done bar the four items in
`docs/feature-requirements/STATUS.md` §4.

P8 was deliberately sequenced **after** P7 rather than before it, despite containing items
cheaper than anything in P6. The reason was that P7 stands up CI and the first frontend test
runner, and P8 was the largest body of *frontend* work left in the plan — landing it against a
suite that exists is worth more than landing it a fortnight sooner. **That call paid off**: the
50 frontend tests P8 added are mostly over logic it extracted precisely because a runner existed
to point them at (`lib/autolinks`, `lib/dropMenu`, `lib/undoToast`, `lib/coauthors`), and two of
them — the drop menu's fast-forward computation and the undo capture — found their own bugs
while being written. The exception the paragraph named held too: `--follow` (G22) was pulled
forward out of order, because history that stops at a rename reports the wrong author for the
code, which is a confident wrong answer rather than a missing feature.

## 8. Suggested order of attack

If you want the shortest path to "this feels like GitKraken":

1. ~~**P0.D1 + P0.D2** — a stale or laggy graph undermines everything else.~~ ✅ done (all of
   P0 landed, not just D1/D2).
2. ~~**P2** — hunk staging is the feature users notice missing within five minutes.~~ ✅ done.
3. ~~**P3 undo** + toast affordance~~ ✅ **done, both halves.** The inline Undo *on toasts*
   (§3.3) landed with P8: `lib/undoToast.ts`, wired into the graph's and the sidebar's shared
   `run` helpers and into the interactive-rebase completion toast. It offers Undo only when the
   journal actually **grew** — an unchanged label means the operation recorded nothing, and
   undoing then would reverse the *previous* one. Two identical operations in a row therefore
   lose the offer, which is a false negative and the right side to err on.
4. ~~**P4** conflict editor~~ ✅ done; **P5** drag-drop and interactive rebase ✅ done.
5. ~~**The defects in `STATUS.md` §1 first**, A1 in particular.~~ ✅ **done — all five.** The
   mutation seam (`src/ipc/repoState.ts`: `syncOperation` + `refreshRepo`) closed A1 and is now
   the only writer to the conflict store and the only `invalidateQueries` in `src/`. A2–A5
   followed: `DetachedHeadBanner` refreshes (A2), auto-fetch keys its timer on the interval and
   fetches once at open (A4), the sidebar placeholder names the keys the handler binds (A5), and
   overview §5.3's one-operation-at-a-time rule is enforced by
   `requireNoPausedOperation` — the same seam module, called from eleven sites, two of which
   (`smartCheckout`, `runNet`) are genuine chokepoints rather than repetition (A3).
   `STATUS.md` §1.1–§1.2 have the full record, including what the gate deliberately does *not*
   stop and the one Rust test that pins the contract it rests on.
6. ~~**P5-search (G10)**~~ ✅ **done**, together with the half of P8 item 3 it depended on: the
   scroll markers landed with it, because hits you cannot locate are half a search. The minimap
   followed in P8, beside them.
7. ~~**P1.** Clone / init / remotes / start screen~~ ✅ **done.** The app is self-sufficient
   without the CLI: a user who has never opened a terminal can clone, init, manage remotes and
   work. It also picked up STATUS B3 and B4, which were blocked on the per-remote sidebar node
   this phase had to build anyway.
8. ~~**P8 item 1 (worktrees).**~~ ✅ **done** — sidebar section with add/open/remove,
   "Open in worktree…" beside every Checkout, the active worktree named in the toolbar, and a
   per-worktree WIP row on its own lane. Both `02-checkout.md` §7 leftovers closed later in P8:
   the detached-commit case and the worktree-holds-branch dialog.
9. ~~**Terminal links (G19)**~~ ✅ **done** — the best value-per-hour item, as advertised.
   ~~The rest of P8 item 6's cheap wins~~ ✅ **all done**: blame heatmap + rich hovers,
   autolinks, merge target + jump-to, contributors, `--follow` / `-L`, guided palette.
10. ~~**P6**~~ ✅ **done** — settings file, both themes, the keybinding registry with its cheat
    sheet, and the SVG icon set; it also closed STATUS B9 and the ignore-whitespace option.
10b. ~~**The rest of P8**~~ ✅ **done**, in the order §4/P8 gave: the unified conflict panel
    (item 2, which did subsume STATUS C4 and did unblock two rebase items), then the column
    model and the minimap, the detail stack, conflict prediction, and item 6's cheap wins.
    `--follow` (G22) was pulled forward out of order as this line said to.
11. **P7** ◐ ← **what is left.** CI, the frontend suite (204 tests) and `check-ipc` landed;
    **e2e and code signing are the remainder**, and both need something this repository does not
    have (a `tauri-driver` on the runner, an Apple Developer ID plus a notarytool password, a
    Windows code-signing certificate, and an updater keypair). The secret names `tauri-action`
    reads are already in `.github/workflows/release.yml`, so adding them is the whole change on
    that side.
12. **Then the four polish items in `docs/feature-requirements/STATUS.md` §4**, of which only
    one is hard: in-progress rebase ghosting needs the graph to represent "a commit that will
    exist", and inventing rows for those collides with `search_commits` returning row indices —
    the same constraint that kept WIP rows out of the row list.
