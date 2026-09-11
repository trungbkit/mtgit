import { beforeEach, describe, expect, it, vi } from "vitest";
import { historyStatus, undo } from "../ipc/commands";
import { refreshRepo } from "../ipc/repoState";
import { useToasts } from "../stores/toasts";
import { resetStores } from "../test/stores";
import { captureUndoPoint, toastWithUndo } from "./undoToast";

vi.mock("../ipc/commands", () => ({ historyStatus: vi.fn(), undo: vi.fn() }));
vi.mock("../ipc/repoState", () => ({ refreshRepo: vi.fn() }));

const mockStatus = vi.mocked(historyStatus);
const mockUndo = vi.mocked(undo);
const mockRefresh = vi.mocked(refreshRepo);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const qc = {} as any;
const toasts = () => useToasts.getState().toasts;
const lastToast = () => toasts()[toasts().length - 1];

const status = (undoLabel: string | null) => ({
  undoLabel,
  redoLabel: null,
  restoredMessage: null,
});

beforeEach(() => {
  resetStores();
  mockStatus.mockReset();
  mockUndo.mockReset().mockResolvedValue(undefined as never);
  mockRefresh.mockReset().mockResolvedValue(undefined as never);
});

describe("toastWithUndo", () => {
  it("offers Undo when the journal grew", async () => {
    mockStatus.mockResolvedValue(status("Checkout main"));
    await toastWithUndo(qc, "/repo", "Checked out main.", null);
    expect(lastToast()).toMatchObject({ kind: "success", message: "Checked out main." });
    expect(lastToast().action?.label).toBe("Undo");
  });

  /**
   * The reason `capture` exists: an unchanged label means this operation
   * recorded nothing, and an Undo button would reverse the *previous* one.
   */
  it("offers no Undo when the journal did not move", async () => {
    mockStatus.mockResolvedValue(status("Checkout main"));
    await toastWithUndo(qc, "/repo", "Copied.", "Checkout main");
    expect(lastToast().action).toBeUndefined();
  });

  it("offers no Undo for an operation the journal never records", async () => {
    mockStatus.mockResolvedValue(status(null));
    await toastWithUndo(qc, "/repo", "Fetched.", null);
    expect(lastToast().action).toBeUndefined();
  });

  it("undoes and refreshes when the action is run", async () => {
    mockStatus.mockResolvedValue(status("Reset to abc1234"));
    await toastWithUndo(qc, "/repo", "Reset (hard)", null);
    await lastToast().action!.run();
    expect(mockUndo).toHaveBeenCalledWith("/repo");
    expect(mockRefresh).toHaveBeenCalledWith(qc, "/repo");
    expect(lastToast()).toMatchObject({ kind: "info" });
    expect(lastToast().message).toContain("Reset to abc1234");
  });

  it("reports a failed undo instead of leaving it silent", async () => {
    mockStatus.mockResolvedValue(status("Merge side"));
    mockUndo.mockRejectedValue(new Error("ref moved since"));
    await toastWithUndo(qc, "/repo", "Merged.", null);
    await lastToast().action!.run();
    expect(lastToast()).toMatchObject({ kind: "error", message: "ref moved since" });
  });

  /** A toast carrying an action must not expire before it can be used. */
  it("keeps a toast with an action on screen", async () => {
    vi.useFakeTimers();
    mockStatus.mockResolvedValue(status("Checkout main"));
    await toastWithUndo(qc, "/repo", "Checked out main.", null);
    vi.advanceTimersByTime(30_000);
    expect(toasts()).toHaveLength(1);
    vi.useRealTimers();
  });

  it("captures null rather than throwing when the journal cannot be read", async () => {
    mockStatus.mockRejectedValue(new Error("no repository"));
    await expect(captureUndoPoint("/repo")).resolves.toBeNull();
  });
});
