# MTGit — GitKraken Parity Plan

**What this file is for: the work that is still open.** The feature backlog closed on
2026-09-12 — P0–P6 and P8 landed, and every acceptance criterion across the eight feature docs
is either met or listed below as a decision. What this document used to hold was a
phase-by-phase record of how each of those landed, with the gap tables G1–G28 struck through in
place. That record lives in the git history and in the code's own comments, which is where it is
actually read; keeping a second copy here meant 900 lines of "done" wrapped around 40 lines of
"not done", and the not-done was the only part anyone needed.

The spec is `docs/feature-requirements/`. The per-criterion audit is its `STATUS.md`. This file
is the plan; where the two overlap, STATUS.md is the more current.

---

## 1. Where things stand

The gate is green: **179 Rust tests**, **288 frontend tests**, clippy clean at `-D warnings`,
`tsc --noEmit` clean, `check:ipc` consistent across 106 commands, `vite build` succeeds.
~13k lines across `src/` and `src-tauri/src/`.

Built and working end to end: the seven core operations (commit, checkout, push, pull, merge,
rebase, cherry-pick) and commit search; repo lifecycle (clone / init / remotes / start screen /
tabs); hunk and line staging; the undo journal; the unified conflict panel; interactive rebase
with conflict prediction; worktrees; settings with both themes and a keybinding registry; and
the GitLens-derived graph surfaces — configurable columns, scroll markers, the on-search
minimap, ghost refs, `+N` ref overflow, the detail stack, terminal links, autolinks, the blame
heatmap, contributors, and the guided command palette.

---

## 2. What is left

### 2.1 P7 — shipping

The only phase with unfinished *work* rather than unmade decisions.

| Item | State | Blocked on |
|---|---|---|
| CI | ✅ `.github/workflows/ci.yml` — a frontend job (tsc, `check:ipc`, Vitest, build) and a Rust job across ubuntu-22.04 / macOS / Windows. Deliberately no `cargo fmt --check`: the tree has never been rustfmt-clean, so a format gate would fail on its first run for reasons unrelated to any change. | — |
| Frontend suite | ✅ Vitest + Testing Library + jsdom. | — |
| `check:ipc` | ✅ Invariant 1's fourth layer, and the only thing that reads `commands.rs`, `lib.rs` and `ipc/commands.ts` together. | — |
| Packaging | ◐ `release.yml` builds .dmg (both Mac architectures), MSI and AppImage/deb on a version tag and drafts a release. **The artifacts are unsigned**, and the updater is absent. | An Apple Developer ID plus a notarytool password, a Windows code-signing certificate, an updater keypair. The secret names `tauri-action` reads are already in the workflow, so adding them is the whole remaining change. |
| E2E | ✗ Not started. | `tauri-driver` plus a built binary on the runner. |

**Exit, not yet met:** a stranger can build all three platforms from a tag, but not install a
signed one.

### 2.2 No eslint

There is no eslint config in this repo; the scattered `eslint-disable-next-line` comments are
vestigial. `react-hooks/rules-of-hooks` is therefore not running, and its absence has already
cost one crash: two `useCallback`s declared below `GraphView`'s early returns made every
repository open throw "rendered more hooks than during the previous render". The guard today is
a comment — `---- No hooks below this line. ----` — which is at least honest about being a
comment.

Adding eslint is a seventh gate command and a decision for whoever owns the gate. The cost of
not having it is now measured rather than hypothetical.

### 2.3 Windows has never been built

CI covers it, but CI has never gone green. The `drain()` deadlock tests are `#[cfg(unix)]`, so
that path is unverified there, and path plus CRLF handling is unverified generally. The longer
this waits the worse the debt.

---

## 3. Deliberately not built

Each of these is blocked on a judgement, not on effort. **Read this list before proposing any
of them as an oversight.**

- **In-progress rebase ghosting** (`06-rebase.md` B4). The graph has no representation of "a
  commit that will exist", and inventing rows for those collides with `search_commits` returning
  row *indices* as page hints — the same constraint that kept WIP rows out of the row list. The
  honest fix is a second index space, which is a change to the graph's contract, not a feature.
- **Per-commit cherry-pick progress** (`07-cherry-pick.md` §3). The whole list is one
  `git cherry-pick` invocation, so there is nothing to report per commit. Driving the sequence
  commit-by-commit would mean owning the sequencer's restart semantics, which are worth more
  than a counter. The spec itself rules it out.
- **What the sidebar's eye toggle means** (`08-search-and-filter.md` §7.1). Today it hides
  *badges*; GitKraken's hides *rows*. Both are defensible, and the second changes behaviour that
  already shipped, so it wants a decision before code.
- **Checkout progress with a file counter** (`02-checkout.md` §5). git2's checkout callback can
  feed it; what is undecided is whether a progress surface that appears for a fraction of a
  second on most repositories is an improvement or a flicker.

---

## 4. Out of scope

The boundary, decided once so it is not re-litigated per PR.
`docs/feature-requirements/00-overview.md` §8.2 and §8.3 are the authoritative version; this is
the summary.

**Provider integration** (GitHub/GitLab/Bitbucket PR and issue panels), **LFS UI**,
**submodule UI**, **sparse checkout**, **GPG key management**, **cloud workspaces**,
**AI commit messages**. These are GitKraken features but not *core git client* features, and
each drags in an account system, a network boundary, or a model provider.

**GitLens's account-gated tier** maps almost exactly onto the same bucket, and it is also
everything under its non-MIT `plus/` tree: Launchpad and the in-graph PR panel, agent sessions
and the Agent Kanban, GitKraken MCP, Cloud Patches, Cloud Workspaces, and every AI feature. Read
`plus/` for understanding; never lift code from it. For the MIT half, matching *behaviour* is
free but copying *code* owes attribution — cite the source file in a comment if you ever do.

**Editor-only features**: Git CodeLens and caret-line blame presuppose an editing surface with a
cursor and a symbol tree. MTGit's file viewer is read-only, and the heatmap and blame gutter
answer the same question.

**Feature-sized visualisations**, deferred rather than refused: GitLens's Visual File History
timeline and its three treemaps. Also the two AI features that would need no account of ours —
**Generate commit message** and **Explain changes** are single prompts over a diff
`core/diff.rs` already produces, and are the first candidates if that boundary ever moves.

---

## 5. Reference rule

"GitKraken" means the family. Two products ship the same Commit Graph: **GitKraken Desktop** and
**GitLens** (`gitkraken/vscode-gitlens`). GitLens matters out of proportion to its form factor
because it is *readable*: everything outside `plus/` is MIT, so its search grammar, column model,
conflict panel and rebase editor were specified from source rather than inferred from
screenshots.

**Where the two disagree, Desktop wins on shell and gesture; GitLens wins on grammar and
detail.** `00-overview.md` §0 is where that rule lives, and its §8 is the per-feature verdict
list.

---

## 6. Live risks

The risks that were discharged as their phases landed are gone from this table. What is here is
what is still true.

| Risk | Where it stands |
|---|---|
| **Windows has never been built.** | §2.3. CI covers it on paper only. |
| **The mutation seam is a single point of failure.** Every banner in the app is one `operation_info` call (`ipc/repoState.ts`), where it used to be seven independent derivations. A regression there is invisible in seven places at once rather than one. | The single writer is the point — seven copies were how defect A1 hid. `operation_info_reports_a_conflict_it_was_never_told_about` pins the backend contract using a conflict made by the `git` binary directly, and the frontend suite now covers the seam itself. |
| **The undo journal can drift** from repo reality if the user runs git in the terminal panel. | Each entry is validated against current ref state before Undo is offered, and a toast offers Undo only when the journal actually *grew*. Two identical operations in a row therefore lose the offer — a false negative, and the right side to err on. |
| **50k+ repo perf.** | Measured: the layout gate is 269 ms of a 500 ms budget (debug build), taking the best of up to three runs so a loaded machine does not fail a gate nothing regressed against. The *frontend* side is the half with no gate — §7 is what stands in for one. |
| **Scope creep into provider integrations.** | §4 is the contract. "GitLens has it" is not an argument. |

---

## 7. Performance notes

There is no automated frontend perf gate. These are the constraints a change to the graph has to
respect, written down because each was a real cost before it was a rule.

- **The graph query is an infinite query.** Invalidating it refetches *every* loaded page, so a
  deep scroll makes each refresh more expensive than the last. `refreshRepo` therefore asks
  `graph_key` first and skips the invalidation when the ref digest has not moved. That is not a
  heuristic: the Rust layout cache is keyed on the same digest (invariant 4), so an unchanged
  digest means the pages would come back byte-identical. Most repository events — a stage, an
  editor save, a commit hook — move no ref at all.
- **Nothing that runs per render may walk the whole row list.** The lane-gutter width and the
  scrollbar's HEAD/selection marks are each a sweep of every loaded row, and both used to sit
  inline in the render — so hovering one row walked 50k commits. They are memoized on the rows.
- **`GraphRowView` is memoized and every callback prop it takes is stable.** The parent
  re-renders on hover, on selection, on a flash and on every page that arrives; without this,
  each of those re-rendered all forty visible rows, avatars and pills included.
- **The Changes column is the one column that costs a diff per row.** Off by default, and
  fetched per visible window rounded to a 50-row block, so dragging the scrollbar is not a fetch
  per frame.
- **Ghost refs are a merge-base per ref.** Asked on hover, and only for rows carrying no pill of
  their own.
- **A settings write re-applies the theme and drops the lane-colour cache.** Never put one on a
  drag frame; commit the gesture when it ends.

---

## 8. Backend command surface

`src-tauri/src/commands.rs` is the surface, and `scripts/check-ipc.mjs` is what keeps it honest
across `commands.rs`, `lib.rs` and `ipc/commands.ts`. The sketch that used to live here listed
every command with "DONE" beside it, which is a worse copy of the file itself.

Three contract notes that are easy to get wrong and are not visible in a signature:

- **`search_commits` returns SHAs and page hints, not rows.** The rows are already in the graph
  cache; re-serialising them doubles the payload for nothing. Results cache against
  `refs_digest()`, so a fetch cannot leave a hit list pointing at a rewritten commit. A hit also
  carries a row `index`, because the frontend needs it to scroll to the hit *after* loading the
  page the hint named — and a `null` index is how a hit the graph does not contain (a stash
  commit) reports itself instead of being dropped.
- **`predict_rebase_conflicts` is read-only and takes no op guard** (invariant 2): no ref moves,
  no index writes, no `ORIG_HEAD`, no working tree. The one place that promise is weaker than it
  sounds: *unreferenced tree objects are written*, because git2's merge takes `Tree` handles and
  the only way to turn a merged index back into one is to write it. `git gc` prunes them, and
  the module doc says so rather than hiding behind "read-only".
- **`conflict_set` also takes no op guard, and that has to stay true.** The panel refetches
  after every resolve, and suppressing the watcher on a *read* would hide the user's own editor
  saves.
