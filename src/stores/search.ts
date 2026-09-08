import { create } from "zustand";
import type { SearchHit, SearchOptions, SearchResults } from "../ipc/types";

/** What a query does to the graph (overview §7, `08-search-and-filter.md` §4). */
export type SearchMode = "highlight" | "filter" | "select";

export type Modifiers = Omit<SearchOptions, "pageSize">;

export const DEFAULT_MODIFIERS: Modifiers = {
  matchCase: false,
  matchAll: false,
  matchRegex: false,
  matchWholeWord: false,
};

export interface PinnedQuery {
  name: string;
  query: string;
}

export interface RepoSearch {
  /** Text in the field. */
  query: string;
  /** The query the current `hits` actually belong to. */
  submitted: string;
  modifiers: Modifiers;
  mode: SearchMode;
  running: boolean;
  hits: SearchHit[];
  /** Index into `hits`, or -1 for "no current hit". */
  cursor: number;
  truncated: boolean;
  cancelled: boolean;
  summary: string;
  notes: string[];
  error: string | null;
  /**
   * Selection and scroll position from before filter mode was entered, so
   * leaving it restores both exactly (B5). Also what makes clearing a query
   * put the graph back where it was (overview §7).
   */
  restore: { oid: string | null; scrollTop: number } | null;
  recent: string[];
  pinned: PinnedQuery[];
}

const RECENT_KEY = "mtgit.search.recent";
const PINNED_KEY = "mtgit.search.pinned";
const RECENT_MAX = 12;

function load<T>(key: string, repoPath: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`${key}.${repoPath}`);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, repoPath: string, value: unknown) {
  try {
    localStorage.setItem(`${key}.${repoPath}`, JSON.stringify(value));
  } catch {
    /* ignore quota errors */
  }
}

function blank(repoPath: string): RepoSearch {
  return {
    query: "",
    submitted: "",
    modifiers: { ...DEFAULT_MODIFIERS },
    // Highlight preserves topology; filtering a lane graph draws edges between
    // rows that are not parent and child, which is a lie unless asked for.
    mode: "highlight",
    running: false,
    hits: [],
    cursor: -1,
    truncated: false,
    cancelled: false,
    summary: "",
    notes: [],
    error: null,
    restore: null,
    recent: load<string[]>(RECENT_KEY, repoPath, []),
    pinned: load<PinnedQuery[]>(PINNED_KEY, repoPath, []),
  };
}

interface SearchState {
  /** Per repo path, so a query survives a tab switch (G12 / B7). */
  byRepo: Record<string, RepoSearch>;

  get: (repoPath: string) => RepoSearch;
  patch: (repoPath: string, next: Partial<RepoSearch>) => void;
  setQuery: (repoPath: string, query: string) => void;
  setMode: (repoPath: string, mode: SearchMode) => void;
  setModifiers: (repoPath: string, next: Partial<Modifiers>) => void;
  begin: (repoPath: string, query: string) => void;
  finish: (repoPath: string, query: string, results: SearchResults) => void;
  fail: (repoPath: string, message: string) => void;
  clear: (repoPath: string) => void;
  setCursor: (repoPath: string, cursor: number) => void;
  step: (repoPath: string, delta: number) => number;
  remember: (repoPath: string, query: string) => void;
  pin: (repoPath: string, name: string, query: string) => void;
  unpin: (repoPath: string, name: string) => void;
}

export const EMPTY_SEARCH = blank("");

export const useSearch = create<SearchState>((set, getState) => ({
  byRepo: {},

  get: (repoPath) => getState().byRepo[repoPath] ?? EMPTY_SEARCH,

  patch: (repoPath, next) =>
    set((state) => ({
      byRepo: {
        ...state.byRepo,
        [repoPath]: { ...(state.byRepo[repoPath] ?? blank(repoPath)), ...next },
      },
    })),

  setQuery: (repoPath, query) => getState().patch(repoPath, { query, error: null }),
  setMode: (repoPath, mode) => getState().patch(repoPath, { mode }),
  setModifiers: (repoPath, next) =>
    set((state) => {
      const current = state.byRepo[repoPath] ?? blank(repoPath);
      return {
        byRepo: {
          ...state.byRepo,
          [repoPath]: { ...current, modifiers: { ...current.modifiers, ...next } },
        },
      };
    }),

  begin: (repoPath, query) =>
    getState().patch(repoPath, { running: true, error: null, submitted: query }),

  finish: (repoPath, query, results) =>
    getState().patch(repoPath, {
      running: false,
      submitted: query,
      hits: results.hits,
      // No current hit yet. Landing on the first one would scroll the graph
      // out from under someone still typing; the count reads "37 results"
      // until they ask for one, and then Enter / F3 goes to the first.
      cursor: -1,
      truncated: results.truncated,
      cancelled: results.cancelled,
      summary: results.summary,
      notes: results.notes,
      error: null,
    }),

  fail: (repoPath, message) =>
    getState().patch(repoPath, { running: false, error: message, hits: [], cursor: -1 }),

  clear: (repoPath) =>
    getState().patch(repoPath, {
      query: "",
      submitted: "",
      hits: [],
      cursor: -1,
      running: false,
      truncated: false,
      cancelled: false,
      summary: "",
      notes: [],
      error: null,
    }),

  setCursor: (repoPath, cursor) => getState().patch(repoPath, { cursor }),

  /** Move the cursor by `delta`, wrapping. Returns the new index, or -1. */
  step: (repoPath, delta) => {
    const current = getState().get(repoPath);
    if (current.hits.length === 0) return -1;
    const from = current.cursor < 0 ? (delta > 0 ? -1 : 0) : current.cursor;
    const next = (from + delta + current.hits.length) % current.hits.length;
    getState().patch(repoPath, { cursor: next });
    return next;
  },

  remember: (repoPath, query) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const current = getState().get(repoPath);
    const recent = [trimmed, ...current.recent.filter((q) => q !== trimmed)].slice(0, RECENT_MAX);
    save(RECENT_KEY, repoPath, recent);
    getState().patch(repoPath, { recent });
  },

  pin: (repoPath, name, query) => {
    const current = getState().get(repoPath);
    const pinned = [...current.pinned.filter((p) => p.name !== name), { name, query }];
    save(PINNED_KEY, repoPath, pinned);
    getState().patch(repoPath, { pinned });
  },

  unpin: (repoPath, name) => {
    const current = getState().get(repoPath);
    const pinned = current.pinned.filter((p) => p.name !== name);
    save(PINNED_KEY, repoPath, pinned);
    getState().patch(repoPath, { pinned });
  },
}));

/** Read the slice for one repo, creating it on first access. */
export function useRepoSearch(repoPath: string | undefined): RepoSearch {
  return useSearch((s) => (repoPath ? s.byRepo[repoPath] ?? EMPTY_SEARCH : EMPTY_SEARCH));
}

/**
 * Seed the field from somewhere else in the app (the palette, an author cell,
 * a file row) and open it. Adding a term rather than replacing the query is
 * what makes `author:X file:Y` reachable by two clicks.
 */
export function seedSearch(repoPath: string, term: string, replace = false) {
  const store = useSearch.getState();
  const current = store.get(repoPath);
  const query = replace || !current.query.trim() ? term : `${current.query.trim()} ${term}`;
  store.patch(repoPath, { query });
  window.dispatchEvent(new CustomEvent("mtgit:focus-search", { detail: { repoPath } }));
}
