import { describe, expect, it, vi } from "vitest";
import { dropMenuItems } from "./dropMenu";
import type { MergeRelation } from "../ipc/types";

const relation = (over: Partial<MergeRelation> = {}): MergeRelation => ({
  canFastForward: false,
  upToDate: false,
  ahead: 1,
  behind: 1,
  ...over,
});

const labels = (items: ReturnType<typeof dropMenuItems>) => items.map((item) => item.label ?? "—");

describe("dropMenuItems", () => {
  it("offers all three when a fast-forward is possible", () => {
    const items = dropMenuItems("main", "feature", relation({ canFastForward: true, ahead: 0 }), vi.fn());
    expect(labels(items)).toEqual([
      "Merge feature into main",
      "Rebase main onto feature",
      "Fast-forward main to feature",
    ]);
    expect(items.every((item) => !("disabled" in item && item.disabled))).toBe(true);
  });

  /** STATUS C6: the option is computed, not always offered. */
  it("disables fast-forward on a diverged pair rather than letting git refuse it", () => {
    const items = dropMenuItems("main", "feature", relation(), vi.fn());
    const ff = items.find((item) => item.label?.startsWith("Fast-forward"));
    expect(ff).toMatchObject({ disabled: true });
  });

  it("says so when the target already contains the source", () => {
    const items = dropMenuItems("main", "feature", relation({ upToDate: true, behind: 0 }), vi.fn());
    expect(labels(items)[0]).toBe("main already contains feature");
    expect(items[0]).toMatchObject({ disabled: true });
    // Rebase is still meaningful — it rewrites main's own commits onto feature.
    expect(labels(items)).toContain("Rebase main onto feature");
  });

  it("keeps fast-forward enabled when the relation could not be read", () => {
    // Hiding a legal option because the lookup failed is worse than offering
    // one git may refuse with a clear message.
    const items = dropMenuItems("main", "feature", null, vi.fn());
    const ff = items.find((item) => item.label?.startsWith("Fast-forward"));
    expect(ff).not.toMatchObject({ disabled: true });
  });

  it("wires each row to its action", () => {
    const run = vi.fn();
    const items = dropMenuItems("main", "feature", relation({ canFastForward: true }), run);
    for (const item of items) item.onClick?.();
    expect(run.mock.calls.map((call) => call[0])).toEqual(["merge", "rebase", "ff"]);
  });
});
