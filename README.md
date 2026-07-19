# MTGit

A Tauri 2 + React desktop Git client centered on a virtualized, GitKraken-style commit graph.

Implemented workflows include:

- Live WIP/staging workspace with file, hunk, and line staging; safe discard; persistent commit drafts; amend; hooks; and signing.
- Local/remote checkout with tracking-branch creation, collision recovery, detached-HEAD recovery, and submodule notices.
- Fetch, configurable auto-fetch, pull strategies, push/upstream setup, rejection recovery, and force-with-lease.
- Drag/context-menu merge and rebase, including an interactive rebase plan editor.
- Single/range cherry-pick, `--no-commit`, merge-parent selection, and already-applied skipping.
- Shared merge/rebase/cherry-pick conflict banner with Continue/Skip/Abort and a three-pane resolution editor.
- Local-operation Undo/Redo, multi-select comparisons, commit/file details, blame/history, stashes, worktrees, and an embedded terminal.

## Development

```sh
pnpm install
pnpm tauri:dev
```

Verification:

```sh
pnpm build
cd src-tauri && cargo test
```
