# CLAUDE.md

MTGit — a GitKraken-style desktop git client. **Tauri 2 (Rust) + React 19 + TypeScript**.

Rust owns all git logic; the frontend renders and dispatches. Nothing in `src/` computes git
state itself.

---

## Commands

| Task | Command |
|---|---|
| Install deps | `pnpm install` |
| Typecheck frontend | `pnpm exec tsc --noEmit` |
| Build frontend | `pnpm build` (= `tsc && vite build`) |
| Rust tests | `cd src-tauri && cargo test` |
| Rust lint | `cd src-tauri && cargo clippy --all-targets -- -D warnings` |
| Run the app | `pnpm tauri:dev` |
| Fixture repo | `scripts/make-fixture.sh [dest]` |

### pnpm, not npm

**This project uses pnpm.** `pnpm-lock.yaml` is the only lockfile, and `tauri.conf.json`'s
`beforeDevCommand` / `beforeBuildCommand` call `pnpm dev` / `pnpm build` directly — so
`pnpm tauri:dev` is not a preference, it is the only invocation whose hooks match the config.
Reaching for `npm run tauri:dev` does not insulate you from pnpm: it runs `tauri dev`, which
runs the `pnpm dev` hook anyway, so a pnpm problem still surfaces — one layer removed from the
command you typed, which is the harder place to read it. Don't add a `package-lock.json`.

`pnpm <script>` runs a `package.json` script; `pnpm exec <bin>` runs a binary from
`node_modules/.bin`. A bare `pnpm tsc` falls back to `exec` when no script by that name
exists, but write `pnpm exec` where a binary is meant — it says which one you wanted.

**Build scripts are gated.** pnpm 11 refuses to finish an install while any dependency's
postinstall is undecided, and fails the *whole* command — including the `pnpm dev` that
`tauri dev` runs as a hook, so the app dies before Vite starts:

```
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: esbuild@0.28.1
```

The decisions live in `pnpm-workspace.yaml` under `allowBuilds`. A new gated dependency needs
an explicit `true` or `false` there (`pnpm approve-builds` writes it interactively); pnpm's own
placeholder is the literal text `set this to true or false`, which is not a boolean and leaves
the gate closed. `esbuild: true` is already recorded — its postinstall only verifies the
platform binary that `@esbuild/darwin-arm64` already ships.

`cargo test` takes ~35s: `perf_50k_commits_under_500ms` builds a 50k-commit repo. That is
expected, not a hang. Use `cargo test --lib <name>` while iterating.

`scripts/make-fixture.sh` builds a throwaway repo with a clean merge, a deliberately
conflicting branch, and an origin that is both ahead and behind — the fastest way to exercise
a change by hand. It prints the topology when it finishes.

### The gate

There is **no frontend test runner (no Vitest) and no CI** — both are planned in
`GITKRAKEN_PARITY_PLAN.md` P7. Until they exist, the whole gate is:

```
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings
cd .. && pnpm exec tsc --noEmit && pnpm build
```

Run all four before saying a change works. `tsc` is strict with `noUnusedLocals` and
`noUnusedParameters`, so a stale import is a build failure, not a warning.

### Do not run `cargo fmt` across the tree

The repo has never been rustfmt-clean — a blanket format touches every file and buries the
real diff. Match the surrounding style by hand instead. (`cargo fmt --check` is fine to *read*;
just don't apply it.)

---

## Layout

```
src-tauri/src/
  core/            all git logic, one module per domain (graph, diff, refs, ops, status, …)
                   — pure functions over `git2::Repository`, unit-tested with TestRepo
  commands.rs      #[tauri::command] wrappers; the only layer that knows about AppState
  lib.rs           the invoke_handler! registry
  state.rs         graph cache + OpSuppressor (watcher self-op suppression)
  shellout.rs      network ops via the system `git` binary
  watcher.rs       debounced fs watcher -> `repo-changed` event
  pty.rs           terminal sessions
  testutil.rs      TestRepo — programmatic fixture repos (git2, no shelling out)

src/
  ipc/             typed `invoke` wrappers (commands.ts) + hand-mirrored types (types.ts)
  stores/          zustand: session, toasts, dialog, conflict
  features/<area>/ one folder per UI area, colocated .tsx + .css
  components/      shared widgets (ContextMenu, Avatar, DialogHost, …)
```

Read `src-tauri/src/core/graph.rs`'s module doc before touching the graph — the lane algorithm
is documented there in full.

---

## Invariants

These are the things that break silently. Most are not visible from the file you're editing.

**1. A new Tauri command touches four places.**
`commands.rs` → the `invoke_handler![]` list in `lib.rs` → `src/ipc/commands.ts` →
`src/ipc/types.ts`. Forgetting `lib.rs` still compiles and fails only at runtime, with a
"command not found" error from `invoke`.

**2. Mutating commands must hold an op guard.**

```rust
#[tauri::command]
pub fn my_op(path: String, state: State<'_, AppState>) -> Result<()> {
    let _op = state.begin_op();
    // ...
}
```

Without it the fs watcher fires a refresh storm mid-operation (a checkout rewrites thousands
of files). Adding `state: State<'_, AppState>` does not change the JS-facing signature. Purely
read-only commands, and anything the *user* drives from the terminal panel, must **not** take
the guard — those changes do need to reach the watcher.

**3. Every TanStack query key carries the repo path at index 1.**

```ts
useQuery({ queryKey: ["status", repo.path], ... })   // ✅
useQuery({ queryKey: ["status", { path }], ... })    // ❌ never invalidated
```

`useRepoEvents` and every `refresh()` invalidate with
`predicate: (q) => q.queryKey[1] === path`. A key shaped any other way just never refreshes,
with no error.

**4. The graph cache is keyed on the whole ref set, not HEAD.**
`graph::refs_digest()` hashes every `refs/**` target plus HEAD. A fetch, a tag, or a branch
create leaves HEAD untouched, so a HEAD-only key served stale rows and stale badges. If you
add state the graph depends on, it has to be reachable through `repo.references()` or fold
into that digest.

**5. The frontend never computes graph layout.**
Lanes, edges, and colors come from `core/graph.rs`. `GraphView` renders `row.lane` and
`row.edges` as given. Layout bugs get fixed in Rust, with a test.

**6. Network ops shell out to the system `git`.**
git2 is built `default-features = false` — it has *no* networking, deliberately: shelling out
inherits the user's credential helpers, SSH agent, and proxy config for free. `shellout::run`
accepts fetch/pull/push only. Any new child process must drain stdout and stderr
**concurrently** (use `drain()`); reading one to EOF first deadlocks when the other pipe fills.

**7. IPC types are hand-synced.**
Rust structs carry `#[serde(rename_all = "camelCase")]`; `src/ipc/types.ts` mirrors them by
hand. Tauri also converts snake_case command params to camelCase JS keys — a Rust
`path_filter` arrives as `pathFilter`. There is no codegen yet, so change both sides together.

**8. Errors crossing IPC are `error::Error`, serialized to a plain string.**
Frontend reports them with `toastError(e)`. Note that `gitNetwork` *resolves* with a
`GitOpResult` even when git exits non-zero — check `.success`, or go through
`features/network/net.ts`, which is the single place that check lives.

---

## Conventions

- **Comments explain why, not what.** The existing code is dense with rationale
  (`graph.rs`'s algorithm note, `shellout.rs`'s "why not libgit2 networking"). Match that:
  a comment that restates the line below it is noise; one that records a constraint is not.
- **Tests are behavioural and use real repos.** `TestRepo` (`testutil.rs`) builds fixtures with
  git2 — fast, deterministic, no shelling out. Assert on observable behaviour, and give the
  test a name that states the rule it protects
  (`graph_cache_rebuilds_when_a_branch_moves`, not `test_cache`).
- **A bug fix lands with a test that fails without it.** Where a regression is a hang rather
  than a wrong value, guard the test with a channel timeout so it fails instead of hanging —
  see `drain_does_not_deadlock_when_stdout_fills_the_pipe`.
- **CSS lives next to its feature** (`features/graph/graph.css`) and uses the tokens in
  `src/theme.css`. Don't hardcode hex outside the token file.
- Dialogs are promise-based: `await confirmDialog(...)` / `promptDialog(...)` from
  `stores/dialog`, never the browser's `confirm()` / `prompt()`.
- Branch and tag names entered by the user go through `lib/refname.ts:validateRefName`.

---

## Gotchas

- **`React.StrictMode` is on**, so effects double-invoke in dev. Effects that fetch or spawn
  must be idempotent (`watch_repo` is idempotent server-side for exactly this reason).
- **The graph query is an infinite query.** Invalidating it refetches *every* loaded page, so
  a deep scroll makes refreshes progressively more expensive.
- **The watcher stays quiet for 600ms after one of our own operations.** An external edit
  landing inside that window is dropped. If a change seems not to refresh, check whether it
  ran under an op guard.
- **`dist/` is gitignored but present on disk** — a stale build there is not the app you're
  running under `tauri:dev`.
- **Windows has never been built.** The `drain()` deadlock tests are `#[cfg(unix)]`. Assume
  path and CRLF handling is unverified there.

---

## Roadmap

`GITKRAKEN_PARITY_PLAN.md` is the live plan: gap analysis vs GitKraken, phases P0–P8, and a
status marker per phase. **P0 and P2–P4 are done, P5 is done except commit search; P1
(clone/init/remotes/start screen), P6–P7 and P8 (the GitLens-derived surfaces, G16–G28) are
unstarted.** Its §8 says what to pick up next, and the answer is currently the defects in
STATUS.md §1 rather than a phase.

`docs/feature-requirements/` is the spec for the seven core features (commit, checkout, push,
pull, merge, rebase, cherry-pick) plus `08-search-and-filter.md` (commit search, unbuilt), and
`docs/feature-requirements/STATUS.md` audits the code against it — per-criterion verdicts plus
the outstanding defects. Start there before picking up feature work; it is more current than the
phase plan.

Both the specs and the plan treat **two** references as "GitKraken", because two GitKraken
products ship the same commit graph: GitKraken Desktop and **GitLens**
(`gitkraken/vscode-gitlens`). GitLens is MIT outside its `plus/` tree, so it is a readable
source for exact behaviour — the search grammar in `08-search-and-filter.md` came from it.
`00-overview.md` §0 sets the precedence rule (Desktop wins on shell and gesture, GitLens on
grammar and detail) and §8 records which GitLens features are in scope, adapted, or out; the
`plus/` tree is not MIT and stays deferred. Don't re-open those verdicts per PR.

`PLAN.md` and `VERIFY_HARDEN_PLAN.md` are historical — delivered, kept for context.

When you finish a phase or a numbered item, update its status in the plan rather than leaving
the record to the commit log.
