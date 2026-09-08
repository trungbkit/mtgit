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
   cd .. && pnpm exec tsc --noEmit && pnpm build
   ```
2. **Don't run `cargo fmt` across the tree.** The repo has never been rustfmt-clean; a blanket
   format buries the real diff. Match surrounding style by hand.
3. **Adding a Tauri command touches four files**, and mutating commands need an op guard.
   See "Invariants" in `CLAUDE.md` — those are the failures that are silent.
4. **Use `pnpm`, not `npm`.** `pnpm-lock.yaml` is the only lockfile and `tauri.conf.json`'s
   `beforeDevCommand` / `beforeBuildCommand` call `pnpm` directly, so `pnpm tauri:dev` is the
   only invocation whose hooks match the config. pnpm 11 also gates dependency build scripts:
   one left undecided in `pnpm-workspace.yaml` fails the whole install, and takes `pnpm dev`
   — and so the app — down with it. `CLAUDE.md` explains both.

Roadmap and phase status: `GITKRAKEN_PARITY_PLAN.md`.
