# AGENTS.md

MTGit — a GitKraken-style desktop git client. Tauri 2 (Rust) + React 19 + TypeScript.

**The working instructions for this repo live in [`CLAUDE.md`](./CLAUDE.md).** Read it before
editing. It is the single source of truth for every agent, not just Claude Code — this file
exists so tools that look for `AGENTS.md` find their way there rather than working blind.

Kept deliberately short so the two files cannot drift. The four things worth repeating:

1. **The gate.** No CI and no frontend test runner exist yet, so nothing is verified until you
   run all four by hand:
   ```
   cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings
   cd .. && npx tsc --noEmit && npm run build
   ```
2. **Don't run `cargo fmt` across the tree.** The repo has never been rustfmt-clean; a blanket
   format buries the real diff. Match surrounding style by hand.
3. **Adding a Tauri command touches four files**, and mutating commands need an op guard.
   See "Invariants" in `CLAUDE.md` — those are the failures that are silent.
4. **Use `npm`/`npx`, not `pnpm`.** The project declares pnpm, but this checkout's
   `node_modules` was built by an older pnpm than the one on PATH, so `pnpm` aborts trying to
   purge it. `CLAUDE.md` explains the situation.

Roadmap and phase status: `GITKRAKEN_PARITY_PLAN.md`.
