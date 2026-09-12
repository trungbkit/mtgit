import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import { resetStores } from "../test/stores";
import { useToasts } from "../stores/toasts";
import type { CommandResult } from "../ipc/types";
import { cherryPickMany } from "../ipc/commands";
import { refreshRepo, requireNoPausedOperation } from "../ipc/repoState";
import { confirmDialog } from "../stores/dialog";
import { runCherryPick } from "./cherryPick";

vi.mock("../ipc/commands", () => ({ cherryPickMany: vi.fn() }));
vi.mock("../ipc/repoState", () => ({
  refreshRepo: vi.fn(),
  requireNoPausedOperation: vi.fn(),
}));
vi.mock("../stores/dialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/dialog")>()),
  confirmDialog: vi.fn(),
}));

const mockPick = vi.mocked(cherryPickMany);
const mockConfirm = vi.mocked(confirmDialog);
const mockRefresh = vi.mocked(refreshRepo);
const mockRequire = vi.mocked(requireNoPausedOperation);

const qc = {} as QueryClient;

function outcome(over: Partial<CommandResult> = {}): CommandResult {
  return {
    success: true,
    code: 0,
    output: "",
    oid: "b".repeat(40),
    conflicts: [],
    skipped: 0,
    autoStashed: false,
    stashKept: false,
    ...over,
  };
}

function request(over: Partial<Parameters<typeof runCherryPick>[0]> = {}) {
  return {
    repoPath: "/repo",
    oids: ["a".repeat(40)],
    branch: "main",
    commitImmediately: true,
    qc,
    ...over,
  };
}

const messages = () => useToasts.getState().toasts.map((t) => t.message);

/** `output` git prints when uncommitted work is in the way. */
const COLLISION =
  "error: Your local changes to the following files would be overwritten by merge:\n\tfile.txt";

beforeEach(() => {
  resetStores();
  vi.clearAllMocks();
  mockRequire.mockResolvedValue(undefined);
  mockRefresh.mockResolvedValue(undefined);
});

describe("running a cherry-pick", () => {
  it("reports the pick and flashes the sources it came from", async () => {
    mockPick.mockResolvedValue(outcome());
    const onPicked = vi.fn();

    await expect(runCherryPick(request({ onPicked }))).resolves.toBe(true);
    expect(onPicked).toHaveBeenCalledWith(["a".repeat(40)]);
    expect(messages()[0]).toContain("Cherry-picked 1 commit onto main");
    expect(mockRefresh).toHaveBeenCalledOnce();
  });

  it("refuses to run while another operation is paused", async () => {
    mockRequire.mockRejectedValue(new Error("Finish the merge in progress first."));
    await expect(runCherryPick(request())).resolves.toBe(false);
    expect(mockPick).not.toHaveBeenCalled();
  });

  it("does not flash the sources of a pick that failed", async () => {
    // The flash means "these commits are now up there too". Showing it on a
    // failure says the opposite of what happened.
    mockPick.mockResolvedValue(outcome({ success: false, output: "boom" }));
    const onPicked = vi.fn();
    await expect(runCherryPick(request({ onPicked }))).resolves.toBe(false);
    expect(onPicked).not.toHaveBeenCalled();
  });

  it("does not flash the sources when the sequence merely paused", async () => {
    mockPick.mockResolvedValue(outcome({ success: false, conflicts: ["file.txt"] }));
    const onPicked = vi.fn();
    await runCherryPick(request({ onPicked }));
    expect(onPicked).not.toHaveBeenCalled();
    expect(messages()[0]).toContain("paused");
  });
});

describe("the dirty-tree fallback (07-cherry-pick.md B4)", () => {
  it("offers the stash, then retries with it", async () => {
    mockPick
      .mockResolvedValueOnce(outcome({ success: false, output: COLLISION }))
      .mockResolvedValueOnce(outcome({ autoStashed: true }));
    mockConfirm.mockResolvedValue(true);

    await expect(runCherryPick(request())).resolves.toBe(true);
    expect(mockPick).toHaveBeenNthCalledWith(1, "/repo", ["a".repeat(40)], true, undefined, false, false);
    expect(mockPick).toHaveBeenNthCalledWith(2, "/repo", ["a".repeat(40)], true, undefined, false, true);
  });

  it("does nothing more when the stash is declined", async () => {
    mockPick.mockResolvedValue(outcome({ success: false, output: COLLISION }));
    mockConfirm.mockResolvedValue(false);

    await expect(runCherryPick(request())).resolves.toBe(false);
    expect(mockPick).toHaveBeenCalledOnce();
    expect(messages()).toEqual([]);
  });

  it("never stashes for a failure that is not about the working tree", async () => {
    // A bad revision is not something a stash can fix, and stashing the user's
    // work to find that out would be a surprise with nothing to show for it.
    mockPick.mockResolvedValue(outcome({ success: false, output: "fatal: bad revision" }));
    await expect(runCherryPick(request())).resolves.toBe(false);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockPick).toHaveBeenCalledOnce();
  });

  it("says so when the stash was kept, because that decides what to do next", async () => {
    mockPick
      .mockResolvedValueOnce(outcome({ success: false, output: COLLISION }))
      .mockResolvedValueOnce(
        outcome({ success: false, conflicts: ["file.txt"], autoStashed: true, stashKept: true }),
      );
    mockConfirm.mockResolvedValue(true);

    await runCherryPick(request());
    expect(messages().some((m) => m.includes("kept"))).toBe(true);
  });
});
