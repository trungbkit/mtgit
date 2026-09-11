import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cancelSearch, listContributors, listRefs, searchCommits } from "../../ipc/commands";
import { DEFAULT_MODIFIERS, useSearch, type Modifiers, type SearchMode } from "../../stores/search";
import "./search.css";

/**
 * Result cap. Unbounded is the spec's default (B4), but an unbounded pickaxe
 * over a 50k-commit history builds a list nobody will page through, so this is
 * the "configurable cap" half of that rule — configurable once P6 lands a
 * settings file. Truncation is always stated, never silent.
 */
const RESULT_CAP = 5000;

/** Operators offered by autocomplete, long form first (§3). */
const OPERATORS: { token: string; alias?: string; desc: string }[] = [
  { token: "message:", alias: "=:", desc: "message contains" },
  { token: "-message:", desc: "message does not contain" },
  { token: "author:", alias: "@:", desc: "author matches — @me is you" },
  { token: "committer:", desc: "committer matches" },
  { token: "commit:", alias: "#:", desc: "a specific sha" },
  { token: "file:", alias: "?:", desc: "touches this path or glob" },
  { token: "change:", alias: "~:", desc: "added or removed this string" },
  { token: "type:", alias: "is:", desc: "stash, tip or merge" },
  { token: "after:", alias: "since:", desc: "authored after a date" },
  { token: "before:", alias: "until:", desc: "authored before a date" },
  { token: "ref:", alias: "^:", desc: "restrict the walk to a ref or a..b" },
];

const MODES: { id: SearchMode; label: string; title: string }[] = [
  { id: "highlight", label: "Highlight", title: "Mark hits in place, history intact" },
  { id: "filter", label: "Filter", title: "Show only hits — the topology is not continuous" },
  { id: "select", label: "Select", title: "Select every hit for a range operation" },
];

const MODIFIERS: { id: keyof Modifiers; label: string; title: string }[] = [
  { id: "matchCase", label: "Aa", title: "Match case" },
  { id: "matchWholeWord", label: "ab", title: "Match whole word" },
  { id: "matchRegex", label: ".*", title: "Regular expression" },
  { id: "matchAll", label: "&", title: "Match all terms (AND) instead of any (OR)" },
];

/**
 * Does this query contain a pickaxe term?
 *
 * The grammar itself is parsed in Rust; this is the one fact the field needs
 * on its own, because `change:` diffs every commit it walks and so must wait
 * for Enter rather than run on each keystroke (§6).
 */
function isExpensive(query: string): boolean {
  return /(^|\s)(change:|~:)/.test(query);
}

/** The word the caret sits in, which is what autocomplete completes. */
function wordAtCaret(value: string, caret: number): { word: string; start: number } {
  const start = value.lastIndexOf(" ", Math.max(0, caret - 1)) + 1;
  return { word: value.slice(start, caret), start };
}

export function SearchBar({
  repoPath,
  pageSize,
  disabled,
  disabledReason,
  onNavigate,
}: {
  repoPath: string;
  pageSize: number;
  disabled: boolean;
  disabledReason: string;
  onNavigate: (delta: number) => void;
}) {
  const state = useSearch((s) => s.byRepo[repoPath]);
  // The actions never change identity, so read them once instead of
  // subscribing to the whole store (which would re-render on every keystroke
  // in every other tab's field).
  const store = useMemo(() => useSearch.getState(), []);
  const inputRef = useRef<HTMLInputElement>(null);
  const [suggestCursor, setSuggestCursor] = useState(0);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [caret, setCaret] = useState(0);
  const runId = useRef(0);

  const query = state?.query ?? "";
  const submitted = state?.submitted ?? "";
  const modifiers = state?.modifiers;
  const hits = state?.hits ?? [];
  const cursor = state?.cursor ?? -1;

  const { data: refs } = useQuery({
    queryKey: ["refs", repoPath],
    enabled: !!repoPath && suggestOpen,
    queryFn: () => listRefs(repoPath),
  });
  // Contributor autocomplete for `author:` (`08-search-and-filter.md` §7.1),
  // unblocked now that G28 exists. Fetched only while the dropdown is open:
  // it walks history, and nobody who never opens the dropdown should pay.
  const { data: contributors } = useQuery({
    queryKey: ["contributors", repoPath],
    enabled: !!repoPath && suggestOpen,
    queryFn: () => listContributors(repoPath),
    staleTime: 30_000,
  });

  const run = useCallback(
    async (text: string, cap = RESULT_CAP) => {
      const trimmed = text.trim();
      if (!trimmed) {
        store.clear(repoPath);
        return;
      }
      const id = ++runId.current;
      store.begin(repoPath, trimmed);
      try {
        const results = await searchCommits(
          repoPath,
          trimmed,
          { ...(modifiers ?? DEFAULT_MODIFIERS), pageSize },
          cap,
        );
        // A slower earlier query must not overwrite a newer one's results.
        if (id !== runId.current) return;
        store.finish(repoPath, trimmed, results);
        store.remember(repoPath, trimmed);
      } catch (error) {
        if (id !== runId.current) return;
        store.fail(repoPath, String(error));
      }
    },
    [repoPath, modifiers, pageSize, store],
  );

  // Search as the user types, except for pickaxe terms — those wait for Enter.
  useEffect(() => {
    if (disabled) return;
    const trimmed = query.trim();
    if (!trimmed) {
      if (submitted) store.clear(repoPath);
      return;
    }
    if (isExpensive(trimmed) || trimmed === submitted) return;
    const timer = window.setTimeout(() => void run(trimmed), 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, modifiers, disabled]);

  // Re-run when a modifier changes: the same text asks git a different
  // question, so leaving the old hits on screen would be a stale answer.
  useEffect(() => {
    const trimmed = submitted;
    if (trimmed && !isExpensive(trimmed)) void run(trimmed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modifiers]);

  // Materialise this repo's slice on mount. Until it exists there is nothing
  // to read the stored recent and pinned queries into, so the dropdown would
  // claim there are none until the user's first search of the session.
  useEffect(() => {
    useSearch.getState().patch(repoPath, {});
  }, [repoPath]);

  useEffect(() => {
    const focus = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("mtgit:focus-search", focus);
    return () => window.removeEventListener("mtgit:focus-search", focus);
  }, []);

  // The footer's "Keep going" after a truncated result: same query, no cap.
  useEffect(() => {
    const more = () => {
      if (submitted) void run(submitted, 0);
    };
    window.addEventListener("mtgit:search-more", more);
    return () => window.removeEventListener("mtgit:search-more", more);
  }, [submitted, run]);

  const suggestions = useMemo(() => {
    const { word } = wordAtCaret(query, caret);
    if (!word) return [] as { text: string; label: string; desc: string }[];
    const operator = OPERATORS.find((o) => word.startsWith(o.token) || (o.alias && word.startsWith(o.alias)));
    if (operator) {
      const prefix = word.slice(word.indexOf(":") + 1).toLowerCase();
      if (operator.token === "ref:") {
        const names = [
          ...(refs?.local ?? []).map((b) => b.name),
          ...(refs?.remote ?? []).map((b) => b.name),
          ...(refs?.tags ?? []).map((b) => b.name),
        ];
        return names
          .filter((name) => name.toLowerCase().startsWith(prefix))
          .slice(0, 8)
          .map((name) => ({ text: `ref:${name}`, label: name, desc: "ref" }));
      }
      if (operator.token === "author:") {
        // Completed to the *email*, not the display name: an email is unique
        // and needs no quoting, and "Ada Lovelace" as a bare value would parse
        // as two terms. Name and commit count are shown so the row is still
        // recognisable.
        return (contributors ?? [])
          .filter(
            (c) =>
              c.email.toLowerCase().startsWith(prefix) ||
              c.name.toLowerCase().startsWith(prefix),
          )
          .slice(0, 8)
          .map((c) => ({
            text: `author:${c.email}`,
            label: c.name || c.email,
            desc: `${c.email} · ${c.commits} commit${c.commits === 1 ? "" : "s"}`,
          }));
      }
      // `file:` still waits on a path source for the current selection.
      return [];
    }
    const lower = word.toLowerCase();
    return OPERATORS.filter((o) => o.token.startsWith(lower) || o.alias === lower)
      .slice(0, 8)
      .map((o) => ({
        text: o.token,
        label: o.alias ? `${o.token}  (${o.alias})` : o.token,
        desc: o.desc,
      }));
  }, [query, caret, refs, contributors]);

  const accept = (text: string) => {
    const { start } = wordAtCaret(query, caret);
    const next = `${query.slice(0, start)}${text}${query.slice(caret)}`;
    store.setQuery(repoPath, next);
    setSuggestOpen(false);
    requestAnimationFrame(() => {
      const at = start + text.length;
      inputRef.current?.setSelectionRange(at, at);
      setCaret(at);
    });
  };

  const showSuggestions = suggestOpen && suggestions.length > 0;

  if (disabled) {
    return (
      <div className="gs" title={disabledReason}>
        <input className="gs-input" placeholder="Search commits" disabled />
      </div>
    );
  }

  return (
    <div className="gs">
      <span className="gs-icon">⌕</span>
      <input
        ref={inputRef}
        className={`gs-input${state?.error ? " error" : ""}`}
        placeholder="Search commits — message:, author:, file:, change:…"
        value={query}
        spellCheck={false}
        onChange={(e) => {
          store.setQuery(repoPath, e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setSuggestOpen(true);
          setSuggestCursor(0);
        }}
        onSelect={(e) => setCaret((e.target as HTMLInputElement).selectionStart ?? 0)}
        onBlur={() => window.setTimeout(() => setSuggestOpen(false), 120)}
        onKeyDown={(e) => {
          if (showSuggestions && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setSuggestCursor((c) =>
              e.key === "ArrowDown"
                ? Math.min(suggestions.length - 1, c + 1)
                : Math.max(0, c - 1),
            );
            return;
          }
          if (showSuggestions && (e.key === "Tab" || (e.key === "Enter" && suggestions[suggestCursor]?.text.endsWith(":")))) {
            e.preventDefault();
            accept(suggestions[suggestCursor].text);
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            setSuggestOpen(false);
            if (e.shiftKey) onNavigate(-1);
            else if (query.trim() === submitted && hits.length > 0) onNavigate(1);
            else void run(query);
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            if (showSuggestions) {
              setSuggestOpen(false);
            } else if (query) {
              store.clear(repoPath);
            } else {
              inputRef.current?.blur();
            }
          }
        }}
      />

      {state?.running && (
        <button
          className="gs-cancel"
          title="Cancel this search"
          onClick={() => void cancelSearch(repoPath).catch(() => {})}
        >
          ◼
        </button>
      )}

      {submitted && !state?.running && (
        <span className="gs-count" title={`${hits.length} matching commit(s)`}>
          {hits.length === 0
            ? "no results"
            : cursor < 0
              ? `${hits.length} result${hits.length === 1 ? "" : "s"}`
              : `${cursor + 1} of ${hits.length}`}
        </span>
      )}
      <button
        className="gs-step"
        title="Previous hit (⇧F3 / ⇧⌘G)"
        disabled={hits.length === 0}
        onClick={() => onNavigate(-1)}
      >
        ↑
      </button>
      <button
        className="gs-step"
        title="Next hit (F3 / ⌘G)"
        disabled={hits.length === 0}
        onClick={() => onNavigate(1)}
      >
        ↓
      </button>

      <div className="gs-mods">
        {MODIFIERS.map((m) => (
          <button
            key={m.id}
            className={`gs-mod${modifiers?.[m.id] ? " on" : ""}`}
            title={m.title}
            onClick={() => store.setModifiers(repoPath, { [m.id]: !modifiers?.[m.id] })}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="gs-modes">
        {MODES.map((m) => (
          <button
            key={m.id}
            className={`gs-mode${state?.mode === m.id ? " on" : ""}`}
            title={m.title}
            onClick={() => store.setMode(repoPath, m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <button
        className="gs-hist"
        title="Recent and pinned queries"
        onClick={() => setHistoryOpen((v) => !v)}
      >
        ▾
      </button>
      {query && (
        <button className="gs-clear" title="Clear search (Esc)" onClick={() => store.clear(repoPath)}>
          ✕
        </button>
      )}

      {historyOpen && (
        <div className="gs-pop" onMouseLeave={() => setHistoryOpen(false)}>
          {state?.pinned.length ? (
            <>
              <div className="gs-pop-head">Pinned</div>
              {state.pinned.map((p) => (
                <div key={p.name} className="gs-pop-row">
                  <button
                    className="gs-pop-item"
                    onClick={() => {
                      store.setQuery(repoPath, p.query);
                      setHistoryOpen(false);
                      void run(p.query);
                    }}
                  >
                    <span className="gs-pop-name">{p.name}</span>
                    <span className="gs-pop-q">{p.query}</span>
                  </button>
                  <button className="gs-pop-x" title="Unpin" onClick={() => store.unpin(repoPath, p.name)}>
                    ✕
                  </button>
                </div>
              ))}
            </>
          ) : null}
          <div className="gs-pop-head">This session</div>
          {(state?.recent ?? []).map((q) => (
            <button
              key={q}
              className="gs-pop-item"
              onClick={() => {
                store.setQuery(repoPath, q);
                setHistoryOpen(false);
                void run(q);
              }}
            >
              <span className="gs-pop-q">{q}</span>
            </button>
          ))}
          {(state?.recent ?? []).length === 0 && <div className="gs-pop-empty">No recent queries</div>}
          {query.trim() && (
            <button
              className="gs-pop-pin"
              onClick={() => {
                const name = query.trim().slice(0, 40);
                store.pin(repoPath, name, query.trim());
                setHistoryOpen(false);
              }}
            >
              📌 Pin “{query.trim().slice(0, 28)}”
            </button>
          )}
        </div>
      )}

      {showSuggestions && (
        <div className="gs-suggest">
          {suggestions.map((s, i) => (
            <button
              key={s.text}
              className={`gs-suggest-item${i === suggestCursor ? " active" : ""}`}
              onMouseEnter={() => setSuggestCursor(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => accept(s.text)}
            >
              <span className="gs-suggest-token">{s.label}</span>
              <span className="gs-suggest-desc">{s.desc}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
