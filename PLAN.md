# MTGit — Implementation Plan

A GitKraken-style desktop git client. **Scope: Core MVP** — commit graph, branch management, staging/committing, push/pull/fetch, diff viewer, embedded terminal panel.

**Stack: Tauri 2 + React 18 + TypeScript**, git via `git2-rs` (libgit2 Rust bindings) in the Tauri backend.

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                  React Frontend (WebView)            │
│  ┌──────────┐ ┌────────────┐ ┌──────────────────┐   │
│  │ Sidebar  │ │ Commit     │ │ Detail Panel     │   │
│  │ (refs)   │ │ Graph      │ │ (commit + diff)  │   │
│  └──────────┘ └────────────┘ └──────────────────┘   │
│  Zustand stores ── TanStack Query ── invoke() layer  │
└──────────────────────────┬──────────────────────────┘
                    Tauri IPC (commands + events)
┌──────────────────────────┴──────────────────────────┐
│                   Rust Backend                       │
│  commands/ (thin handlers)                           │
│  core/     git2-rs: repo, graph, refs, diff, stage   │
│  shellout/ push/pull/fetch via system `git` (auth)   │
│  watcher/  fs + .git watcher → emits "repo-changed"  │
└─────────────────────────────────────────────────────┘
```

### Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Git access | `git2-rs` for reads (log, refs, diff, status) | Fast, structured data, no parsing of porcelain output |
| Network ops | Shell out to system `git` for push/pull/fetch/clone | Inherits user's credential helpers, SSH agent, proxies — the #1 pain point of libgit2 |
| Graph layout | Compute lanes/edges in Rust, render in frontend | Layout is CPU-bound on 10k+ commits; keep WebView light |
| Graph rendering | Canvas for edges/nodes + virtualized DOM rows for text | GitKraken's approach; DOM-only dies at ~2k rows, canvas-only ruins accessibility/text selection |
| State | Zustand (UI state) + TanStack Query (repo data, keyed by repo path + HEAD oid) | Cache invalidation on `repo-changed` events becomes trivial |
| Diff rendering | Custom component fed by structured hunks from Rust | Full control over inline/split view, syntax highlight via `shiki` |
| Terminal | `xterm.js` frontend + `portable-pty` in Rust | Standard, proven combo |

### IPC contract (representative commands)

```
open_repo(path) -> RepoInfo
get_graph(repo, skip, limit) -> { rows: GraphRow[], total }
get_commit(repo, oid) -> CommitDetail        // author, parents, changed files
get_diff(repo, oid | staged | unstaged, path?) -> FileDiff[]
get_status(repo) -> { staged: [], unstaged: [], conflicted: [] }
stage_paths / unstage_paths / discard_paths(repo, paths)
commit(repo, message, amend?) -> oid
create_branch / delete_branch / checkout(repo, ref)
push / pull / fetch(repo, remote, opts) -> streamed progress events
stash_save / stash_pop / stash_list(repo)
```

`GraphRow` is the core type: `{ oid, summary, author, date, refs: RefBadge[], lane: u8, edges: Edge[] }` where `Edge = { fromLane, toLane, kind: continue|branch|merge, color }`. The frontend never computes layout — it just draws.

---

## 2. Repo Structure

```
mtgit/
├── src/                      # React frontend
│   ├── app/                  # shell: layout, tabs, toolbar, theme
│   ├── features/
│   │   ├── graph/            # canvas graph + virtualized rows
│   │   ├── sidebar/          # local/remote branches, tags, stashes
│   │   ├── commit-detail/    # right panel: metadata + file list
│   │   ├── diff/             # diff viewer (inline/split)
│   │   ├── staging/          # WIP row, stage/unstage, commit form
│   │   └── terminal/         # xterm.js panel
│   ├── ipc/                  # typed invoke() wrappers, event listeners
│   ├── stores/               # zustand: ui, repo-session
│   └── components/           # shared primitives
├── src-tauri/
│   ├── src/
│   │   ├── commands/         # tauri command handlers (thin)
│   │   ├── core/             # graph.rs, diff.rs, refs.rs, status.rs, commit.rs
│   │   ├── shellout.rs       # push/pull/fetch via system git, progress parsing
│   │   ├── watcher.rs        # notify-based fs watcher, debounced
│   │   └── pty.rs            # terminal sessions
│   └── Cargo.toml            # tauri, git2, notify, portable-pty, serde
└── e2e/                      # WebdriverIO/tauri-driver tests
```

Frontend tooling: Vite, Tailwind, `@tanstack/react-query`, `@tanstack/react-virtual`, `zustand`, `xterm.js`, `shiki`.

---

## 3. Milestones

### M0 — Foundation (Week 1)
- Scaffold Tauri 2 + Vite + React + TS; CI (lint, clippy, test, build on macOS/Win/Linux).
- App shell: dark theme tokens (CSS variables), three-pane resizable layout (sidebar / graph / detail), toolbar with placeholder actions.
- `open_repo` command + recent-repos list + repo picker dialog.
- Typed IPC layer: one `invoke<T>()` wrapper, shared types generated from Rust via `specta`/`tauri-specta` (avoids hand-syncing TS and Rust types).

**Exit:** open a real repo, see its name and HEAD branch in the shell.

### M1 — Commit graph, read-only (Weeks 2–4) ← the hard one
- **Rust:** revwalk over all branch heads (topological + time order), lane-assignment algorithm:
  - Iterate commits newest→oldest; maintain active-lane list of "expected parent" oids.
  - A commit takes the lane of the first slot expecting it; merge parents open new lanes; lanes close when a parent is claimed. Color = lane index mod palette.
  - Paginate: `get_graph(skip, limit)` returns rows plus edge continuations at window edges so scrolling windows stitch seamlessly.
- **Frontend:** virtualized rows (`@tanstack/react-virtual`), one `<canvas>` layer behind rows for edges/dots, DOM for message/author/date/badges. Ref badges (branch/tag/HEAD, local vs remote icons) from screenshot.
- Row selection, keyboard navigation, hover highlight of a commit's edge path.
- Benchmark gate: smooth scroll on a 50k-commit repo (test on `linux` or `chromium` clone).

**Exit:** graph visually comparable to the screenshot on a large real repo.

### M2 — Commit detail + diff viewer (Weeks 5–6)
- Right panel: commit message, author (gravatar), date, parents, changed-file list with Path/Tree toggle and add/modify/delete markers.
- Diff engine in Rust: structured hunks (`FileDiff { path, status, hunks: [{header, lines: [{kind, old_no, new_no, text}]}] }`), rename detection, binary/image detection, large-file guard.
- Diff viewer: inline + split modes, syntax highlighting (`shiki`, lazy-loaded grammars), intra-line word diff, collapse unchanged regions.

**Exit:** click any commit → see its diff; matches screenshot's file-list UX.

### M3 — Staging & committing (Weeks 7–8)
- WIP row pinned atop the graph when working tree is dirty (GitKraken pattern).
- Status view: staged/unstaged/conflicted lists; stage/unstage per file and **per hunk** (per-line stretch goal); discard with confirmation.
- Commit form: summary + description fields, amend checkbox, commit signing passthrough.
- fs watcher (`notify`, 300ms debounce, ignore `.git/objects`) → emit `repo-changed` → TanStack Query invalidation. This event loop is what makes the app feel "live".

**Exit:** full edit → stage → commit loop without touching the CLI.

### M4 — Branches & remote ops (Weeks 9–10)
- Sidebar: local/remote branch trees (folder grouping by `/` prefix like `feat/…`), tags, stashes; filter box; ahead/behind counts; checkout on double-click; create/rename/delete via context menu.
- Push/pull/fetch via `git` shellout with streamed progress (parse `--progress` stderr) shown in toolbar; graceful auth failure messages.
- Drag-and-drop merge (drag branch onto branch → merge confirmation) — signature GitKraken interaction; plus merge via context menu, conflict list surfaced (resolution UI = open in external tool for MVP).
- Stash save/pop/apply.
- Undo for safe operations (checkout, branch delete via reflog).

**Exit:** daily-driver capable for the standard workflow.

### M5 — Terminal + polish (Weeks 11–12)
- Bottom terminal panel: `portable-pty` + `xterm.js`, cwd = repo root, collapsible (as in screenshot).
- Multi-repo tabs (screenshot shows 3 tabs) — repo session per tab, lazy-loaded.
- Command palette (⌘K): checkout, create branch, open repo.
- Error toasts, empty states, loading skeletons, keyboard shortcut map, settings (font size, diff mode, default clone dir).
- Packaging: signed builds for macOS (notarized), Windows (MSI), Linux (AppImage/deb); auto-update via Tauri updater.

**Exit:** shippable 0.1.

---

## 4. Hard Problems & Mitigations

1. **Graph performance.** Lane layout in Rust + pagination + canvas. Never render >~60 DOM rows. Profile with 50k+ commit repos from day one of M1.
2. **Auth for push/pull.** Solved by shelling out to system git — do NOT fight libgit2 credentials. Detect missing git binary at startup and warn.
3. **Type drift across IPC.** `tauri-specta` generates TS types from Rust structs; contract lives in one place.
4. **Watcher storms** (checkout of big branch = thousands of fs events). Debounce + coalesce into a single `repo-changed`; pause watcher during our own operations.
5. **libgit2 gaps** (worktrees, sparse checkout, some merge cases). Escape hatch: `shellout.rs` can run any git command and re-sync state after.
6. **Windows paths/line endings.** CI runs the Rust test suite on all three OSes from M0.

## 5. Testing Strategy

- **Rust unit tests** on fixture repos built programmatically (git2) covering: lane algorithm topologies (octopus merges, criss-cross, orphan branches), diff edge cases, status states. This is where most correctness lives.
- **Frontend:** Vitest + Testing Library for stores/components; Storybook for graph rows, badges, diff lines.
- **E2E:** tauri-driver/WebdriverIO smoke: open repo → scroll graph → select commit → stage → commit → check `git log`.
- **Perf gate in CI:** graph layout of 50k commits < 500ms; scroll frame budget test manual per release.

## 6. Effort Estimate

| Milestone | Duration | Notes |
|---|---|---|
| M0 Foundation | 1 wk | |
| M1 Graph | 3 wk | Highest risk; prototype lane algorithm in week 1 |
| M2 Diff | 2 wk | |
| M3 Staging | 2 wk | |
| M4 Branches/remotes | 2 wk | |
| M5 Terminal/polish | 2 wk | |
| **Total** | **~12 wk** | 1 experienced full-stack dev; ~8 wk with 2 devs (Rust/graph + React/diff split cleanly) |

## 7. Explicitly Out of Scope (post-MVP backlog)

Interactive rebase UI, GitHub/GitLab PR & issue integration, in-app merge conflict editor, cloud patches, GPG key management UI, LFS UI, submodule UI, light theme, AI commit messages.

## 8. First Concrete Steps

1. `pnpm create tauri-app mtgit --template react-ts`
2. Add `git2`, `specta`, `notify` to Cargo; wire `open_repo` + `get_graph` returning unstyled rows.
3. **Prototype the lane algorithm against this repo (`e2e-frontend-mch`) and one huge OSS repo** — validate the riskiest piece before building any UI around it.
4. Build the three-pane shell with theme tokens sampled from the screenshot (near-black `#22272e`-family background, lane palette of ~8 saturated hues).
