import { beforeEach, describe, expect, it } from "vitest";
import { useDetailStack, sheetTitle } from "./detailStack";
import { resetStores } from "../test/stores";

const commit = (oid: string) => ({ kind: "commit" as const, oid });

describe("detail stack", () => {
  beforeEach(resetStores);

  it("starts empty, so the panel shows the graph selection", () => {
    expect(useDetailStack.getState().stack).toEqual([]);
  });

  it("pushes and pops in order", () => {
    const { push, pop } = useDetailStack.getState();
    push(commit("a".repeat(40)));
    push({ kind: "compare", oldOid: "b".repeat(40), newOid: "c".repeat(40) });
    expect(useDetailStack.getState().stack).toHaveLength(2);
    pop();
    expect(useDetailStack.getState().stack).toEqual([commit("a".repeat(40))]);
  });

  it("ignores a push of what is already on top", () => {
    // Double-clicking a parent link must not need two Backs to undo.
    const { push } = useDetailStack.getState();
    push(commit("a".repeat(40)));
    push(commit("a".repeat(40)));
    expect(useDetailStack.getState().stack).toHaveLength(1);
  });

  it("still stacks the same commit when something else is between", () => {
    const { push } = useDetailStack.getState();
    push(commit("a".repeat(40)));
    push(commit("b".repeat(40)));
    push(commit("a".repeat(40)));
    expect(useDetailStack.getState().stack).toHaveLength(3);
  });

  it("clears back to the selection in one step", () => {
    const { push, clear } = useDetailStack.getState();
    push(commit("a".repeat(40)));
    push(commit("b".repeat(40)));
    clear();
    expect(useDetailStack.getState().stack).toEqual([]);
  });

  it("popping an empty stack is a no-op rather than an error", () => {
    useDetailStack.getState().pop();
    expect(useDetailStack.getState().stack).toEqual([]);
  });

  it("titles a sheet by what it shows", () => {
    expect(sheetTitle(commit("abcdef1234567890"))).toBe("abcdef1");
    expect(sheetTitle({ kind: "compare", oldOid: "1111111111", newOid: "2222222222" })).toBe(
      "1111111 → 2222222",
    );
  });
});
