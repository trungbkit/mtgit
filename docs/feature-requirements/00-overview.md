# MTGit Feature Requirements — Overview & Shared Concepts

**Goal:** Bring MTGit's core git features (commit, checkout, push, pull, merge, rebase, cherry-pick) up to GitKraken-level UI/UX. These documents are the spec; the implementing agent should follow them closely and reference this overview for shared concepts.

## 0. What "GitKraken-level" means — the reference implementations

GitKraken is a *family*, not one product, and two members of it ship the same Commit Graph:

| Reference | What it is | What this spec takes from it |
|---|---|---|
| **GitKraken Desktop** | the standalone client | the shell — three-pane layout, lane graph, drag-and-drop as a primary gesture, the big-button toolbar, Undo/Redo |
| **GitLens** (`github.com/gitkraken/vscode-gitlens`) | GitKraken's git extension for VS Code, carrying the same Commit Graph | behavioural *detail* — the graph search grammar, the configurable column model, the unified conflict panel, the interactive-rebase editor, terminal links, autolinks |

GitLens is the more useful of the two as a spec source, because it is readable: everything in
that repo **outside** a directory named `plus/` is MIT-licensed (its `LICENSE`), so where this
document cites an exact operator, label or default, it was read out of that source rather than
guessed from a screenshot. Everything **under** `plus/` — Launchpad, the AI features, agent
sessions, Cloud Patches — is governed by `LICENSE.plus` and is *not* MIT; read it for
understanding, do not lift code from it. Even for the MIT half, copying *code* (as opposed to
matching *behaviour*) carries an attribution obligation — cite the source file in a comment if
you ever do.

**When the two references disagree, Desktop wins on shell and gesture; GitLens wins on grammar
and detail.** MTGit is a standalone client, so a GitLens feature that only exists because it
lives inside an editor — Git CodeLens, blame at the caret of a file you are typing in — has no
literal equivalent here. §8 lists every such feature with an explicit verdict: adapted to one
of our surfaces, or out of scope. The point of that list is that the boundary is decided once,
in writing, instead of re-litigated per PR.

**Stack context:** MTGit is a Tauri 2 + React 19 desktop app (Vite, TanStack Query, Zustand, @tanstack/react-virtual, xterm.js). Git operations execute in the Rust backend (`src-tauri`); the frontend renders state and issues commands via Tauri `invoke`.

**Docs in this set:**

| File | Feature |
|---|---|
| `01-commit.md` | Commit & staging (WIP node) |
| `02-checkout.md` | Checkout (branches, commits, detached HEAD) |
| `03-push.md` | Push (incl. force push, upstream) |
| `04-pull.md` | Pull & fetch |
| `05-merge.md` | Merge (incl. conflict resolution) |
| `06-rebase.md` | Rebase (incl. interactive rebase) |
| `07-cherry-pick.md` | Cherry-pick |
| `08-search-and-filter.md` | Commit search & graph filtering (the GitLens search grammar) |
| `STATUS.md` | **Audit of these docs against the code** — read this before planning work |

`01`–`07` are the seven core git operations. `08` is a cross-cutting surface rather than an
operation: it is how the user *finds* the commit they then act on, and it is specified
separately because it has its own grammar and its own backend command.

---

## 1. The Commit Graph (central UX surface)

Everything in GitKraken revolves around a single virtualized commit graph. All seven features must be reachable *from* the graph, not only from menus.

### 1.1 Layout
- Three-column central area: **BRANCH / TAG** (refs column), **GRAPH** (lane visualization), **COMMIT MESSAGE** (subject + inline summary of body, truncated with ellipsis).
- **Columns are user-configurable**, as in GitLens: drag a column header to reorder, right-click
  the header row to toggle columns on and off. Beyond the three above, the available columns are
  **Author**, **Changes**, **Date** and **SHA**. The Changes column renders a diffstat bar —
  added lines green, deleted lines red — which is the cheapest way to see the *shape* of a
  commit without selecting it. Column order and visibility persist per repo.
- **Minimap and scroll markers.** The scrollbar gutter carries markers for the checked-out
  branch, the selected row, and search hits, so a result off-screen is still locatable. An
  optional minimap beside it summarises activity over the whole history (commits per unit time,
  or lines changed); in GitLens it defaults to appearing *on search* rather than always, which
  is the right default here too — it earns its width only when you are hunting.
- One row per commit. Rows are virtualized (use `@tanstack/react-virtual`) — must stay smooth at 50k+ commits.
- Each branch gets a **lane** with a stable, distinct color. Edges (parent links) are drawn as smooth bezier curves when lanes merge/fork. Merge commits show two incoming edges.
- Commit nodes render the author's avatar inside a colored circle; multi-parent (merge) commits and WIP use distinct node shapes.
- **WIP row:** when the working directory is dirty, a special row appears *above* the current branch tip: dashed-outline node, italic `// WIP` label, count of changed files, and a pencil icon. Clicking it opens the commit panel (see `01-commit.md`). The row belongs to the checked-out branch's lane — it sits on that lane's x position, in that lane's colour, with a dashed edge down to the tip. It is a row *in* the list, not a strip above it: when HEAD is not the topmost commit, the WIP row is not topmost either. Because the frontend never computes layout (see `CLAUDE.md` invariant 5), the lane and edge for the WIP row come from `core/graph.rs` as a synthetic row, not from arithmetic in `GraphView`.
- **One WIP row per worktree, not per repository.** MTGit already lists and creates worktrees, and each one has its own working tree and therefore its own dirty state. GitLens renders a separate uncommitted-changes row for each, sitting on the lane of whatever that worktree has checked out; a single WIP row bound to the main worktree's HEAD is actively wrong once a second worktree is dirty, because it attributes one worktree's changes to another's branch. The row is labelled with the worktree name when more than one exists.

### 1.2 Ref labels (branch/tag pills)
- Local branches, remote branches, and tags render as rounded pills in the refs column, colored to match their lane.
- The checked-out branch pill shows a checkmark and a computer icon; a cloud icon indicates the branch exists on a remote. Local and remote pointers to the same branch collapse into one pill when they point at the same commit; they split into separate rows when diverged.
- Pills are interactive: double-click = checkout, drag = merge/rebase initiation (see feature docs), right-click = ref context menu.
- **Overflow collapses.** A commit carrying many refs shows a small number of pills inline and
  the rest as a `+N` chip that expands on hover or click. GitLens inlines *one* by default,
  which is aggressive but correct in spirit: the refs column has a fixed width, and a tag-heavy
  release commit must not push the graph column off-screen. Make the inline count a setting.
- **Ghost refs on row hover.** Hovering any row shows, in a dimmed style, the refs that *would*
  label it — the nearest branch/tag it is contained in — so a commit deep in a branch's history
  still tells you which branch you are looking at without scrolling to the tip.

### 1.3 Selection & detail panel
- Single-click a row selects the commit and opens the **right detail panel**: full message (subject + body), author avatar/name, authored date, short SHA, parent SHA, and the changed-file list (Path / Tree toggle, add/modify/delete icons per file).
- Clicking a file in the panel opens the **diff view** (side-by-side or inline toggle, syntax highlighted — use shiki) with File View / Diff View tabs, Blame and History buttons.
- Multi-select: Ctrl/Cmd-click for discrete selection, Shift-click for ranges. Multi-select enables range operations (cherry-pick range, interactive rebase range) and "compare two commits."
- **The detail panel is a stack, not a single slot.** GitLens presents commit, branch, stash and comparison details as stacked sheets in one panel, so opening a branch's details does not destroy the commit you were reading. Ours should behave the same way: pushing a new detail (select another commit, open a comparison) stacks it with a back affordance rather than replacing state the user still needs. This is also what makes "compare two commits" usable — the comparison is a sheet, not a mode you have to leave.

### 1.4 Commit context menu
Right-click on any commit row opens a context menu. Baseline entries (feature docs define behavior):
Checkout this commit · Create branch here · Cherry-pick commit · Rebase \<current branch\> onto this commit · Reset \<current branch\> to this commit (submenu: Soft/Mixed/Hard) · Revert commit · Edit commit message · Drop commit · Copy commit SHA · Create patch from commit · Compare against working directory · Create tag here · **Compare with common base** (merge-base of this commit and HEAD, not this commit itself — the question "what did this branch actually add" has the wrong answer without it) · **Open all changes with common base** · **Create worktree here** (see `02-checkout.md` §7).
Menu entries that don't apply (e.g., "Edit commit message" on a pushed non-HEAD commit without rewrite) are shown but perform history rewrite via rebase — with a warning when the commits are already pushed.

## 2. Left Panel (repo sidebar)

- Collapsible sections: **LOCAL** (local branches with ahead/behind arrows, e.g. `41↓`), **REMOTE** (per-remote tree of branches, folders like `feat/` collapse into expandable groups), **TAGS**, **STASHES**, **WORKTREES**, **SUBMODULES**, **CONTRIBUTORS**.
  WORKTREES is not optional garnish: the backend already lists and creates them, and each one owns a WIP row in the graph (§1.1), so there has to be a place to see and delete them. CONTRIBUTORS is read-only (name, commit count, last commit) and doubles as the picker for `author:` search (§7) and for co-author trailers (`01-commit.md` §3.2).
- Current branch is highlighted with a checkmark. Hover reveals a "hide/show in graph" eye toggle; a filter box (`⌘/Ctrl+F` style) filters refs by substring. The placeholder must name the *bound* shortcut — this is the only discoverability affordance the shortcut has, and it has already been wrong once (STATUS A5).
- **Sections scope the graph.** Selecting refs in the sidebar is the same thing as `ref:` in the search grammar (§7): the eye toggle and a section-level "show only this" both drive the graph's visible ref set rather than a second, parallel filter mechanism. One code path, two entry points.
- Double-click a branch = checkout. Drag a branch onto another branch (in the panel or onto graph pills) = initiates merge/rebase via drop menu.

## 3. Top Toolbar

Fixed toolbar with large icon buttons: **Undo, Redo, Fetch, Pull (with dropdown: Pull (merge) / Pull (rebase) / Pull (fast-forward only), plus "set this as the default"), Push (with dropdown: Push / Push (force with lease) / per-remote targets), Branch, Stash, Pop, Terminal**.

  Fetch and Pull are *separate* buttons rather than one Fetch button with a pull dropdown, because their badges mean different things: Fetch has no count (it is continuous and silent), Pull carries the behind count, Push the ahead count. A single button cannot show both.
- Buttons reflect state: disabled when inapplicable, with a tooltip that says why — Pop with no stash, Push with nothing ahead, Undo after a remote op. "Disabled" means the button is actually `disabled`; do not let a click through to a thrown error as the explanation.
- **Undo/Redo** is a first-class requirement: after any local-only destructive operation (commit, merge, rebase, cherry-pick, reset, drop, checkout), Undo restores the previous state via reflog. Redo reapplies. Operations that touched a remote are not undoable — the button tooltip explains why. GitLens markets exactly this as the safety net that makes its rebase tooling approachable ("restore the branch to its exact pre-rebase state in one click"); the feature is only worth that claim if it is *one* click from the place the operation was started, which is why every mutation toast carries an inline Undo as well (`GITKRAKEN_PARITY_PLAN.md` §3.3).
- **Jump-to navigation.** Three buttons (or a single split control) scroll the graph to and select: **HEAD**, the current branch's **upstream** tip, and its **merge target** — the branch it is destined to merge into, resolved as upstream's base branch → the repo's default branch. Merge target is the one users cannot compute in their heads, and it is what makes "am I behind the branch I will have to merge with?" answerable at a glance rather than after a comparison.

## 4. Shared Interaction Rules

- **Drag-and-drop is a primary interaction.** Dragging one ref onto another opens a drop menu listing the applicable actions (e.g., "Merge X into Y", "Rebase Y onto X", "Fast-forward", "Start pull request"). Every DnD action must also exist in a context menu (accessibility / discoverability parity).
- **Progress & feedback:** long operations stream their progress into the **status bar** (operation name + git's own progress line) with a Cancel button where git allows cancellation. Progress belongs there rather than in a toast: it is continuous, it must not stack with or displace outcome toasts, and it must not cover the graph. The button that started the operation also shows a spinner so the origin of the progress is obvious. Success = brief toast; failure = persistent toast with the raw git error, expandable, and a "Copy error" action.
- **Confirmation policy:** no modal confirmation for safe ops (checkout, fetch, commit). Confirmation dialogs only for destructive or remote-mutating ops (force push, hard reset, drop commit, discarding changes). Dialogs state exactly what will happen and name the refs involved.
- **The graph is never updated optimistically.** The frontend does not synthesize rows — lanes, edges and colours are the backend's (`CLAUDE.md` invariant 5), and a guessed row is a wrong row the moment two lanes are involved. Instead: the initiating control goes into a pending state immediately, the mutation invalidates on completion, and the re-layout budget below is what makes that feel instant. On failure, toast; there is nothing to roll back.
- **Every mutating path ends the same way:** invalidate this repo's queries *and* re-read the repository's in-progress state (`operation_info`). Do not rely on the fs watcher for this — mutating commands hold an op guard, so the watcher is deliberately quiet for 600 ms afterwards and the event that would have told you is dropped. The consequence of getting this wrong is a conflicted tree with no banner; it is the single most common way this app goes silently wrong.
- **Keyboard:** every context-menu action gets a shortcut where sensible (`⌘Enter` commit, `⌘P` push, `⌘⇧P` pull, `⌘Z` undo). All menus keyboard-navigable. A shortcut must work from anywhere in the app — if its handler lives in a panel, the shortcut is responsible for opening that panel first, not for silently doing nothing while the panel is closed.
- **Dates render in one configurable style.** A single setting picks relative (`3 days ago`) or absolute, with a format string for the absolute case, and it applies everywhere at once — graph rows, commit detail, blame, file history, hovers. Hovering a relative date shows the absolute one and vice versa, because the two answer different questions ("recent?" vs "which release?") and neither is right all the time.
- **Auto-fetch:** background fetch on an interval (default 1 min, configurable, 0 = off) updates ahead/behind counts and remote refs without touching the working tree. It runs **once when a repository is opened** — the first interval must not be a window of stale counts — and a change to the interval takes effect immediately, without reopening the repo.

## 5. Conflict Handling (shared by merge, rebase, cherry-pick, pull)

All conflicting operations share one UX:
1. Operation pauses; app enters a **conflict state banner** across the top of the graph: "Merge in progress — N conflicted files" with **Abort** and **Continue** (disabled until all conflicts resolved) buttons.
2. Right panel lists conflicted files. Clicking one opens the **merge conflict editor**: three sections — left, right, **Output** (bottom). Checkboxes next to each conflicting hunk let the user take left, right, or both; the output is directly editable as text.
3. Saving marks the file resolved (moves to staged). When all files are resolved, **Continue** completes the operation (creates merge commit / continues rebase / completes cherry-pick).
4. **Abort** always returns the repo to the exact pre-operation state.

### 5.1 Conflict state is discovered from the repository, never remembered
The banner is driven by `operation_info` — git's own `.git` state (`MERGE_HEAD`,
`rebase-merge/`, `CHERRY_PICK_HEAD`, the index's stage 1/2/3 entries) — read at repo open,
after every mutating command, and on every watcher event. It is never *only* the return value
of the operation that caused it. A conflict the user created in the terminal panel, and one
that survived an app restart, must produce the same banner as one we started ourselves.
The paused-operation counter (`i of n`) is the one piece git does not record for us, so it may
come from our own bookkeeping — with the file list and the operation kind still read from git.

### 5.2 Label the sides by what they are, not by git's pronouns
"Ours" and "Theirs" invert between merge and rebase/cherry-pick: during a rebase, *ours* is the
commit you are replaying **onto** (the new base) and *theirs* is your own commit being replayed.
Presenting the raw words is how users take the wrong side and then wonder why their work
vanished. Each pane is therefore labelled with the ref or commit it actually holds, coloured
with that ref's lane colour, and annotated with its role for the operation in progress:

| Operation | Left pane | Right pane |
|---|---|---|
| Merge A into B | `B` (current branch) | `A` (incoming) |
| Rebase B onto A | `A` (new base) | `<shortsha>` — your commit being replayed |
| Cherry-pick X | current branch | `X` (commit being applied) |
| Revert X | current branch | reverse of `X` |

### 5.3 One operation at a time
While an operation is paused, every other mutating entry point — checkout, pull, merge, rebase,
cherry-pick, reset — is refused with a toast that names the operation in progress and scrolls
the banner into view. Refuse it in the UI rather than letting git refuse it: git's message is
correct but does not tell the user where the Abort button is.

## 6. Non-Functional Requirements

- All git operations run in the Rust backend; never block the UI thread. Frontend state via TanStack Query with invalidation after each mutation.
- Graph re-layout after any operation must complete < 100 ms for repos ≤ 10k commits.
- Every feature doc's **Acceptance criteria** section is the definition of done; implement error cases, not just happy paths.
- No operation may lose user data silently: anything destructive goes through confirmation and/or is recoverable via Undo/reflog.

---

## 7. Search & Filter (shared)

The full grammar, backend contract and acceptance criteria live in `08-search-and-filter.md`.
What belongs here is the part every feature touches:

- **One search surface, in the graph header.** Not a modal, not a separate view. The graph is
  where commits are acted on, so it is where they are found; a search that navigates you away
  from the graph has cost you the context you were searching for.
- **Highlight, filter, or select.** A query has three result modes: *highlight* hits in place
  (history intact, hits marked in the row and in the scroll gutter), *filter* the graph down to
  hits only, or *select* them all for a range operation. Highlight is the default because it
  preserves topology — filtering a lane graph to a subset of commits draws edges between rows
  that are not actually parent and child, and that is a lie about history unless the user asked
  for it.
- **Hits are navigable without the mouse:** `F3` / `⌘G` next, `⇧F3` / `⇧⌘G` previous, wrapping,
  with an `n of m` counter. A search that finds 400 hits and makes you scroll to them is a
  search you will stop using.
- **`@me` resolves to the current git identity** wherever an author or committer is accepted.
- **Values reach `git` as data, never as options.** Search terms are user input that ends up on
  a `git log` command line; a value beginning with `-` would be consumed as a flag. GitLens
  drops such values outright for `ref:` and quotes the rest. Do the same — and note that this is
  a *security* rule for MTGit specifically, because `shellout.rs` runs the real `git` binary
  (`CLAUDE.md` invariant 6), so a swallowed `--upload-pack=…` is not a cosmetic bug.
- **Selection state survives a search.** Clearing the query returns the graph to where it was,
  with the previously selected commit still selected and still on screen.

## 8. GitLens features outside the seven — verdicts

GitLens carries a lot that has no counterpart in a standalone client, and a lot that has one
only if we say so. Deciding this once, here, is what keeps it out of every future PR review.

### 8.1 In scope — adapted to an MTGit surface

| GitLens feature | MTGit adaptation |
|---|---|
| **Whole-file blame** (in-editor annotation) | Already built (`core/blame.rs`). The adaptation owed: blame rows carry the *rich hover* below, and clicking a blame row selects that commit in the graph rather than opening a dead end. |
| **Rich hovers** over a blame/annotation row | Hover a blame line, a graph row, or a ref pill → commit message, author + avatar, absolute+relative date, changed-file count, and actions (select in graph, copy SHA, compare with working directory). This is one shared hover component, not three. |
| **Heatmap annotation** | Blame gutter tints by commit age — hot for recent, cold for old (GitLens defaults: `#f66a0a` hot, `#0a60f6` cold). Pure CSS over data we already fetch; the cheapest legibility win in the file viewer. |
| **Recent-changes annotation** | In the file-at-commit viewer, mark lines changed by the commit being viewed. |
| **File History / Line History** following renames and merges | `core/history.rs` exists but does not follow renames. `--follow` for the file case; line history needs `-L`. Both are load-bearing for blame being trustworthy across a refactor. |
| **Revision navigation** (step back/forward through a file's versions) | Prev/next buttons in the file viewer walking the file's own history, independent of the graph selection. |
| **Terminal links** | MTGit has an xterm panel (`pty.rs`). Make SHAs, branch names, tag names and `a..b` ranges printed there clickable → select in the graph. High value for near-zero cost, and it is the one thing that makes the terminal panel feel *integrated* rather than embedded. |
| **Autolinks** | Issue references in commit messages (`#123`, `ABC-456`) render as links in the message column and detail panel, using per-repo patterns plus a built-in for the `origin` host. Deliberately no API calls: link out, do not fetch issue state — that is provider integration (§8.3). |
| **Contributors view** | Sidebar section, §2. |
| **Search & Compare** — pinnable searches, ref comparison | `08-search-and-filter.md` covers search; comparison is the detail-panel sheet from §1.3. "Pinnable" means a query can be kept as a named filter for the session. |
| **Interactive Rebase Editor**, incl. **conflict prediction** | `06-rebase.md` §4 — prediction is a new criterion there. |
| **Unified conflict panel** | `05-merge.md` §5 — one panel holding every conflicted file, not a per-file mode. |
| **Git Command Palette** (guided, step-by-step git commands) | Extend the existing `⌘K` palette from a flat action list into guided multi-step flows for the commands whose arguments the user cannot be expected to recall. |
| **Worktrees**: create from branch/commit, per-worktree graph rows, copy changes between worktrees | Sidebar section (§2), WIP row per worktree (§1.1), `02-checkout.md` §7. |
| **Column configuration**, minimap, scroll markers, ghost refs | §1.1, §1.2. |

### 8.2 Out of scope — editor-only, no MTGit equivalent

- **Git CodeLens** (authorship/recent-change lenses above symbols) and **inline blame at the
  caret** presuppose an editing surface with a cursor and a symbol tree. MTGit's file viewer is
  read-only; the heatmap and blame gutter above cover the same need.
- **View detachment / default view / reset layout**, **`views.scm.grouped.*`** — these solve
  VS Code panel management. MTGit's layout is fixed by `GITKRAKEN_PARITY_PLAN.md` §3.2.
- **Files / Commits / Agent-activity treemaps** and **Visual File History** (the activity
  timeline) are genuinely good, but they are *visualisations*, not git operations, and each is
  a project the size of one of the seven features. Revisit after P7 ships.

### 8.3 Deferred — the `plus/` half

Everything GitLens gates behind an account, which is also everything under its non-MIT
`plus/` tree: **Launchpad** / PR panels, **agent sessions** and the Agent Kanban,
**GitKraken MCP**, **Cloud Patches**, **Cloud Workspaces**, and every AI feature (Review
Changes, Compose / Recompose Commits, Explain Changes, Generate Commit / Stash / PR message,
Generate Changelog, **Automatic Rebase** with AI conflict resolution, natural-language search).

These stay out for the same reason `GITKRAKEN_PARITY_PLAN.md` §2.5 keeps provider integration
out: they are GitKraken-family features but not *core git client* features, and each one drags
in an account system, a network boundary, or a model provider. The boundary is recorded so it
is a decision rather than an accident. Two of them are worth naming as the first candidates if
that ever changes, because they need no account of ours: **Generate commit message** and
**Explain changes** are single prompts over a diff we already compute.
