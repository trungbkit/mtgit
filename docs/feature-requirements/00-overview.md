# MTGit Feature Requirements — Overview & Shared Concepts

**Goal:** Bring MTGit's core git features (commit, checkout, push, pull, merge, rebase, cherry-pick) up to GitKraken-level UI/UX. These documents are the spec; the implementing agent should follow them closely and reference this overview for shared concepts.

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

---

## 1. The Commit Graph (central UX surface)

Everything in GitKraken revolves around a single virtualized commit graph. All seven features must be reachable *from* the graph, not only from menus.

### 1.1 Layout
- Three-column central area: **BRANCH / TAG** (refs column), **GRAPH** (lane visualization), **COMMIT MESSAGE** (subject + inline summary of body, truncated with ellipsis).
- One row per commit. Rows are virtualized (use `@tanstack/react-virtual`) — must stay smooth at 50k+ commits.
- Each branch gets a **lane** with a stable, distinct color. Edges (parent links) are drawn as smooth bezier curves when lanes merge/fork. Merge commits show two incoming edges.
- Commit nodes render the author's avatar inside a colored circle; multi-parent (merge) commits and WIP use distinct node shapes.
- **WIP row:** when the working directory is dirty, a special row appears *above* the current branch tip: dashed-outline node, italic `// WIP` label, count of changed files, and a pencil icon. Clicking it opens the commit panel (see `01-commit.md`).

### 1.2 Ref labels (branch/tag pills)
- Local branches, remote branches, and tags render as rounded pills in the refs column, colored to match their lane.
- The checked-out branch pill shows a checkmark and a computer icon; a cloud icon indicates the branch exists on a remote. Local and remote pointers to the same branch collapse into one pill when they point at the same commit; they split into separate rows when diverged.
- Pills are interactive: double-click = checkout, drag = merge/rebase initiation (see feature docs), right-click = ref context menu.

### 1.3 Selection & detail panel
- Single-click a row selects the commit and opens the **right detail panel**: full message (subject + body), author avatar/name, authored date, short SHA, parent SHA, and the changed-file list (Path / Tree toggle, add/modify/delete icons per file).
- Clicking a file in the panel opens the **diff view** (side-by-side or inline toggle, syntax highlighted — use shiki) with File View / Diff View tabs, Blame and History buttons.
- Multi-select: Ctrl/Cmd-click for discrete selection, Shift-click for ranges. Multi-select enables range operations (cherry-pick range, interactive rebase range) and "compare two commits."

### 1.4 Commit context menu
Right-click on any commit row opens a context menu. Baseline entries (feature docs define behavior):
Checkout this commit · Create branch here · Cherry-pick commit · Rebase \<current branch\> onto this commit · Reset \<current branch\> to this commit (submenu: Soft/Mixed/Hard) · Revert commit · Edit commit message · Drop commit · Copy commit SHA · Create patch from commit · Compare against working directory · Create tag here.
Menu entries that don't apply (e.g., "Edit commit message" on a pushed non-HEAD commit without rewrite) are shown but perform history rewrite via rebase — with a warning when the commits are already pushed.

## 2. Left Panel (repo sidebar)

- Collapsible sections: **LOCAL** (local branches with ahead/behind arrows, e.g. `41↓`), **REMOTE** (per-remote tree of branches, folders like `feat/` collapse into expandable groups), **TAGS**, **STASHES**, **SUBMODULES**.
- Current branch is highlighted with a checkmark. Hover reveals a "hide/show in graph" eye toggle; a filter box (`⌘/Ctrl+F` style) filters refs by substring.
- Double-click a branch = checkout. Drag a branch onto another branch (in the panel or onto graph pills) = initiates merge/rebase via drop menu.

## 3. Top Toolbar

Fixed toolbar with large icon buttons: **Undo, Redo, Fetch (with dropdown: Fetch / Pull / Pull (rebase) / Pull (fast-forward)), Push, Branch, Stash, Pop, Terminal**.
- Buttons reflect state: disabled when inapplicable (e.g., Pop with no stash); Push shows a badge with the number of unpushed commits; Fetch shows ahead/behind counts after auto-fetch.
- **Undo/Redo** is a first-class requirement: after any local-only destructive operation (commit, merge, rebase, cherry-pick, reset, drop, checkout), Undo restores the previous state via reflog. Redo reapplies. Operations that touched a remote are not undoable — the button tooltip explains why.

## 4. Shared Interaction Rules

- **Drag-and-drop is a primary interaction.** Dragging one ref onto another opens a drop menu listing the applicable actions (e.g., "Merge X into Y", "Rebase Y onto X", "Fast-forward", "Start pull request"). Every DnD action must also exist in a context menu (accessibility / discoverability parity).
- **Progress & feedback:** long operations show an inline progress toast (bottom-left) with operation name and a Cancel button where git allows cancellation. Success = brief toast; failure = persistent toast with the raw git error, expandable, and a "Copy error" action.
- **Confirmation policy:** no modal confirmation for safe ops (checkout, fetch, commit). Confirmation dialogs only for destructive or remote-mutating ops (force push, hard reset, drop commit, discarding changes). Dialogs state exactly what will happen and name the refs involved.
- **Graph updates optimistically** where safe (e.g., commit appears instantly), reconciled after the backend confirms. On failure, roll back and toast.
- **Keyboard:** every context-menu action gets a shortcut where sensible (`⌘Enter` commit, `⌘P` push, `⌘⇧P` pull, `⌘Z` undo). All menus keyboard-navigable.
- **Auto-fetch:** background fetch on an interval (default 1 min, configurable) updates ahead/behind counts and remote refs without touching the working tree.

## 5. Conflict Handling (shared by merge, rebase, cherry-pick, pull)

All conflicting operations share one UX:
1. Operation pauses; app enters a **conflict state banner** across the top of the graph: "Merge in progress — N conflicted files" with **Abort** and **Continue** (disabled until all conflicts resolved) buttons.
2. Right panel lists conflicted files. Clicking one opens the **merge conflict editor**: three sections — "Ours" (left), "Theirs" (right), **Output** (bottom). Checkboxes next to each conflicting hunk let the user take left, right, or both; the output is directly editable as text.
3. Saving marks the file resolved (moves to staged). When all files are resolved, **Continue** completes the operation (creates merge commit / continues rebase / completes cherry-pick).
4. **Abort** always returns the repo to the exact pre-operation state.

## 6. Non-Functional Requirements

- All git operations run in the Rust backend; never block the UI thread. Frontend state via TanStack Query with invalidation after each mutation.
- Graph re-layout after any operation must complete < 100 ms for repos ≤ 10k commits.
- Every feature doc's **Acceptance criteria** section is the definition of done; implement error cases, not just happy paths.
- No operation may lose user data silently: anything destructive goes through confirmation and/or is recoverable via Undo/reflog.
