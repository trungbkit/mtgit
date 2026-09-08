# MTGit — GitKraken Parity Plan

Goal: close the gap between MTGit today and **GitKraken's core feature set**, with a UI/UX
that reads as the same product family.

This plan supersedes neither `PLAN.md` (the original MVP roadmap, now largely delivered) nor
`VERIFY_HARDEN_PLAN.md` (P0/P1 hardening, cleared). It started from what was actually in the
tree and describes work that was *not yet done* at the time of writing; phases are struck
through and annotated as they land.

---

## 1. Baseline — verified state of the repo

> **Status: P0 complete (2026-09-08).** Sections 2.4 and 4/P0 below record what landed.
> The rest of the plan is unchanged and unstarted.

Measured, not assumed: `pnpm exec tsc --noEmit` exits 0, `vite build` succeeds, `cargo clippy
--all-targets -- -D warnings` is clean, and `cargo test` reports **37 passed, 0 failed,
0 ignored** — the 50k-commit perf gate now runs in the default suite. ~9k lines across
`src/` + `src-tauri/src/`.

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

## 2. Gap analysis vs GitKraken core

Grouped by how much it hurts a user who switches from GitKraken to MTGit today.

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
| G10 | **No commit search / filter** | No search by message, author, sha, or file; no branch-scoped ("solo") graph view; no date range. |

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

### 3.2 Layout

Target GitKraken's chrome, top to bottom:

```
┌─ tab strip ── [repo A] [repo B] [+] ───────────────────────────────────┐
├─ toolbar ── repo▾  branch▾  ⟳ │ ↶ ↷ │ Pull Push Branch Stash Pop │ ⚙ 🔍 ▥ ┤
├──────────┬─────────────────────────────────────────┬───────────────────┤
│ sidebar  │ graph  (BRANCH/TAG │ GRAPH │ MESSAGE …) │ commit detail     │
│ Local    │  ◌ // WIP                               │  avatar + author  │
│ Remote   │  ● merge feature into main              │  sha, date        │
│ PRs      │  ● fix: …                               │  Files changed(N) │
│ Tags     │                                         │   [Path|Tree]     │
│ Stashes  │                                         │                   │
│ Worktrees│                                         │                   │
├──────────┴─────────────────────────────────────────┴───────────────────┤
│ terminal (collapsible)                                                 │
├────────────────────────────────────────────────────────────────────────┤
│ status bar — progress line, ahead/behind, HEAD                          │
└────────────────────────────────────────────────────────────────────────┘
```

Changes from today's shell:
1. **Tab strip always visible** with a `+` that opens the start screen in a new tab (G12, G3).
2. **Sidebar sections in GitKraken order** with per-remote grouping and provider icons (G4).
3. **Graph column headers stay**, plus a search field in the header and a density control in
   the gear popover (G10).
4. **Right panel becomes a stack**: commit header → files → (optionally) inline diff, with the
   center panel able to take over for full-width diff — GitKraken's "focus view".

### 3.3 Component-level details that carry the look

- **Ref badges → pills.** Rounded, filled pills; checked-out local branch gets the accent fill
  plus a HEAD marker; remote branches get a cloud/provider glyph; tags get the tag glyph.
  Overflow collapses to `+N` with a hover popover.
- **Graph nodes.** Keep the avatar-in-node (already done, and it is the most GitKraken-ish
  detail in the app). Add: hollow dashed node for the WIP row, larger ring on the selected row,
  and hover-dimming of unrelated lanes so a commit's ancestry path pops.
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

### P2 — Hunk and line staging (1 week) → closes G5

The highest-value single feature in the plan.

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

### P3 — Commit experience + undo (1 week) → closes G7, G9

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

### P4 — Conflict resolution editor (1–1.5 weeks) → closes G6

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

### P5 — Graph power tools (1–1.5 weeks) → closes G10, G11, G8

- **Search & filter:** a graph-header search that filters by message / author / sha / touched
  file (backend `search_commits(query, filters, limit)` over the cached rows plus a pathspec
  revwalk), and a branch-scoped "solo" mode that seeds the revwalk from selected refs only.
- **Graph drag-and-drop:** drag a sidebar branch or a graph row onto another row/branch → drop
  menu offering merge / rebase / reset / cherry-pick, with legal-target highlighting and the
  floating intent pill.
- **Interactive rebase:** UI builds a todo list (pick / reword / edit / squash / fixup / drop,
  reorderable), then runs `git rebase -i` with `GIT_SEQUENCE_EDITOR` set to a helper that copies
  our generated todo file into place. This reuses the existing conflict banner + P4 editor for
  the stop-and-resolve loop, so the interactive part is mostly UI.

**Exit:** the three GitKraken interactions users reach for daily — search, drag-to-merge,
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
search_commits(query, filters, limit)
rebase_interactive(onto, todo[])
```

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| **Line-level staging is fiddly.** Patch synthesis must get hunk headers, CRLF, and missing-trailing-newline right or it corrupts the index. | Ship hunk-level (git2 callback, no patch synthesis) first; gate line-level behind a broad test matrix and always apply via `git apply --cached`, which validates the patch for us. |
| **Interactive rebase via `GIT_SEQUENCE_EDITOR`** depends on git's todo format. | Format is stable and documented; pin behavior with an e2e test per verb rather than unit tests. |
| **Undo journal can drift** from repo reality if the user runs git in the terminal panel. | Validate each journal entry against current ref state before offering undo; invalidate the entry (and grey the button) on mismatch. |
| ~~**50k+ repo perf** is unmeasured because the gate is ignored.~~ Now measured: 269ms of a 500ms budget (debug build). | ✅ P0 turned the gate on. Still add a scroll-frame budget check per release, and watch for flake on slower CI runners. |
| **Windows has never been built.** | CI on all three OSes lands in P7, but run a manual Windows build **now** — P0 is done, and the longer it waits the worse the path/CRLF debt. (P0 note: the D4 deadlock tests are `#[cfg(unix)]`, so that path is unverified on Windows.) |
| **Scope creep into provider integrations.** | §2.5 is the contract: PR/issue panels are out until P7 ships. |

---

## 7. Effort

| Phase | Scope | Duration |
|---|---|---|
| ~~P0~~ | ~~Defect fixes (D1–D5)~~ | ✅ **done** |
| P1 | Clone/init/remotes/start screen/tabs | 1 wk |
| P2 | Hunk + line staging | 1 wk |
| P3 | Commit form + undo journal | 1 wk |
| P4 | Conflict editor | 1–1.5 wk |
| P5 | Search, drag-drop, interactive rebase | 1–1.5 wk |
| P6 | Settings, light theme, keybindings, icons | 1 wk |
| P7 | CI, tests, packaging | 1 wk |
| **Remaining** | P1–P7 | **~7–8 wk** (one dev) · **~4–5 wk** (two, splitting Rust core / React shell) |

The UI/UX fidelity work in §3 is distributed across P1 (shell + start screen), P3 (undo toasts),
P5 (drop affordances), and P6 (tokens, density, icons) rather than batched — a separate
"make it look like GitKraken" phase at the end would mean rebuilding components twice.

## 8. Suggested order of attack

If you want the shortest path to "this feels like GitKraken":

1. ~~**P0.D1 + P0.D2** — a stale or laggy graph undermines everything else.~~ ✅ done (all of
   P0 landed, not just D1/D2).
2. **P2** — hunk staging is the feature users notice missing within five minutes. ← **next**
3. **P1** — clone/start screen, so the app is self-sufficient.
4. **P3 undo** + toast affordance — this is what makes the app feel safe.
5. Then P4 → P5 → P6 → P7 in order.
