import { create } from "zustand";
import type { RepoInfo } from "../ipc/types";

const RECENT_KEY = "mtgit.recentRepos";

/** Sentinel `selectedOid` value meaning "the uncommitted working tree / WIP row". */
export const WORKING = "__WORKING__";

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export type DiffMode = "inline" | "split";

export interface GraphOpts {
  relativeDates: boolean;
  showAuthor: boolean;
}

interface SessionState {
  repo: RepoInfo | null; // the active tab's repo
  tabs: RepoInfo[];
  selectedOid: string | null;
  selectedFile: string | null;
  recentRepos: string[];
  terminalOpen: boolean;
  diffMode: DiffMode;
  paletteOpen: boolean;
  sidebarCollapsed: boolean;
  graphOpts: GraphOpts;

  setRepo: (repo: RepoInfo) => void;
  switchTab: (path: string) => void;
  closeTab: (path: string) => void;
  selectOid: (oid: string | null) => void;
  selectFile: (path: string | null) => void;
  toggleTerminal: () => void;
  setDiffMode: (m: DiffMode) => void;
  setPaletteOpen: (v: boolean) => void;
  toggleSidebar: () => void;
  setGraphOpts: (o: Partial<GraphOpts>) => void;
}

export const useSession = create<SessionState>((set) => ({
  repo: null,
  tabs: [],
  selectedOid: null,
  selectedFile: null,
  recentRepos: loadRecent(),
  terminalOpen: false,
  diffMode: "inline",
  paletteOpen: false,
  sidebarCollapsed: false,
  graphOpts: { relativeDates: true, showAuthor: true },

  setRepo: (repo) =>
    set((s) => {
      const recent = [repo.path, ...s.recentRepos.filter((p) => p !== repo.path)].slice(0, 8);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
      } catch {
        /* ignore quota errors */
      }
      const tabs = s.tabs.some((t) => t.path === repo.path)
        ? s.tabs.map((t) => (t.path === repo.path ? repo : t))
        : [...s.tabs, repo];
      return { repo, tabs, recentRepos: recent, selectedOid: null, selectedFile: null };
    }),

  switchTab: (path) =>
    set((s) => {
      const repo = s.tabs.find((t) => t.path === path) ?? s.repo;
      return { repo, selectedOid: null, selectedFile: null };
    }),

  closeTab: (path) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.path !== path);
      const repo = s.repo?.path === path ? (tabs[tabs.length - 1] ?? null) : s.repo;
      return { tabs, repo, selectedOid: null, selectedFile: null };
    }),

  selectOid: (oid) => set({ selectedOid: oid, selectedFile: null }),
  selectFile: (path) => set({ selectedFile: path }),
  toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),
  setDiffMode: (m) => set({ diffMode: m }),
  setPaletteOpen: (v) => set({ paletteOpen: v }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setGraphOpts: (o) => set((s) => ({ graphOpts: { ...s.graphOpts, ...o } })),
}));
