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

> **Status: P0 and P2–P5 complete against `docs/feature-requirements/`** (audited 2026-09-08 —
> read `docs/feature-requirements/STATUS.md` for the per-criterion verdict and the outstanding
> gaps). **P5 closed with commit search (G10)**, the last item in it; P1 (clone / init / remote
> management / start screen) and P6–P8 are unstarted. Sections 2.4 and 4/P0 record the P0 work;
> the P2–P5 sections below describe what was intended, not what shipped — where the two differ,
> STATUS.md is the record.
>
> **Revised after the GitLens pass:** §2.6 adds G16–G28 (gaps visible only once GitLens is
> treated as a reference) and P8 sequences them; §2.5 grew to cover GitLens's account-gated
> tier. The old "P2 is next" marker in §8 was stale — P2 through P5 had already landed — and is
> corrected. Nothing in §2.1–§2.4 changed: the GitLens material is additive, and the P0 defect
> record stands as written.

Measured, not assumed: `pnpm exec tsc --noEmit` exits 0, `vite build` succeeds, `cargo clippy
--all-targets -- -D warnings` is clean, and `cargo test` reports **40 passed, 0 failed,
0 ignored** at the time of that audit — the 50k-commit perf gate runs in the default suite.
The suite is at **67 passed** after P5's search (25 tests for the grammar and its git mapping).
~9k lines across `src/` + `src-tauri/src/`.

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

### 2.1 Blocking — a GitKraken user cannot start work

| # | Gap | Detail |
|---|---|---|
| G1 | **No Clone** | GitKraken's front door is Clone/Init/Open. MTGit only opens an existing repo. No URL clone, no provider browse, no target-dir picker, no `--recurse-submodules`, no depth. |
| G2 | **No Init** | Cannot create a repo from the app. |
| G3 | **No start/welcome screen** | App boots into three empty panes. GitKraken shows a start tab with recent repos, Clone/Init/Open cards, and a repo search. Recent repos are currently buried in a toolbar dropdown. |
| G4 | **No remote management** | Cannot add / rename / remove a remote, or choose a push target. `get_remote_url` reads `origin` only; the sidebar has no per-remote grouping. |

### 2.2 Core workflow holes

| # | Gap | Detail |
|---|---|---|
| G5 | **No hunk / line staging** | The single most-used GitKraken feature. Backend has no `stage_hunk`; UI stages whole files only. |
| G6 | **No conflict resolution editor** | GitKraken ships a 3-pane merge tool. MTGit surfaces conflicts and offers Abort/Continue — correct, but the user must leave the app to resolve. |
| G7 | **Thin commit form** | One textarea. Missing summary/description split, 50/72 guidance, amend-message prefill, co-author trailer, commit template, GPG signing toggle, "stage all and commit". |
| G8 | **No interactive rebase** | No reorder / squash / fixup / drop / edit / reword. |
| G9 | **No undo/redo** | Toolbar buttons are hardcoded `disabled`. GitKraken's undo is a signature safety feature. |
| ~~G10~~ | ~~**No commit search / filter**~~ ✅ **closed in P5** | GitLens's grammar, parsed in Rust (`core/search.rs`), with highlight / filter / select modes, hit navigation across unloaded pages, scroll markers, and `ref:` as the branch-scoped ("solo") view. Outstanding: the minimap (P8 item 3) and value autocomplete for contributors and paths — `docs/feature-requirements/08-search-and-filter.md` §7.1. |

### 2.3 Interaction fidelity

| # | Gap | Detail |
|---|---|---|
| G11 | **Graph drag-and-drop is half-built** | Sidebar branch→branch merge works. GitKraken also supports dragging a *branch/commit onto a graph row* and choosing merge / rebase / reset / cherry-pick from a drop menu, with a live drop-target pill. |
| G12 | **Tabs are second-class** | `TabBar` hides at ≤1 tab, has no `+`, no reorder, no middle-click close; switching tabs discards selection. |
| G13 | **Two keyboard shortcuts total** | ⌘K and ⌘\`. No shortcut map, no cheat sheet, no per-action bindings. |
| G14 | **No settings screen** | Theme, diff mode, font size, default clone dir, git identity/profiles, date format — all unconfigurable or ephemeral. |
| G15 | **Dark theme only** | `src/theme.css` has no light-token block and no `prefers-color-scheme` handling. |

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
| G16 | **Graph has three fixed columns** | GitLens's graph carries BRANCH/TAG, GRAPH, MESSAGE, **Author, Changes, Date, SHA** — reorderable by dragging headers, toggleable by right-clicking them, persisted per repo. The Changes column (green added / red deleted diffstat bar) is the highest-value of the missing ones: it shows the shape of a commit without selecting it. |
| G17 | **No minimap** (scroll markers ◐ **done**) | P5's search shipped the markers this row demanded — hits, HEAD and the selection at their proportional positions in the whole history (`ScrollMarkers`), sampled to 400 marks so a 5,000-hit query does not become a solid bar. The **minimap** proper — activity over the whole history beside the markers — is still unbuilt, and stays in P8 item 3. |
| G18 | **Worktrees exist in the backend and nowhere in the UI** | `core/worktree.rs` lists and adds; the sidebar has no WORKTREES section, the graph shows no per-worktree WIP row, and "Open in worktree…" is offered nowhere checkout is. GitLens treats a worktree as the *default* answer to "look at another branch". Almost entirely UI work over backend that already ships. |
| G19 | **No terminal links** | MTGit has an xterm panel (`pty.rs`). GitLens makes SHAs, branch names, tags and `a..b` ranges printed in a terminal clickable → reveal in the graph. Best value-per-hour item in this table: a regex plus a call into the existing graph-selection path. |
| G20 | **No autolinks** | Issue references in commit messages (`#123`, `ABC-456`) are inert text in the message column and the detail panel. Link out only — resolving issue *state* is provider integration (§2.5). |
| G21 | **File viewer has no annotations** | Blame exists (`core/blame.rs`) as a list. Missing: the age **heatmap** gutter, a **recent-changes** annotation in the file-at-commit viewer, and **rich hovers** (message, author, dates, file count, actions) over blame rows, graph rows and ref pills — one shared hover component, not three. |
| G22 | **History does not follow renames; no revision navigation** | `core/history.rs` has no `--follow`, and there is no line history (`-L`). Blame across a refactor is therefore untrustworthy. No prev/next stepping through a file's own versions. |
| G23 | **No merge-target concept, no jump-to navigation** | Ahead/behind is computed against the upstream only. GitLens also tracks the **merge target** — the branch this one is destined to merge into — and offers jump-to-HEAD / upstream / merge-target. Being 40 behind the merge target while level with the upstream is currently invisible. |
| G24 | **Detail panel is a single slot** | Selecting a branch or opening a comparison destroys the commit the user was reading. GitLens stacks details as sheets with a back affordance; it is also what makes "compare two commits" usable rather than a mode. |
| G25 | **Conflict resolution is a per-file mode** | P4 shipped a 3-pane editor per file. GitLens collects every conflicted file into one panel with cross-file region navigation. An eleven-file rebase stop is navigated dozens of times, and a mode boundary per file is dozens of round trips. Subsumes STATUS C4 (panes labelled "Ours"/"Theirs"). |
| G26 | **Interactive rebase does not predict conflicts** | GitLens marks, before execution, which rows will conflict. It is the feature that changes how the plan editor feels — reordering is otherwise a guess about which guess costs twenty minutes. The only genuinely new *algorithm* in this table: trial-apply the plan against a scratch index without moving any ref. |
| G27 | **Command palette is a flat action list** | GitLens's Git Command Palette walks the user through a command's arguments step by step. Ours fires actions with no argument-gathering, so anything needing a target is unreachable from `⌘K`. |
| G28 | **No contributors view** | No way to see who has committed and how much. It is also the natural picker for `author:` search (G10) and for co-author trailers (G7), which is why it is cheap to justify. |

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

Replace the emoji-as-icons currently used throughout (`⑂ ⇩ ⇧ ▤ 🖥 ☁ 🏷 🌿 ≡`) with a single
inline-SVG icon set. Emoji render differently per platform and are the loudest tell that this
is not a native-feeling app.

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

### P1 — Repo lifecycle + start screen (1 week) → closes G1–G4, G12, G3

- Backend: `clone_repo(url, dest, opts)` via `git clone --progress` shellout (auth + progress
  come free); `init_repo(path, bare)`; `add_remote` / `remove_remote` / `rename_remote` /
  `list_remotes` via git2.
- Frontend: start screen (Clone / Init / Open cards + recent-repo list with last-opened and
  branch), clone modal with URL validation, target-dir picker, recurse-submodules and depth,
  and a progress bar fed by `git-progress`.
- Tab strip always visible, `+` opens a start tab, middle-click closes, drag to reorder,
  per-tab selection state preserved in the session store.
- Sidebar: group remote branches under their remote with an add/remove-remote menu.

**Exit:** a user can install MTGit, clone a repo from a URL, and work — without ever using the CLI.

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

Shipped as summary/description, amend, hook handling, and the undo/redo journal. Outstanding
against the specs: the co-author picker and `commit.template` (G7's last two items, now
criteria in `01-commit.md`), and the inline Undo on mutation toasts (§3.3).

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

Shipped as a 3-pane editor with per-file take-side. Outstanding: pane labels still read
"Ours"/"Theirs" (STATUS C4) and resolution is a per-file mode rather than one unified panel
(G25) — both now criteria in `05-merge.md` §5, and both carried into P8.

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
  - Outstanding: the minimap (P8 item 3) and value autocomplete for contributors and paths
    (needs G28). `docs/feature-requirements/08-search-and-filter.md` §7.1 is the list.

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

### P6 — Settings, theming, keyboard (1 week) → closes G13–G15

- Settings screen (tabbed: General / Appearance / Git / Terminal) persisted to a JSON file via
  Tauri fs rather than `localStorage`; migrate recent-repos into it.
- Light theme completed per §3.1, with a system/light/dark selector.
- Density control, diff defaults (split/inline, whitespace, word-wrap, tab width).
- Git identity + per-repo identity override; profiles.
- Full keybinding map with a `?` cheat-sheet overlay and rebindable actions.
- Icon set swap (emoji → inline SVG) per §3.3.

**Exit:** the app is configurable and readable in both themes; no emoji in chrome.

### P7 — Ship it (1 week)

- **CI** (`.github/workflows`): `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`,
  `tsc`, `vite build`, on macOS + Windows + Linux. This has never run — expect Windows
  path/line-ending fallout on first green.
- **Frontend tests:** add Vitest + Testing Library; cover the stores (session, conflict, dialog),
  `wordDiff`, `refname` validation, and graph row rendering.
- **E2E:** `tauri-driver` + WebdriverIO smoke against `scripts/make-fixture.sh`:
  open → scroll → select commit → stage hunk → commit → assert with `git log`.
- **Packaging:** notarized macOS `.dmg`, Windows MSI (signed), Linux AppImage + deb;
  Tauri updater with a release manifest.

**Exit:** a tagged release that a stranger can install on all three platforms.

### P8 — GitLens-derived surfaces (2–2.5 weeks) → closes G16–G28

Everything in §2.6. It is one phase because the items share the graph and the detail panel, not
because they ship together — most are independently landable, and the ordering below is by
dependency, not priority. `docs/feature-requirements/STATUS.md` §6 is the criterion-level
backlog; each item there is already marked against its own doc.

1. **Worktrees in the UI (G18)** — first, because the backend exists (`core/worktree.rs`) and
   four other docs' criteria hang off it. Sidebar WORKTREES section; `graph.rs` emits **one WIP
   row per worktree** on that worktree's lane (synthetic rows, invariant 5 — not arithmetic in
   `GraphView`); "Open in worktree…" wherever Checkout is offered; active worktree shown in the
   toolbar, because a user who forgets which worktree they are in commits to the wrong branch.
2. **Unified conflict panel (G25)** — reworks P4's per-file editor into one panel with cross-file
   region navigation (`n`/`p` crossing file boundaries, `conflict i of n · file j of k`), and
   relabels the panes by ref with lane colour, closing STATUS C4. Prerequisite for item 5.
3. **Graph column model + gutter (G16, G17)** — configurable/reorderable/toggleable columns with
   Author / Changes / Date / SHA; ~~scroll markers~~ and an on-search minimap. The scroll markers
   landed **with** search in P5, for the reason this line gives: a search whose hits cannot be
   located in the scrollbar is half a feature. `ScrollMarkers` in `GraphView` is where they live,
   and the minimap belongs beside them.
4. **Detail stack (G24)** — push details as sheets with a back affordance; makes
   compare-two-commits a sheet rather than a mode.
5. **Interactive-rebase conflict prediction (G26)** — the one new algorithm here. Trial-apply the
   plan against a scratch index (temp worktree, or in-memory `git2` merge per step) and mark the
   rows that will clash, recomputing on every reorder. **No ref moves and nothing is written to
   the repo to find out.** It is an estimate; label it as one — a clean prediction must not read
   as a guarantee.
6. **The cheap independent wins**, in value-per-hour order:
   **terminal links (G19)** — a regex over xterm output plus the existing graph-selection call,
   and the thing that makes the terminal panel feel integrated rather than embedded;
   **blame heatmap + rich hovers + recent-changes annotation (G21)** — CSS and one shared hover
   component over data we already fetch;
   **autolinks (G20)** — per-repo patterns, link out only, no API calls;
   **merge target + jump-to navigation (G23)** and per-row ahead/behind markers;
   **contributors view (G28)**, which is also the `author:` and co-author picker;
   **`--follow` / `-L` history and revision navigation (G22)** — without `--follow`, blame
   across a refactor is quietly wrong, which makes this a correctness item, not a polish one;
   **guided command palette (G27)**.

**Exit:** the graph answers the three questions it cannot answer today — *which* commits are
unpushed, *where* is the commit I am looking for, and *what will this rebase cost me* — and no
GitLens feature is absent by accident rather than by the §2.5 / overview §8.2 decision.

---

## 5. New backend command surface

Everything P1–P5 needs, so the IPC contract can be reviewed in one place before implementation:

```
# repo lifecycle
clone_repo(url, dest, recurse_submodules, depth?) -> streamed progress
init_repo(path, bare)
list_remotes() / add_remote(name, url) / remove_remote(name) / rename_remote(old, new)
push_target() -> { branch, remote, hasUpstream }   # DONE in P0 (D5); P1 can build on it

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
list_worktrees() / add_worktree(path, ref, detach) / remove_worktree(path, force)
                                        # list/add exist in core/worktree.rs; remove does not
graph_wip_rows()                        # folded into get_graph: one synthetic WIP row per worktree
predict_rebase_conflicts(onto, todo[]) -> [{ index, files[] }]   # trial-apply, moves no refs
conflict_set() -> [{ file, kind, regions[] }]                    # every conflicted file at once
blame_file(file, at)                    # DONE — add age buckets for the heatmap ramp
file_log(file, limit, follow)           # follow: --follow (G22)
line_log(file, start, end, limit)       # -L (G22)
merge_target(branch) -> { ref, ahead, behind }
contributors() -> [{ name, email, commits, lastCommit }]
resolve_terminal_token(token) -> { kind, oid }   # SHA / branch / tag / a..b from xterm output
autolink_patterns()                     # per-repo patterns + a built-in for origin's host
```

Two contract notes that are easy to get wrong:

- `search_commits` returns SHAs and page hints, **not rows**. The rows are already in the graph
  cache; re-serialising them doubles the payload for nothing. Results cache against
  `refs_digest()` so a fetch cannot leave a hit list pointing at a rewritten commit. It grew one
  field beyond the sketch: a row `index` as well as a `pageHint`, because the frontend needs the
  index to scroll to the hit *after* loading the page the hint named — and a `null` index is how
  a hit the graph does not contain (a stash commit) reports itself instead of being dropped.
- `predict_rebase_conflicts` is read-only and therefore takes **no op guard** (invariant 2), and
  must leave no trace: no ref moves, no index writes, no `ORIG_HEAD`. If it needs a worktree, it
  needs a temporary one it removes.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| **Line-level staging is fiddly.** Patch synthesis must get hunk headers, CRLF, and missing-trailing-newline right or it corrupts the index. | Ship hunk-level (git2 callback, no patch synthesis) first; gate line-level behind a broad test matrix and always apply via `git apply --cached`, which validates the patch for us. |
| **Interactive rebase via `GIT_SEQUENCE_EDITOR`** depends on git's todo format. | Format is stable and documented; pin behavior with an e2e test per verb rather than unit tests. |
| **Undo journal can drift** from repo reality if the user runs git in the terminal panel. | Validate each journal entry against current ref state before offering undo; invalidate the entry (and grey the button) on mismatch. |
| **The mutation seam is a single point of failure.** Every banner in the app is now one `operation_info` call (`ipc/repoState.ts`), where it used to be seven independent derivations. A regression there is invisible in seven places at once rather than one. | The single writer is the point — seven copies were how A1 hid. Backed by `operation_info_reports_a_conflict_it_was_never_told_about`, which pins the contract using a conflict made by the `git` binary directly. The seam's own reconciliation is still unverified by machine until P7 lands a frontend runner; that is the strongest remaining argument for pulling Vitest forward. |
| ~~**50k+ repo perf** is unmeasured because the gate is ignored.~~ Now measured: 269ms of a 500ms budget (debug build). | ✅ P0 turned the gate on. Still add a scroll-frame budget check per release, and watch for flake on slower CI runners. |
| **Windows has never been built.** | CI on all three OSes lands in P7, but run a manual Windows build **now** — P0 is done, and the longer it waits the worse the path/CRLF debt. (P0 note: the D4 deadlock tests are `#[cfg(unix)]`, so that path is unverified on Windows.) |
| **Scope creep into provider integrations.** | §2.5 is the contract: PR/issue panels are out until P7 ships. `docs/feature-requirements/00-overview.md` §8.2–§8.3 extends that contract over GitLens's whole account-gated tier, so "GitLens has it" is not an argument for building it. |
| **GitLens as a reference is licence-shaped.** Its `plus/` tree (Launchpad, AI, agents, Cloud Patches) is under `LICENSE.plus`, not MIT — and that is precisely the half whose features are most tempting to copy. | Read `plus/` for understanding only; never lift code from it. For the MIT half, matching *behaviour* is free but copying *code* owes attribution — cite the source file in a comment. §2.5 keeps the whole `plus/` feature set deferred anyway, which makes this mostly self-enforcing. |
| **Conflict prediction (G26) can be wrong**, and a wrong prediction is worse than none: a clean forecast that then conflicts destroys trust in the plan editor. | Label it an estimate in the UI, recompute on every reorder, and never gate Start Rebase on it. Test it against a fixture with a known-conflicting reorder, and against one where the conflict only appears *after* a squash — the case a naive per-commit check misses. |
| ~~**Search values reach the real `git` binary** (invariant 6), so a term beginning with `-` is command injection rather than a formatting bug.~~ | ✅ **Discharged in P5.** `no_operator_lets_a_leading_dash_reach_git_as_an_option` asserts, per operator, that a value beginning with `-` is either attached to its flag, after `--`, or rejected. `ref:` and `commit:` reject; the rest attach. Note that search does **not** go through `shellout.rs` — that path accepts fetch/pull/push only — so the guard lives in `core/search.rs::guard_standalone`. |

---

## 7. Effort

| Phase | Scope | Duration |
|---|---|---|
| ~~P0~~ | ~~Defect fixes (D1–D5)~~ | ✅ **done** |
| P1 | Clone/init/remotes/start screen/tabs | 1 wk — **unstarted** |
| ~~P2~~ | ~~Hunk + line staging~~ | ✅ **done** (`applyPatch` + per-hunk/per-line UI) |
| ~~P3~~ | ~~Commit form + undo journal~~ | ✅ **done** (summary/description, amend, hooks, undo/redo) |
| ~~P4~~ | ~~Conflict editor~~ | ✅ **done** (3-pane + per-file take-side); labels and region nav outstanding |
| ~~P5~~ | ~~Search, drag-drop, interactive rebase~~ | ✅ **done** (search grammar in Rust + three result modes + scroll markers; drag-drop; interactive rebase) |
| P6 | Settings, light theme, keybindings, icons | 1 wk — **unstarted** |
| P7 | CI, tests, packaging | 1 wk — **unstarted** |
| P8 | GitLens-derived surfaces (G16–G28) | 2–2.5 wk — **unstarted** |
| **Remaining** | P1, P6, P7, P8 + the gaps in `docs/feature-requirements/STATUS.md` | **~5–6.5 wk** (one dev) |

The UI/UX fidelity work in §3 is distributed across P1 (shell + start screen), P3 (undo toasts),
P5 (drop affordances), P6 (tokens, density, icons) and P8 (columns, gutter, detail stack) rather
than batched — a separate "make it look like GitKraken" phase at the end would mean rebuilding
components twice.

P8 is deliberately sequenced **after** P7 rather than before it, despite containing items
cheaper than anything in P6. The reason is that P7 stands up CI and the first frontend test
runner, and P8 is the largest body of *frontend* work left in the plan — landing it against a
suite that exists is worth more than landing it a fortnight sooner. The exception is anything in
P8 that is a correctness fix rather than a feature: `--follow` in file history (G22), and the
argument-injection guard that comes with search, should not wait for a phase boundary.

## 8. Suggested order of attack

If you want the shortest path to "this feels like GitKraken":

1. ~~**P0.D1 + P0.D2** — a stale or laggy graph undermines everything else.~~ ✅ done (all of
   P0 landed, not just D1/D2).
2. ~~**P2** — hunk staging is the feature users notice missing within five minutes.~~ ✅ done.
3. ~~**P3 undo** + toast affordance~~ ✅ done as a phase; the inline Undo *on toasts* is still
   outstanding (§3.3), and it is a half-day that changes how safe the app feels.
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
   did not, and stays in P8.
7. **P1** ← **next.** Clone / init / remotes / start screen, so the app is self-sufficient
   without the CLI. It is now the only phase standing between MTGit and a user who has never
   opened a terminal — every other remaining phase improves a repo they must already have
   cloned by hand.
8. **P8 item 1 (worktrees)** — cheapest large-surface win in the plan: the backend already
   exists, and it unblocks criteria in four of the seven feature docs.
9. **P8 item 6's cheap wins** opportunistically — **terminal links** is the best
   value-per-hour item in this document.
10. Then P6 → P7 → the rest of P8 in order.
