import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStores } from "../../test/stores";
import { useToasts } from "../../stores/toasts";
import type { GitOpResult, PushTarget, RepoInfo } from "../../ipc/types";
import { gitNetwork, pushTarget } from "../../ipc/commands";
import { requireNoPausedOperation } from "../../ipc/repoState";
import { confirmDialog } from "../../stores/dialog";
import { push, runNet } from "./net";

vi.mock("../../ipc/commands", () => ({ gitNetwork: vi.fn(), pushTarget: vi.fn() }));
vi.mock("../../ipc/repoState", () => ({ requireNoPausedOperation: vi.fn() }));
// Only `confirmDialog` is replaced: the store itself is left real, because
// `resetStores` holds a reference to it.
vi.mock("../../stores/dialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../stores/dialog")>()),
  confirmDialog: vi.fn(),
}));

const mockGitNetwork = vi.mocked(gitNetwork);
const mockPushTarget = vi.mocked(pushTarget);
const mockRequire = vi.mocked(requireNoPausedOperation);
const mockConfirm = vi.mocked(confirmDialog);

const repo = { path: "/repo", name: "repo" } as RepoInfo;

function result(over: Partial<GitOpResult> = {}): GitOpResult {
  return { success: true, code: 0, output: "", ...over };
}

function target(over: Partial<PushTarget> = {}): PushTarget {
  return { branch: "feature", remote: "origin", hasUpstream: true, ...over };
}

const toasts = () => useToasts.getState().toasts;
const lastToast = () => toasts()[toasts().length - 1];

beforeEach(() => {
  resetStores();
  vi.mocked(mockGitNetwork).mockReset();
  vi.mocked(mockPushTarget).mockReset();
  mockRequire.mockReset().mockResolvedValue(undefined);
  mockConfirm.mockReset().mockResolvedValue(true);
});

/**
 * `CLAUDE.md` invariant 8: `gitNetwork` *resolves* with a `GitOpResult` even
 * when git exits non-zero, so a caller that merely awaits it reports success on
 * failure. `runNet` is the single place that check lives — and the palette
 * toasting "push complete" over a rejected push is the bug it was extracted for.
 */
describe("runNet", () => {
  it("reports a zero exit as success", async () => {
    mockGitNetwork.mockResolvedValue(result());
    await expect(runNet(repo, "fetch")).resolves.toBe(true);
    expect(lastToast()).toMatchObject({ kind: "success", message: "fetch complete" });
  });

  it("reports a non-zero exit as failure, quoting git's last line", async () => {
    mockGitNetwork.mockResolvedValue(
      result({ success: false, code: 1, output: "hint: updates were rejected\n! [rejected] main" }),
    );
    await expect(runNet(repo, "push")).resolves.toBe(false);
    expect(lastToast()).toMatchObject({ kind: "error" });
    expect(lastToast().message).toContain("! [rejected] main");
  });

  it("uses the caller's success message when given one", async () => {
    mockGitNetwork.mockResolvedValue(result());
    await runNet(repo, "pull", ["--rebase"], "Pulled with rebase");
    expect(lastToast().message).toBe("Pulled with rebase");
    expect(mockGitNetwork).toHaveBeenCalledWith("/repo", "pull", undefined, ["--rebase"]);
  });

  it("gates pull on the paused-operation check, and nothing else", async () => {
    mockGitNetwork.mockResolvedValue(result());
    await runNet(repo, "pull");
    expect(mockRequire).toHaveBeenCalledWith("/repo", "pull");

    mockRequire.mockClear();
    await runNet(repo, "fetch");
    await runNet(repo, "push");
    // Fetch touches no ref the paused operation cares about, and pushing the
    // pre-operation tip is still a legal thing to want.
    expect(mockRequire).not.toHaveBeenCalled();
  });

  it("stops a pull that the gate refuses, and reports the refusal once", async () => {
    mockRequire.mockRejectedValue(new Error("Cannot pull while a merge is in progress"));
    await expect(runNet(repo, "pull")).resolves.toBe(false);
    expect(mockGitNetwork).not.toHaveBeenCalled();
    expect(toasts()).toHaveLength(1);
    expect(lastToast()).toMatchObject({ kind: "error" });
    expect(lastToast().message).toBe("Cannot pull while a merge is in progress");
  });

  it("turns a rejected promise into an error toast rather than an unhandled rejection", async () => {
    mockGitNetwork.mockRejectedValue(new Error("git not found"));
    await expect(runNet(repo, "fetch")).resolves.toBe(false);
    expect(lastToast()).toMatchObject({ kind: "error", message: "git not found" });
  });
});

/** D5: a branch with no upstream gets an offer to publish, not git's raw advice. */
describe("push", () => {
  it("pushes straight through when an upstream is configured", async () => {
    mockPushTarget.mockResolvedValue(target());
    mockGitNetwork.mockResolvedValue(result());
    await expect(push(repo)).resolves.toBe(true);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockGitNetwork).toHaveBeenCalledWith("/repo", "push", undefined, undefined);
  });

  it("offers to publish an unpublished branch, then sets upstream", async () => {
    mockPushTarget.mockResolvedValue(target({ hasUpstream: false }));
    mockGitNetwork.mockResolvedValue(result());
    await expect(push(repo)).resolves.toBe(true);
    expect(mockConfirm).toHaveBeenCalledOnce();
    expect(mockGitNetwork).toHaveBeenCalledWith("/repo", "push", undefined, [
      "--set-upstream",
      "origin",
      "feature",
    ]);
  });

  it("does nothing when the publish offer is declined", async () => {
    mockPushTarget.mockResolvedValue(target({ hasUpstream: false }));
    mockConfirm.mockResolvedValue(false);
    await expect(push(repo)).resolves.toBe(false);
    expect(mockGitNetwork).not.toHaveBeenCalled();
  });

  it("names the resolved remote, which is not always origin", async () => {
    mockPushTarget.mockResolvedValue(target({ hasUpstream: false, remote: "upstream" }));
    mockGitNetwork.mockResolvedValue(result());
    await push(repo);
    expect(mockConfirm.mock.calls[0][0].message).toContain("upstream");
    expect(mockGitNetwork).toHaveBeenCalledWith("/repo", "push", undefined, [
      "--set-upstream",
      "upstream",
      "feature",
    ]);
  });

  it("trusts git's verdict over a stale pre-flight read", async () => {
    // The upstream may have been dropped in the terminal panel since the last
    // refresh, in which case our first read said "has upstream" and git says
    // otherwise.
    mockPushTarget
      .mockResolvedValueOnce(target({ hasUpstream: true }))
      .mockResolvedValueOnce(target({ hasUpstream: false }));
    mockGitNetwork
      .mockResolvedValueOnce(result({ success: false, code: 1, output: "no upstream" }))
      .mockResolvedValueOnce(result());

    await expect(push(repo)).resolves.toBe(true);
    expect(mockGitNetwork).toHaveBeenLastCalledWith("/repo", "push", undefined, [
      "--set-upstream",
      "origin",
      "feature",
    ]);
  });

  it("does not retry a push that already carried --set-upstream", async () => {
    mockPushTarget.mockResolvedValue(target());
    mockGitNetwork.mockResolvedValue(result({ success: false, code: 1, output: "rejected" }));
    await expect(push(repo, ["--set-upstream", "origin", "feature"])).resolves.toBe(false);
    expect(mockGitNetwork).toHaveBeenCalledOnce();
  });

  it("explains a detached HEAD instead of publishing a branch that does not exist", async () => {
    mockPushTarget.mockResolvedValue(target({ branch: null, hasUpstream: false }));
    await expect(push(repo)).resolves.toBe(false);
    expect(lastToast().message).toMatch(/Detached HEAD/);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("explains a repository with no remote", async () => {
    mockPushTarget.mockResolvedValue(target({ remote: null, hasUpstream: false }));
    await expect(push(repo)).resolves.toBe(false);
    expect(lastToast().message).toMatch(/No remote configured/);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("reports a failed target read rather than pushing blind", async () => {
    mockPushTarget.mockRejectedValue(new Error("not a repository"));
    await expect(push(repo)).resolves.toBe(false);
    expect(mockGitNetwork).not.toHaveBeenCalled();
    expect(lastToast()).toMatchObject({ kind: "error", message: "not a repository" });
  });
});
