import { create } from "zustand";

/** Which operation left the working tree in a conflicted / in-progress state. */
export type ConflictKind = "merge" | "rebase" | "cherryPick" | "revert";

export interface ConflictInfo {
  repoPath: string;
  kind: ConflictKind;
  files: string[];
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
