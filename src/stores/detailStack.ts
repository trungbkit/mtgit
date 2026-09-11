import { create } from "zustand";

/**
 * The detail stack (G24).
 *
 * The detail panel used to be a *mode*: comparing two commits replaced the
 * whole right-hand side and the only way out was to close it, which lost the
 * commit you had been reading. Sheets fix that by making the panel a stack —
 * you push a comparison, or a parent commit, on top of what you were looking
 * at, and Back returns you to it.
 *
 * The base of the stack is deliberately *not* in here: it is the graph
 * selection (`stores/session`'s `selectedOid`), which stays the single source
 * of truth for "which row is highlighted". Duplicating it would be a second
 * answer to one question — the shape defect A1 had. So the stack holds only
 * what is layered *above* the selection, and selecting a row clears it:
 * clicking a commit means "look at this", not "add a layer".
 */

export type DetailSheet =
  | { kind: "commit"; oid: string }
  | { kind: "compare"; oldOid: string; newOid: string };

interface DetailStackState {
  stack: DetailSheet[];
  push: (sheet: DetailSheet) => void;
  pop: () => void;
  /** Drop back to the selection. */
  clear: () => void;
}

export function sheetTitle(sheet: DetailSheet): string {
  return sheet.kind === "commit"
    ? sheet.oid.slice(0, 7)
    : `${sheet.oldOid.slice(0, 7)} → ${sheet.newOid.slice(0, 7)}`;
}

function sameSheet(a: DetailSheet, b: DetailSheet): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "commit" && b.kind === "commit"
    ? a.oid === b.oid
    : a.kind === "compare" && b.kind === "compare"
      ? a.oldOid === b.oldOid && a.newOid === b.newOid
      : false;
}

export const useDetailStack = create<DetailStackState>((set, get) => ({
  stack: [],
  push: (sheet) => {
    const stack = get().stack;
    // Pushing what is already on top is a no-op rather than a second copy:
    // double-clicking a parent link should not need two Backs to undo.
    const top = stack[stack.length - 1];
    if (top && sameSheet(top, sheet)) return;
    set({ stack: [...stack, sheet] });
  },
  pop: () => set({ stack: get().stack.slice(0, -1) }),
  clear: () => set({ stack: [] }),
}));

export function pushDetail(sheet: DetailSheet): void {
  useDetailStack.getState().push(sheet);
}
