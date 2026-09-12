# Implementation Status

**What this file is for: what the code does *not* yet do, and what it deliberately does
differently from the spec.** Audit of `docs/feature-requirements/*` against the code, last
reviewed **2026-09-12**.

This used to also carry the record of every defect found and fixed between 2026-09-08 and
2026-09-12 — five behaviour defects, nine missing entry points, eight simplified dialogs, ten
polish items — each row struck through with an account of what shipped. They are all closed; the
accounts survive in the commits and in the code comments they justify, and a status file that is
95% "fixed" is a changelog nobody reads for status. What remains here is the part that is
actually a status: the open rows, the recorded deviations, and the test gaps.

**Verdict: all seven core operations plus commit search are implemented end to end.** What is
open is listed below and nowhere else.

| Doc | Feature | Verdict |
|---|---|---|
| `01-commit.md` | Commit & staging | Complete, with one recorded deviation (§2) |
| `02-checkout.md` | Checkout | Complete bar the large-checkout progress counter (§1) |
| `03-push.md` | Push | Complete |
| `04-pull.md` | Pull & fetch | Complete |
| `05-merge.md` | Merge | Complete |
| `06-rebase.md` | Rebase + interactive | Complete bar in-progress graph ghosting (§1) |
| `07-cherry-pick.md` | Cherry-pick | Complete bar per-commit sequence progress, which §3 of that doc itself rules out (§1) |
| `08-search-and-filter.md` | Commit search & filtering | Complete as an implementation; its §7.1 is down to two rows, neither missing code (§1) |

The gate is green at this revision: **173 Rust tests**, **240 frontend tests**, clippy clean at
`-D warnings`, `tsc --noEmit` clean, `check:ipc` consistent across 106 commands, `vite build`
succeeds.

---

## 1. Open

Four items, each blocked on a judgement rather than on effort.
`GITKRAKEN_PARITY_PLAN.md` §3 carries the same list with the reasoning; it is repeated in
neither more nor less detail here, because this is the file someone reads before picking up
feature work.

| Item | Spec | Why it is not built |
|---|---|---|
| **In-progress rebase ghosting** — applied commits on the new base, remaining ones ghosted | `06-rebase.md` B4 | The graph has no representation of "a commit that will exist", and inventing rows collides with `search_commits` returning row *indices* as page hints (`08-search-and-filter.md` B3) — the same constraint that kept WIP rows out of the row list. The honest fix is a second index space: a change to the graph's contract, not a feature. |
| **Per-commit cherry-pick progress** ("Cherry-picking 3 of 7…") | `07-cherry-pick.md` §3 | The whole list is one `git cherry-pick` invocation, so there is nothing to report per commit. Driving it commit-by-commit would mean owning the sequencer's restart semantics, which are worth more than a counter. The spec says so itself, which makes this a recorded trade rather than a gap. |
| **What the sidebar's eye toggle means** | `08-search-and-filter.md` §7.1 | Today it hides *badges*; GitKraken's hides *rows*. Both are defensible and the second changes behaviour that already shipped. Because it hides no rows, §6's "navigating to a hit hidden by a ref toggle clears the toggle" cannot arise today — there is no hit the toggle can hide. |
| **Large-checkout progress with a file counter** | `02-checkout.md` §5 | git2's checkout callback can feed it. What is undecided is whether a progress surface that appears for a fraction of a second on most repositories is an improvement or a flicker. |

One more row in `08-search-and-filter.md` §7.1 — a search field inside a full-width diff — has
nothing to build against: `⇧⌘F` focuses the field from anywhere, and nothing takes over the
centre pane in the current shell, so there is no view to scroll back.

---

## 2. Recorded deviations

Where the code deliberately does something other than what the spec says. Each is a decision,
not an omission; the spec text carries the same note.

- **Clicking another worktree's WIP row opens that worktree as a tab**, rather than opening the
  commit panel on it as `01-commit.md` §3.1 asks. A different worktree has a different index,
  and this tab's repository handle cannot stage into it without lying about which repository it
  is acting on. Opening it reaches the same place honestly.
- **The toolbar button that started an operation does not spin**, though `00-overview.md` §4
  asks it to. Progress and Cancel live in the status bar — a deliberate placement the spec now
  records, because progress is continuous and must neither stack with outcome toasts nor cover
  the graph — and a second indicator on the button has not been judged worth the noise.

---

## 3. Test coverage gaps

Named so they are decisions rather than accidents. The suites are behavioural and use real
repositories (`TestRepo` in Rust, a mocked IPC layer in the frontend).

**Rust — uncovered behaviours in `core/advanced.rs`**, which carries checkout recovery, merge
modes, the operation sequencer, conflict resolution and interactive rebase:

- `checkout` with `Stash` recovery when the pop conflicts (must keep the stash and report it).
- `checkout` `REMOTE_NAME_CONFLICT` encoding — the frontend parses it with a regex.
- `merge` kind classification (`UpToDate` / `FastForward` / `Normal`) across all three modes.
- `operation_continue` / `_skip` / `_abort` for each of merge, rebase, cherry-pick, revert.
- `resolve_conflict_side` on a delete/modify conflict (the `git rm` fallback path).
- `rewrite_info` counts (pushed / merges) — these drive a destructive-action warning.
- Sequence-meta bookkeeping (`i of n` in the banner) across continue and skip.
- `apply_patch` round-trip for line-level staging: CRLF, no trailing newline, added-lines-only.

**Rust — elsewhere:** `page_hint` against a real 2000-row page boundary, and the pickaxe
cancellation path (killing a child mid-walk deterministically needs a fixture big enough to
still be running).

**Frontend:** `Sidebar`, `lib/checkout.ts`'s collision-recovery dialog flow, the diff renderer,
`ConflictPanel`'s cross-file navigation, and the graph's column rendering. `GraphView` has a
mount test and context-menu tests, but nothing that drives its virtualized list.

**Neither suite drives the real app.** E2E is unstarted (`GITKRAKEN_PARITY_PLAN.md` §2.1), and
`scripts/make-fixture.sh` — a throwaway repo with a clean merge, a conflicting branch and an
origin both ahead and behind — is still the fastest manual check.

---

## 4. Two lessons worth keeping

Both are about where bugs hide in this codebase, and both were paid for.

**A cast-shaped fixture is a lie the compiler has been told not to check.** `net.test.ts`'s
`RepoInfo` was built with a cast and no `head`, which the type says is not optional. Nothing
read it until `runNet` needed the branch a push had moved, and then four passing tests failed at
once on a `TypeError` swallowed by the function's own catch. Build fixtures with every field.

**The gate cannot see a hook-order bug.** `GraphView` declared two `useCallback`s below its
early returns; the first render of a repository took the `isPending` branch and ran fewer hooks
than the second, so every repository open threw "rendered more hooks than during the previous
render" and the app showed its error boundary. `tsc` was happy, the Rust tests never load a
component, and the frontend suite had deliberately skipped `GraphView`. The gap named itself and
then the bug walked through it. The guard today is the
`---- No hooks below this line. ----` comment and a mount test over the exact transition; the
real fix is eslint, which this repo still does not have.
