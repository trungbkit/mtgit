import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStores } from "../test/stores";
import { REVEAL_BANNER_EVENT, useConflict } from "../stores/conflict";
import type { OperationInfo } from "./types";
import { refreshRepo, requireNoPausedOperation, syncOperation } from "./repoState";
import { graphKey, operationInfo } from "./commands";

vi.mock("./commands", () => ({ operationInfo: vi.fn(), graphKey: vi.fn() }));

const mockOperationInfo = vi.mocked(operationInfo);
const mockGraphKey = vi.mocked(graphKey);
const REPO = "/repo";
const OTHER = "/other";

function info(over: Partial<OperationInfo> = {}): OperationInfo {
  return {
    kind: "merge",
    conflicts: ["a.txt"],
    currentSha: null,
    current: 1,
    total: 1,
    canContinue: true,
    canSkip: false,
    ...over,
  };
}

beforeEach(() => {
  resetStores();
  mockOperationInfo.mockReset();
  mockOperationInfo.mockResolvedValue(null);
  mockGraphKey.mockReset();
  // A fresh digest per test, so no test inherits another's "unchanged" answer
  // from the module-level map `refreshGraph` keeps.
  mockGraphKey.mockResolvedValue(`key-${Math.random()}`);
});

/**
 * `00-overview.md` §5.1: operation state is *discovered* from git, never
 * remembered. These pin the single writer to the conflict store — the seam
 * that closed A1, and which the Rust suite can only reach from underneath.
 */
describe("syncOperation", () => {
  it("publishes what git reports, including the i-of-n the backend owns", async () => {
    mockOperationInfo.mockResolvedValue(
      info({ kind: "cherryPick", conflicts: ["a", "b"], current: 3, total: 7, canSkip: true }),
    );
    await syncOperation(REPO);
    expect(useConflict.getState().active).toEqual({
      repoPath: REPO,
      kind: "cherryPick",
      files: ["a", "b"],
      currentSha: null,
      current: 3,
      total: 7,
      canSkip: true,
    });
  });

  it("treats the backend's catch-all 'operation' kind as no operation", async () => {
    // It is the backend's "in some state I don't model" — not something the
    // banner can describe, so a banner it cannot label must not appear.
    mockOperationInfo.mockResolvedValue(info({ kind: "operation" }));
    await syncOperation(REPO);
    expect(useConflict.getState().active).toBeNull();
  });

  it("clears this repo's operation when git no longer reports one", async () => {
    mockOperationInfo.mockResolvedValue(info());
    await syncOperation(REPO);
    mockOperationInfo.mockResolvedValue(null);
    await syncOperation(REPO);
    expect(useConflict.getState().active).toBeNull();
  });

  it("leaves another tab's paused operation alone", async () => {
    mockOperationInfo.mockResolvedValue(info());
    await syncOperation(OTHER);
    mockOperationInfo.mockResolvedValue(null);
    await syncOperation(REPO);
    expect(useConflict.getState().active?.repoPath).toBe(OTHER);
  });

  it("swallows a failed read: discovery is best-effort", async () => {
    mockOperationInfo.mockRejectedValue(new Error("repo is gone"));
    await expect(syncOperation(REPO)).resolves.toBeUndefined();
    expect(useConflict.getState().active).toBeNull();
  });
});

/**
 * A3. The gate exists to replace git's own refusal with one that says where
 * the Abort button is, so what it must not do is refuse anything else.
 */
describe("requireNoPausedOperation", () => {
  it("refuses, naming both the action and the operation in the way out", async () => {
    mockOperationInfo.mockResolvedValue(info({ kind: "rebase" }));
    await expect(requireNoPausedOperation(REPO, "check out main")).rejects.toThrow(
      /Cannot check out main while a rebase is in progress/,
    );
  });

  it("points at the banner rather than only mentioning it", async () => {
    const listener = vi.fn();
    window.addEventListener(REVEAL_BANNER_EVENT, listener);
    mockOperationInfo.mockResolvedValue(info());
    await expect(requireNoPausedOperation(REPO, "pull")).rejects.toThrow();
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(REVEAL_BANNER_EVENT, listener);
  });

  it("re-reads git rather than trusting the store, so a stale banner cannot block", async () => {
    useConflict.getState().set({ repoPath: REPO, kind: "merge", files: ["a.txt"] });
    mockOperationInfo.mockResolvedValue(null);
    await expect(requireNoPausedOperation(REPO, "pull")).resolves.toBeUndefined();
    expect(mockOperationInfo).toHaveBeenCalledWith(REPO);
    expect(useConflict.getState().active).toBeNull();
  });

  it("refuses on a resolved-but-still-paused operation, which is the dangerous half", async () => {
    // A rebase stopped mid-plan with every conflict staged has an empty
    // conflict list and pending replays: anything keying off `conflicts` being
    // empty would wave a checkout through and abandon them.
    mockOperationInfo.mockResolvedValue(info({ kind: "rebase", conflicts: [] }));
    await expect(requireNoPausedOperation(REPO, "check out main")).rejects.toThrow(/rebase/);
  });

  it("does not refuse on another repository's paused operation", async () => {
    mockOperationInfo.mockResolvedValue(info());
    await syncOperation(OTHER);
    mockOperationInfo.mockResolvedValue(null);
    await expect(requireNoPausedOperation(REPO, "pull")).resolves.toBeUndefined();
  });

  it("fails open when git cannot be interrogated", async () => {
    // A gate that has lost its footing must not become a wall.
    mockOperationInfo.mockRejectedValue(new Error("nope"));
    await expect(requireNoPausedOperation(REPO, "pull")).resolves.toBeUndefined();
  });
});

describe("refreshRepo", () => {
  it("invalidates only this repo's queries, keyed by path at index 1", async () => {
    // `CLAUDE.md` invariant 3: a key shaped any other way never refreshes,
    // with no error — which is exactly why this is worth a test.
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    await refreshRepo(qc, REPO);

    const predicate = spy.mock.calls[0][0]?.predicate;
    expect(predicate).toBeTypeOf("function");
    const matches = (queryKey: unknown[]) => predicate!({ queryKey } as never);
    expect(matches(["status", REPO])).toBe(true);
    expect(matches(["status", OTHER])).toBe(false);
    expect(matches(["status", { path: REPO }])).toBe(false);
    // The graph is excluded from the sweep and invalidated by key instead —
    // see the digest tests below.
    expect(matches(["graph", REPO, { skip: 0 }])).toBe(false);
    expect(spy.mock.calls.some((call) => call[0]?.queryKey?.[0] === "graph")).toBe(true);
  });

  it("still invalidates the graph the first time it hears about a repository", async () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    await refreshRepo(qc, REPO);
    expect(spy.mock.calls.map((call) => call[0]?.queryKey)).toContainEqual(["graph", REPO]);
  });

  it("skips the graph refetch when no ref has moved", async () => {
    // The expensive one: the graph is an infinite query, so invalidating it
    // refetches *every* loaded page. An unchanged `refs_digest` means those
    // pages would come back byte-identical (invariant 4), so the refetch is
    // work with no result — which is what a stage or an editor save produces.
    const qc = new QueryClient();
    qc.setQueryData(["graph", REPO], { pages: [], pageParams: [] });
    mockGraphKey.mockResolvedValue("same");
    await refreshRepo(qc, REPO);

    const spy = vi.spyOn(qc, "invalidateQueries");
    await refreshRepo(qc, REPO);
    expect(spy.mock.calls.map((call) => call[0]?.queryKey)).not.toContainEqual(["graph", REPO]);
  });

  it("refetches the graph as soon as the ref set moves", async () => {
    const qc = new QueryClient();
    qc.setQueryData(["graph", REPO], { pages: [], pageParams: [] });
    mockGraphKey.mockResolvedValue("before");
    await refreshRepo(qc, REPO);

    const spy = vi.spyOn(qc, "invalidateQueries");
    mockGraphKey.mockResolvedValue("after");
    await refreshRepo(qc, REPO);
    expect(spy.mock.calls.map((call) => call[0]?.queryKey)).toContainEqual(["graph", REPO]);
  });

  it("refetches the graph when the digest cannot be read", async () => {
    // Same rule as the paused-operation gate: a check that has lost its
    // footing must not become a wall. Here the failure mode it would cause is
    // a permanently stale graph.
    const qc = new QueryClient();
    qc.setQueryData(["graph", REPO], { pages: [], pageParams: [] });
    mockGraphKey.mockResolvedValue("same");
    await refreshRepo(qc, REPO);

    const spy = vi.spyOn(qc, "invalidateQueries");
    mockGraphKey.mockRejectedValue(new Error("repository is locked"));
    await refreshRepo(qc, REPO);
    expect(spy.mock.calls.map((call) => call[0]?.queryKey)).toContainEqual(["graph", REPO]);

    // And the failure must not be remembered as an answer: the next refresh
    // reporting the same digest still refetches, because nothing established
    // that the query is holding rows for it.
    spy.mockClear();
    mockGraphKey.mockResolvedValue("same");
    await refreshRepo(qc, REPO);
    expect(spy.mock.calls.map((call) => call[0]?.queryKey)).toContainEqual(["graph", REPO]);
  });

  it("refetches the graph when the query is not holding data, whatever the digest says", async () => {
    // Covers a failed refetch and a garbage-collected query: the digest is
    // unchanged, but there are no rows to keep.
    const qc = new QueryClient();
    qc.setQueryData(["graph", REPO], { pages: [], pageParams: [] });
    mockGraphKey.mockResolvedValue("same");
    await refreshRepo(qc, REPO);

    qc.removeQueries({ queryKey: ["graph", REPO] });
    const spy = vi.spyOn(qc, "invalidateQueries");
    await refreshRepo(qc, REPO);
    expect(spy.mock.calls.map((call) => call[0]?.queryKey)).toContainEqual(["graph", REPO]);
  });

  it("re-reads the operation as well, welded to the invalidation", async () => {
    // The two halves cannot be separated: invalidation alone was the six
    // hand-copied `refresh()` bodies that left a conflicting pull unbannered.
    mockOperationInfo.mockResolvedValue(info());
    await refreshRepo(new QueryClient(), REPO);
    expect(mockOperationInfo).toHaveBeenCalledWith(REPO);
    expect(useConflict.getState().active?.kind).toBe("merge");
  });

  it("resolves only once the operation has been re-read", async () => {
    // A caller that closes a dialog on completion awaits this so the banner is
    // up before the view changes underneath it.
    let release: (v: OperationInfo) => void = () => {};
    mockOperationInfo.mockReturnValue(new Promise((resolve) => (release = resolve)));
    let settled = false;
    const pending = refreshRepo(new QueryClient(), REPO).then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    release(info());
    await pending;
    expect(useConflict.getState().active).not.toBeNull();
  });
});
