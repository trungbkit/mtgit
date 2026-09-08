# Feature: Commit Search & Graph Filtering (GitLens-style)

> Read `00-overview.md` first — §7 carries the shared rules this doc implements.

## 1. Summary

Finding a commit is the precondition for six of the seven operations in this set, and it is the
one MTGit cannot do at all today (`GITKRAKEN_PARITY_PLAN.md` G10). GitKraken Desktop and GitLens
both put a search bar in the Commit Graph header; GitLens's version is specified in code, so
**GitLens's grammar is the spec** here, down to the operator tokens. Everything in §3 was read
out of `packages/git/src/models/search.ts` and `packages/git/src/utils/search.utils.ts` in
`gitkraken/vscode-gitlens` (the MIT half of that repo — see `00-overview.md` §0).

Copying the grammar rather than inventing one is not laziness: these operators map almost
one-to-one onto `git log` flags, which is why they are the right shape, and a user arriving from
GitLens or GitKraken already knows them.

## 2. Entry Points

- Search field in the **graph column header**, always visible. `⌘/Ctrl+F` focuses it when the
  graph has focus (the sidebar's own `⌘F` filters refs — the two must not fight; whichever pane
  has focus wins, and the shortcut is listed twice in the cheat sheet with its scope).
- `⌘/Ctrl+Shift+F` focuses it from anywhere, scrolling the graph into view first if a full-width
  diff has taken over the centre pane (overview §4: a shortcut opens the panel it needs).
- Command palette: **Search commits…** seeds the field.
- Sidebar: the eye toggle and a ref's **Show only this** both write a `ref:` term into the
  field rather than filtering by a second mechanism (overview §2).
- Right-click an author in the graph's Author column → **Search commits by this author**
  (`author:` term). Same for a file in the detail panel → `file:`.

## 3. Query Grammar

A query is whitespace-separated terms. A bare term means `message:`. Values containing spaces
are double-quoted. Each operator has a long form and a short alias; both are accepted, and the
long form is what the field normalises to when the user picks from autocomplete.

| Long form | Alias | Meaning | git equivalent |
|---|---|---|---|
| `message:` | `=:` (and bare) | commit message contains | `--grep=` |
| `-message:` | — | commit message does **not** contain | `--grep=` + `--invert-grep` |
| `author:` | `@:` | author matches (`@me` = current identity) | `--author=` |
| `committer:` | — | committer matches | `--committer=` |
| `commit:` | `#:` | a specific commit by SHA (full or abbreviated) | rev lookup |
| `file:` | `?:` | commit touches this path or glob | pathspec |
| `change:` | `~:` | commit added or removed this string ("pickaxe") | `-S` (`-G` in regex mode) |
| `type:` | `is:` | `stash`, `tip` (branch/tag tips only), or `merge` | `--merges`, ref/stash scoping |
| `after:` | `since:`, `>:` | authored after a date | `--after=` |
| `before:` | `until:`, `<:` | authored before a date | `--before=` |
| `ref:` | `^:` | restrict the walk to a ref or `a..b` range | replaces `--all` with the ref |

Modifiers, as toggles beside the field: **match case**, **match whole word**, **match all**
(terms are AND rather than OR), **regex**.

### 3.1 Grammar rules that are not obvious

- **`-message:` and `message:` in one query.** `--invert-grep` inverts *every* `--grep` in the
  command, so a query mixing positive and negative message terms cannot be expressed in one
  `git log`. GitLens's source flags exactly this. Either run the positive query and subtract the
  negative one in the backend, or reject the combination with a message that says why — but do
  not silently drop one of the terms, which is what the naive implementation does.
- **`type:tip`** is a filter over the *result*, not a `git log` flag: it keeps only commits that
  some branch or tag points directly at. Likewise `type:stash` scopes the walk to
  `refs/stash` + its reflog. Only `type:merge` maps to a flag (`--merges`).
- **Regex vs fixed strings.** When any of `--grep` / `--author` / `--committer` is present, pass
  `--extended-regexp` in regex mode and `--fixed-strings` otherwise. Without this, a message
  search for `a.b.c` or `(fix)` quietly matches the wrong things — regex-by-default is a
  footgun for a search box that looks like plain text.
- **Values are data, never options.** A value starting with `-` must be dropped or `--`-guarded,
  not passed through: `ref:--upload-pack=…` on a real `git` binary (`CLAUDE.md` invariant 6) is
  a command-injection vector, not a formatting glitch. This is the one rule in this document
  that is a security requirement.
- **Dates** accept anything `git` accepts (`2026-01-01`, `3 weeks ago`, `yesterday`); do not
  parse them ourselves, hand them to git and surface its error.

## 4. UI Requirements

- **Autocomplete on `:`.** Typing an operator prefix offers the operator list with one-line
  descriptions; typing `author:` offers contributors (from the CONTRIBUTORS data, overview §2),
  `file:` offers paths from the current selection's tree, `ref:` offers refs.
- **Result mode selector** — highlight (default) / filter / select, per overview §7. In
  highlight mode hits get a row marker plus a mark in the scroll gutter and the minimap
  (yellow, matching GitLens); in filter mode the graph shows only hits and states so in the
  footer ("showing 37 of 12,481 commits — topology is not continuous").
- **Hit navigation:** `n of m` counter, `F3` / `⌘G` and `⇧F3` / `⇧⌘G`, wrapping, and the
  selection follows the current hit so the detail panel tracks it.
- **Search runs against the whole history, not the loaded pages.** The graph is paginated
  (2000-row pages, P0/D2); a search that only looks at what has been scrolled into view is
  worse than no search, because its emptiness is indistinguishable from a real miss. Backend
  walks the full history; the frontend jumps to and loads the page a hit lives on.
- **A long search is cancellable** and streams a count as it goes, in the status bar
  (overview §4) — the same place every other long operation reports.
- **Recent and pinned queries.** The field's dropdown lists this session's recent queries; a
  query can be pinned with a name and reused. Pinned queries persist per repo.
- **Empty result** states the query back in prose ("No commits by `@me` touching `src/**`
  after `2026-01-01`") so a typo'd operator is visible. An unknown operator is an error at
  parse time, not a term silently treated as message text.

## 5. Behavior

| # | Rule |
|---|---|
| B1 | Backend command `search_commits(query, opts, limit)` parses the grammar in Rust and runs one revwalk (or one `git log` shellout where the flag has no git2 equivalent — `-S` does not). Parsing does **not** live in the frontend: the grammar and its git mapping belong on the side that owns git logic (`CLAUDE.md` invariant 5's principle, applied to search). |
| B2 | Results are returned as `{ oid, page_hint }` — SHA plus which graph page it falls on — not as full rows. The rows already exist in the graph cache; re-serialising them doubles the payload for nothing. |
| B3 | Search results are cached against `graph::refs_digest()` (invariant 4), so a fetch or a branch move invalidates them along with the graph. A stale hit list pointing at a rewritten commit is the failure mode this prevents. |
| B4 | `limit` defaults to unbounded, with a configurable cap; when the cap truncates, the footer says so and offers to keep going. Silent truncation is how a search convinces a user their commit is gone. |
| B5 | Filter mode does not change HEAD, selection, or scroll position on entry, and restores all three on exit. |
| B6 | Search is read-only and therefore takes **no op guard** (`CLAUDE.md` invariant 2). |
| B7 | Query state is per repo tab and survives tab switches, per `GITKRAKEN_PARITY_PLAN.md` G12. |

## 6. Edge Cases

- **Shallow or partial clone:** `change:` and `file:` searches can only see fetched history; say
  so in the footer rather than reporting a confident miss.
- **Very large repos:** `change:` (`-S`) is the expensive operator — it diffs every commit.
  Report progress, and do not run it as-you-type; require Enter for pickaxe terms specifically.
- **Detached HEAD / no commits:** search is disabled with a tooltip, not an error on submit.
- **A hit that is filtered out of the graph** by a sidebar ref toggle: the hit count includes it
  and navigating to it clears the toggle that hides it, with a toast saying it did so. Silently
  refusing to navigate to a hit you just counted is the worse option.
- **Search while an operation is paused** (merge/rebase conflict): allowed. It is read-only, and
  overview §5.3's one-operation-at-a-time rule is about *mutations*.

## 7. Acceptance Criteria

> **Implemented 2026-09-08** (`core/search.rs`, `search_commits` / `cancel_search`,
> `features/graph/SearchBar.tsx`, `stores/search.ts`). 25 Rust tests cover the grammar and its
> git mapping; the four unchecked boxes below are the honest remainder, and each says what it
> waits on. There is still no frontend test runner (P7), so every UI criterion here was
> typechecked and built but not clicked through in the running app.

- [x] Every operator and alias in §3 parses, including quoted values, and maps to the stated git
      behaviour, verified against a fixture repo per operator.
      (`every_operator_and_alias_parses`, `quoted_values_survive_and_are_never_operators`, plus a
      behavioural test per operator family.)
- [x] Bare terms search messages; `match all` / `match case` / `regex` / `whole word` all work.
      (`fixed_strings_is_the_default_so_dots_are_literal`,
      `match_case_and_match_all_map_to_their_flags`, `whole_word_adds_boundaries_and_escapes_the_value`.)
- [x] `@me` resolves to the configured git identity, and is left alone when there is none.
- [x] A value beginning with `-` can never reach `git` as an option (test per operator:
      `no_operator_lets_a_leading_dash_reach_git_as_an_option`). Values are attached to their
      flag, pushed after `--`, or — for `ref:` and `commit:`, the two that must be standalone
      argv words — rejected with an explanation.
- [x] Mixing `message:` and `-message:` returns the correct set: the positive walk runs and a
      second, identically scoped negative walk is subtracted. Neither term is dropped.
- [x] `type:` handles `stash`, `tip` and `merge`. `tip` and `commit:` are filters over the
      walk's output; `stash` walks the stash reflog instead of the ref set.
- [x] Highlight / filter / select modes behave per §4, and exiting filter mode restores
      selection and scroll exactly. Filter mode also draws **no edges** — with rows hidden,
      consecutive rows are no longer parent and child, and an edge between them would assert a
      parentage that does not exist.
- [x] Hit navigation with `F3`/`⌘G` and `⇧F3`/`⇧⌘G`, wrapping, an `n of m` counter, selection
      follows. The counter reads `37 results` until a hit is made current, because landing on
      one immediately would scroll the graph out from under someone still typing.
- [x] Hits are found in history that has never been scrolled into view, and navigating to one
      loads its page. `search_commits` returns a row index and a page hint per hit; the frontend
      pulls pages until the row exists, then scrolls to it.
- [x] A pickaxe search is cancellable and reports progress — `search-progress` events into the
      status bar with a Cancel that SIGTERMs the `git log`, keeping the partial result. Pickaxe
      terms wait for Enter rather than running as you type.
      *Not* measured against the 50k-commit fixture; the perf gate covers layout, not search.
- [x] Results invalidate with `refs_digest()` — a branch move cannot leave a stale hit list
      (`search_cache_is_invalidated_by_a_branch_move`). Every modifier and the result cap are
      part of the cache key (`every_search_modifier_changes_the_cache_key`).
- [x] Truncation at the result cap is stated, never silent — the footer says where it stopped
      and offers **Keep going**, which re-runs the same query uncapped.
- [ ] Autocomplete offers operators, contributors, paths and refs as described.
      **Operators and refs only.** Contributors need the CONTRIBUTORS data (`GITKRAKEN_PARITY_PLAN.md`
      G28) and paths need the selection's tree; both are additions to the same `suggestions` list.
- [x] Recent queries listed; pinned queries persist per repo (`localStorage`, per repo path,
      migrating into the settings file when P6 lands one).
- [x] Search is reachable from the graph header, `⌘F`/`⌘⇧F`, the command palette, an author
      cell, and a file row — and the sidebar's `⌘F` still filters refs without conflict.
      Focus decides `⌘F`: the graph owns it while the graph pane has focus, the sidebar owns it
      everywhere else, and `⇧⌘F` is always the graph's. Clicking a graph row focuses the pane,
      so that rule is about a real state rather than a notional one.

### 7.1 Outstanding, with what each waits on

| Item | State | Waits on |
|---|---|---|
| **Minimap** | Not built. Scroll markers *are* — hits, HEAD and the selection at their proportional positions in the whole history (`ScrollMarkers`), sampled to 400 marks. | The minimap proper (activity over time beside the markers) is `GITKRAKEN_PARITY_PLAN.md` P8 item 3. |
| **Contributor and path autocomplete** | Operators and refs complete; values for `author:` and `file:` do not. | CONTRIBUTORS (G28) and a path source for the current selection. |
| **Sidebar eye toggle unified with `ref:`** | The context menu's **Show only this in the graph** and **Search commits on this branch** write a `ref:` term, as §2 requires. The hover **eye** toggle still drives `hiddenRefs`, which hides *badges* rather than rows. | A decision about what the eye should mean. Because it hides no rows, §6's "navigating to a hit hidden by a ref toggle clears the toggle" cannot arise today — there is no hit the toggle can hide. |
| **A search field in the middle of a full-width diff** | `⇧⌘F` focuses the field from anywhere, but nothing "takes over the centre pane" in the current shell, so there is nothing to scroll back into view. | The focus view / detail stack (P8 item 4). |
