# Feature: Commit & Staging (GitKraken-style)

> Read `00-overview.md` first for shared concepts (graph, WIP node, toasts, undo).

## 1. Summary

Committing in GitKraken is centered on the **WIP node** in the graph and the **commit panel** on the right. There is no separate "staging screen" — selecting the WIP row turns the right panel into the staging/commit workspace.

## 2. Entry Points

- Click the `// WIP` row in the graph (appears whenever the working tree is dirty).
- Click the "N file changes in working directory — View Changes" banner at the top of the right panel.
- Keyboard: `⌘/Ctrl+Shift+C` focuses the commit message box.

## 3. UI Requirements

### 3.1 WIP node (graph)
- Appears as the topmost row on the checked-out branch's lane when there are uncommitted changes (unstaged, staged, or untracked). Dashed circle node, italic `// WIP` text, pencil icon + count of changed files.
- Disappears immediately after a commit that empties the working tree, or after stash/discard.
- Updates live via filesystem watcher (debounced ≤ 500 ms); no manual refresh.

### 3.2 Commit panel (right side, when WIP selected)
Vertical layout, top to bottom:
1. **Unstaged Files** section — header with file count and bulk actions: **Stage all**, **Discard all** (confirmation required). Each file row: status icon (A/M/D/R, colored), path (directory dimmed, filename bright), and hover actions: **Stage file**, **Discard changes** (confirm), open context menu (stage, discard, ignore — adds to `.gitignore`, copy path, open in external editor).
- Path/Tree view toggle like the commit detail panel.
2. **Staged Files** section — same row design, hover action **Unstage file**, header action **Unstage all**.
3. **Commit Message** — two inputs: single-line **Summary** (counter turns amber past 50 chars, never blocks) and multi-line **Description**. Both persist per-repo across app restarts until committed.
4. **Commit button** — full-width: `Commit changes to N files`. Disabled when staged list is empty or summary is blank; tooltip explains why. `⌘/Ctrl+Enter` in either text field triggers commit.
5. **Amend checkbox** — toggles "Amend last commit": pre-fills message fields from HEAD; button becomes `Amend Previous Commit`. Warn inline (not modal) if HEAD is already pushed.

### 3.3 Hunk-level staging
- Clicking a file in Unstaged/Staged opens its diff in the center view with per-hunk **Stage hunk / Unstage hunk / Discard hunk** buttons in each hunk header, and line-level staging via gutter selection (select lines → "Stage selected lines").
- Discard hunk requires confirmation (destructive, but undoable via Undo within session).

## 4. Behavior

| # | Rule |
|---|---|
| B1 | Commit uses the staged snapshot only; unstaged changes remain in the working tree. |
| B2 | Message = summary + blank line + description (standard git format). |
| B3 | On success: WIP row is replaced by the new commit row at the branch tip (optimistic), toast "Committed \<shortsha\>", message fields clear. |
| B4 | Amend rewrites HEAD (`--amend`); graph updates the tip row in place; ahead/behind counts recalc. |
| B5 | Commit signing (GPG/SSH) honored if configured in git config; surface signing errors verbatim in the failure toast. |
| B6 | Hooks (pre-commit, commit-msg) run by default; non-zero hook exit shows hook stdout/stderr in the failure toast with a "Commit anyway (skip hooks)" action that re-runs with `--no-verify`. |
| B7 | Undo after commit = `reset --soft HEAD~1` (files return to staged, message restored to fields). |

## 5. Edge Cases

- Empty repo (no HEAD): commit creates the root commit; amend hidden.
- Merge/rebase/cherry-pick in progress with resolved conflicts: commit button becomes **Continue \<operation\>** (see conflict UX in overview §5).
- Detached HEAD: committing is allowed; banner warns commits may be unreachable and offers "Create branch here."
- Large untracked binaries: show file size in row; no diff preview above a size threshold (default 10 MB), show "binary/too large" placeholder.
- File both staged and further modified: appears in *both* sections (matching git index semantics).

## 6. Acceptance Criteria

- [ ] Dirty working tree always produces a WIP row; clean tree never does; updates are automatic (watcher).
- [ ] Stage/unstage at file, hunk, and line level all work and are reflected in `git status` ground truth.
- [ ] Commit disabled states + tooltips correct; `⌘Enter` commits.
- [ ] Amend pre-fills, rewrites HEAD, and warns when HEAD is pushed.
- [ ] Failed hook shows output and offers `--no-verify` retry.
- [ ] Undo restores pre-commit state exactly (index + message).
- [ ] Discard actions always confirm and never touch files not listed.
