import { create } from "zustand";
import type { RepoInfo } from "../ipc/types";

const RECENT_KEY = "mtgit.recentRepos";
const RECENT_LIMIT = 12;

/** Sentinel `selectedOid` value meaning "the uncommitted working tree / WIP row". */
export const WORKING = "__WORKING__";

/**
 * A repo the user has opened before, as the start screen lists it: enough to
 * render a row without opening the repository, which is the whole point —
 * `open_repo` on a path that has since been deleted or unmounted is slow to
 * fail, and the start screen must draw instantly.
 */
export interface RecentRepo {
  path: string;
  name: string;
  /** Epoch millis of the last open. */
  lastOpened: number;
  /** Branch at the last open; a hint, not live state. */
  branch: string | null;
}

function loadRecent(): RecentRepo[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Before the start screen this was a bare `string[]`. Migrate rather than
    // discard: the recent list is the only repo memory the app has.
    return parsed
      .map((entry) =>
        typeof entry === "string"
          ? { path: entry, name: basename(entry), lastOpened: 0, branch: null }
          : (entry as RecentRepo),
      )
      .filter((entry): entry is RecentRepo => !!entry && typeof entry.path === "string");
  } catch {
    return [];
  }
}

function saveRecent(recent: RecentRepo[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    /* ignore quota errors */
  }
}

function basename(path: string): string {
  return path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || path;
}

export type DiffMode = "inline" | "split";

export interface GraphOpts {
  relativeDates: boolean;
  showAuthor: boolean;
}

/** Per-tab view state, so switching tabs does not discard a selection (G12). */
interface TabView {
  selectedOid: string | null;
  selectedFile: string | null;
}

interface SessionState {
  /** The active tab's repo; null while the Start tab is active. */
  repo: RepoInfo | null;
  tabs: RepoInfo[];
  /** Is the Start tab present in the strip? */
  startTab: boolean;
  /** Is the Start tab the active one? Implies `repo === null`. */
  activeStart: boolean;
  selectedOid: string | null;
  selectedFile: string | null;
  tabViews: Record<string, TabView>;
  recentRepos: RecentRepo[];
  terminalOpen: boolean;
  diffMode: DiffMode;
  paletteOpen: boolean;
  sidebarCollapsed: boolean;
  graphOpts: GraphOpts;
  hiddenRefs: Record<string, string[]>;
  checkoutTarget: string | null;
  /** Is the clone form up? Hoisted here so the toolbar can raise it too. */
  cloneOpen: boolean;

  setCloneOpen: (v: boolean) => void;
  setRepo: (repo: RepoInfo) => void;
  switchTab: (path: string) => void;
  closeTab: (path: string) => void;
  moveTab: (from: number, to: number) => void;
  openStart: () => void;
  closeStart: () => void;
  forgetRecent: (path: string) => void;
  selectOid: (oid: string | null) => void;
  selectFile: (path: string | null) => void;
  toggleTerminal: () => void;
  setDiffMode: (m: DiffMode) => void;
  setPaletteOpen: (v: boolean) => void;
  toggleSidebar: () => void;
  setGraphOpts: (o: Partial<GraphOpts>) => void;
  toggleHiddenRef: (repoPath: string, ref: string) => void;
  setCheckoutTarget: (ref: string | null) => void;
}

/**
 * Activate `path`, restoring the view it was left in. Shared by `setRepo`,
 * `switchTab` and the close/remove paths so there is one place that knows the
 * rule "activating a repo tab clears `activeStart`".
 */
function activate(s: SessionState, repo: RepoInfo): Partial<SessionState> {
  const view = s.tabViews[repo.path];
  return {
    repo,
    activeStart: false,
    selectedOid: view?.selectedOid ?? null,
    selectedFile: view?.selectedFile ?? null,
  };
}

/** Persist the live selection back onto the tab it belongs to. */
function remember(s: SessionState): Record<string, TabView> {
  if (!s.repo) return s.tabViews;
  return {
    ...s.tabViews,
    [s.repo.path]: { selectedOid: s.selectedOid, selectedFile: s.selectedFile },
  };
}

export const useSession = create<SessionState>((set) => ({
  repo: null,
  tabs: [],
  // Boot into the start screen: three empty panes were G3.
  startTab: true,
  activeStart: true,
  selectedOid: null,
  selectedFile: null,
  tabViews: {},
  recentRepos: loadRecent(),
  terminalOpen: false,
  diffMode: "inline",
  paletteOpen: false,
  sidebarCollapsed: false,
  graphOpts: { relativeDates: true, showAuthor: true },
  hiddenRefs: {},
  checkoutTarget: null,
  cloneOpen: false,

  setCloneOpen: (cloneOpen) => set({ cloneOpen }),

  setRepo: (repo) =>
    set((s) => {
      const recent: RecentRepo[] = [
        { path: repo.path, name: repo.name, lastOpened: Date.now(), branch: repo.head.branch },
        ...s.recentRepos.filter((r) => r.path !== repo.path),
      ].slice(0, RECENT_LIMIT);
      saveRecent(recent);

      const tabs = s.tabs.some((t) => t.path === repo.path)
        ? s.tabs.map((t) => (t.path === repo.path ? repo : t))
        : [...s.tabs, repo];

      // `setRepo` doubles as the watcher's "HEAD moved" update for the repo
      // already on screen, so re-activating the active tab must not reset its
      // selection — only a genuine switch does.
      // Note: `cloneOpen` is deliberately untouched here. This branch is also
      // the fs watcher's "HEAD moved" update, and closing a form the user is
      // still filling in because something changed on disk is its own bug.
      if (s.repo?.path === repo.path) return { repo, tabs, recentRepos: recent };
      return { tabs, recentRepos: recent, cloneOpen: false, tabViews: remember(s), ...activate(s, repo) };
    }),

  switchTab: (path) =>
    set((s) => {
      const repo = s.tabs.find((t) => t.path === path);
      if (!repo || s.repo?.path === path) return {};
      const tabViews = remember(s);
      return { tabViews, ...activate({ ...s, tabViews }, repo) };
    }),

  closeTab: (path) =>
    set((s) => {
      const index = s.tabs.findIndex((t) => t.path === path);
      if (index < 0) return {};
      const tabs = s.tabs.filter((t) => t.path !== path);
      const { [path]: _closed, ...tabViews } = remember(s);

      if (s.repo?.path !== path) return { tabs, tabViews };
      // Closing the active tab hands focus to its right-hand neighbour, then
      // its left — and to the start screen when nothing is left, which is the
      // only state in which there is no repo to show.
      const next = tabs[index] ?? tabs[index - 1];
      if (!next) return { tabs, tabViews, repo: null, startTab: true, activeStart: true, selectedOid: null, selectedFile: null };
      return { tabs, tabViews, ...activate({ ...s, tabViews }, next) };
    }),

  moveTab: (from, to) =>
    set((s) => {
      if (from === to || from < 0 || to < 0 || from >= s.tabs.length || to >= s.tabs.length) return {};
      const tabs = [...s.tabs];
      const [moved] = tabs.splice(from, 1);
      tabs.splice(to, 0, moved);
      return { tabs };
    }),

  openStart: () => set((s) => ({ startTab: true, activeStart: true, repo: null, tabViews: remember(s), selectedOid: null, selectedFile: null })),

  closeStart: () =>
    set((s) => {
      // The start tab is the app's floor: with no repo open there is nothing
      // else to show, so closing it there is a no-op rather than a blank app.
      if (!s.tabs.length) return {};
      if (!s.activeStart) return { startTab: false };
      return { startTab: false, ...activate(s, s.tabs[s.tabs.length - 1]) };
    }),

  forgetRecent: (path) =>
    set((s) => {
      const recentRepos = s.recentRepos.filter((r) => r.path !== path);
      saveRecent(recentRepos);
      return { recentRepos };
    }),

  selectOid: (oid) => set({ selectedOid: oid, selectedFile: null }),
  selectFile: (path) => set({ selectedFile: path }),
  toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),
  setDiffMode: (m) => set({ diffMode: m }),
  setPaletteOpen: (v) => set({ paletteOpen: v }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setGraphOpts: (o) => set((s) => ({ graphOpts: { ...s.graphOpts, ...o } })),
  toggleHiddenRef: (repoPath, ref) =>
    set((state) => {
      const current = new Set(state.hiddenRefs[repoPath] ?? []);
      if (current.has(ref)) current.delete(ref);
      else current.add(ref);
      return { hiddenRefs: { ...state.hiddenRefs, [repoPath]: [...current] } };
    }),
  setCheckoutTarget: (checkoutTarget) => set({ checkoutTarget }),
}));
