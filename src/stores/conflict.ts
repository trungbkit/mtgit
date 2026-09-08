import { create } from "zustand";

/** Which operation left the working tree in a conflicted / in-progress state. */
export type ConflictKind = "merge" | "rebase" | "cherryPick" | "revert";

export interface ConflictInfo {
  repoPath: string;
  kind: ConflictKind;
  files: string[];
  currentSha?: string | null;
  current?: number;
  total?: number;
  canSkip?: boolean;
}

interface ConflictState {
  active: ConflictInfo | null;
  set: (info: ConflictInfo) => void;
  clear: () => void;
}

export const useConflict = create<ConflictState>((set) => ({
  active: null,
  set: (info) => set({ active: info }),
  clear: () => set({ active: null }),
}));

const LABEL: Record<ConflictKind, string> = {
  merge: "Merge",
  rebase: "Rebase",
  cherryPick: "Cherry-pick",
  revert: "Revert",
};

export function conflictLabel(kind: ConflictKind): string {
  return LABEL[kind];
}

/**
 * Ask the conflict banner to make itself noticed.
 *
 * `00-overview.md` §5.3 wants a refused operation to *point* at the banner, not
 * merely mention it. The banner lives outside any scroll container today, so
 * the flash is the load-bearing half and `scrollIntoView` is insurance for the
 * day the shell grows one.
 */
export const REVEAL_BANNER_EVENT = "mtgit-reveal-conflict-banner";

export function revealConflictBanner(): void {
  window.dispatchEvent(new Event(REVEAL_BANNER_EVENT));
}
