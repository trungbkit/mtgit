# Feature: Commit & Staging (GitKraken-style)

> Read `00-overview.md` first for shared concepts (graph, WIP node, toasts, undo).

## 1. Summary

Committing in GitKraken is centered on the **WIP node** in the graph and the **commit panel** on the right. There is no separate "staging screen" — selecting the WIP row turns the right panel into the staging/commit workspace.

## 2. Entry Points

- Click the `// WIP` row in the graph (appears whenever the working tree is dirty).
- Click the "N file changes in working directory — View Changes" banner at the top of the right panel.
- Keyboard: `⌘/Ctrl+Shift+C` selects the WIP row (opening the commit panel if it is closed) and focuses the Summary field.

## 3. UI Requirements

### 3.1 WIP node (graph)
- Appears as the topmost row on the checked-out branch's lane when there are uncommitted changes (unstaged, staged, or untracked). Dashed circle node, italic `// WIP` text, pencil icon + count of changed files.
- **One row per worktree** (overview §1.1). Each worktree has its own index and working tree, so each gets its own WIP row on the lane of whatever *it* has checked out, labelled with the worktree name once there is more than one. Selecting a worktree's WIP row opens the commit panel for **that** worktree — staging and committing there must not act on the main one.
- Disappears immediately after a commit that empties the working tree, or after stash/discard.
- Updates live via filesystem watcher (debounced ≤ 500 ms); no manual refresh.

### 3.2 Commit panel (right side, when WIP selected)
Vertical layout, top to bottom:
1. **Unstaged Files** section — header with file count and bulk actions: **Stage all**, **Discard all** (confirmation required). Each file row: status icon (A/M/D/R, colored), path (directory dimmed, filename bright), and hover actions: **Stage file**, **Discard changes** (confirm), open context menu (stage, discard, ignore — adds to `.gitignore`, copy path, open in external editor).
- Path/Tree view toggle like the commit detail panel.
2. **Staged Files** section — same row design, hover action **Unstage file**, header action **Unstage all**.
- The section headers also carry **Stash** (all changes, or staged only) and, when a second worktree exists, **Copy changes to worktree…** — GitLens treats moving uncommitted work between worktrees as a first-class action, and it is the whole point of having worktrees: you started in the wrong one.
3. **Commit Message** — two inputs: single-line **Summary** (counter turns amber past 50 chars, never blocks) and multi-line **Description**. Both persist per-repo across app restarts until committed.
- **Co-author picker**: a button appends `Co-authored-by:` trailers, offering the CONTRIBUTORS list (overview §2) rather than free text, so the trailer is spelled the way git and the forge expect.
- **`commit.template` is honoured**: when configured and the fields are empty, the template pre-fills the Description.
- **Autolinks render in the preview**: an issue reference in the message (`#123`, `ABC-456`) is shown as a link, using the same per-repo patterns as the graph message column (overview §8.1). This is a preview affordance only — it does not rewrite the message.
4. **Commit button** — full-width: `Commit changes to N files`. Disabled when staged list is empty or summary is blank; tooltip explains why. `⌘/Ctrl+Enter` in either text field triggers commit.
5. **Amend checkbox** — toggles "Amend last commit": pre-fills message fields from HEAD; button becomes `Amend Previous Commit`. Warn inline (not modal) if HEAD is already pushed.

### 3.3 Hunk-level staging
- Clicking a file in Unstaged/Staged opens its diff in the center view with per-hunk **Stage hunk / Unstage hunk / Discard hunk** buttons in each hunk header, and line-level staging via gutter selection (select lines → "Stage selected lines").
- Discard hunk requires confirmation, and the confirmation is the *only* guard: Undo restores refs and the index, not working-tree content that was never committed, so a discarded hunk is gone. Say so in the dialog ("This cannot be undone") rather than implying Undo will cover it.

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

> Status audited 2026-09-08 — see `STATUS.md`.

- [x] Dirty working tree always produces a WIP row; clean tree never does; updates are automatic (watcher). — row is a strip above the list, not a lane row (§1.1)
- [x] Stage/unstage at file, hunk, and line level all work and are reflected in `git status` ground truth. — `applyPatch` + `git apply --unidiff-zero`; untested for CRLF / no-trailing-newline
- [x] Commit disabled states + tooltips correct; `⌘Enter` commits.
- [x] Amend pre-fills, rewrites HEAD, and warns when HEAD is pushed.
- [x] Failed hook shows output and offers `--no-verify` retry.
- [x] Undo restores pre-commit state exactly (index + message). — message replayed via the `mtgit-restore-commit-message` event
- [x] Discard actions always confirm and never touch files not listed.
- [x] Commit button becomes **Continue \<operation\>** while a merge / rebase / cherry-pick is paused. — reads the conflict store (the seam's single writer), disabled while files are still conflicted, and shows `i of n` for a sequence. The banner keeps its own Continue: this is a second place, not a replacement.
- [x] `⌘⇧C` works with the commit panel closed. — the chord lives in `App` and selects the WIP row; `StagingView` focuses the summary on mount, so the two halves meet without a second listener.

**New in this revision (GitLens-derived):**

- [ ] A dirty second worktree produces its **own** WIP row, and committing from it touches only that worktree (§3.1). *The row is there, on that worktree's own lane. Clicking it opens that worktree as a tab rather than re-pointing this tab's commit panel: a different worktree has a different index, and staging into it from this handle would be acting on a repository the UI is not showing.*
- [x] Co-author picker appends well-formed `Co-authored-by:` trailers from the contributor list. — `lib/coauthors.ts`, fed by `list_contributors` (G28). Already-credited addresses are filtered out, and the trailer joins an existing trailer block rather than starting a paragraph, because git reads trailers only in the last one.
- [x] `commit.template` pre-fills the Description when the fields are empty. — `core/identity.rs::commit_template`, comment lines stripped (`commit_cli` passes `-m`, which git cleans with `--cleanup=whitespace` and would commit them verbatim). Seeds once, and never over a draft.
- [x] Issue references render as autolinks in the message preview and the graph message column. — `components/Autolinked` over `lib/autolinks.ts`; patterns come from repo config plus a built-in for origin's host, and nothing calls a network.
- [x] **Stash** and **Copy changes to worktree…** are reachable from the commit panel headers. — a
      quiet `⋯` on the **Staged** and **Changes** headers, so each one offers the scope its
      section names. Two notes. *Staged-only stash* shells out to `git stash push --staged`
      (`core/stash.rs::save_staged`), alone in a module that is otherwise pure libgit2: git2 has
      no equivalent, and the near miss — `StashFlags::KEEP_INDEX` — stashes everything and then
      restores the index, which is the opposite scope. *Copy* is a copy, not a move: the source
      keeps its work, because the gesture's whole premise is "I started in the wrong worktree"
      and a half-applied move loses uncommitted work that no reflog can return
      (`core/worktree.rs::copy_changes`, which includes untracked files — the common case here
      is a brand-new file).

> Deferred (overview §8.3): **Generate commit message** and **Compose commits** — GitLens's AI
> features. Named here so their absence is a decision. Of the two, generate-message is the one
> that needs nothing we do not already have: it is one prompt over the staged diff.
