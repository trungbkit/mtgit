import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStores } from "../../test/stores";
import { useToasts } from "../../stores/toasts";
import type { GitOpResult, PushTarget, RemoteInfo, RepoInfo } from "../../ipc/types";
import { gitNetwork, listRemotes, pushTarget } from "../../ipc/commands";
import { requireNoPausedOperation } from "../../ipc/repoState";
import { confirmDialog, publishDialog } from "../../stores/dialog";
import { useSession } from "../../stores/session";
import { classifyFailure, push, PUSH_FLASH_EVENT, runNet } from "./net";

vi.mock("../../ipc/commands", () => ({
  gitNetwork: vi.fn(),
  pushTarget: vi.fn(),
  listRemotes: vi.fn(),
}));
vi.mock("../../ipc/repoState", () => ({ requireNoPausedOperation: vi.fn() }));
// Only the dialog raisers are replaced: the store itself is left real, because
// `resetStores` holds a reference to it.
vi.mock("../../stores/dialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../stores/dialog")>()),
  confirmDialog: vi.fn(),
  publishDialog: vi.fn(),
}));

const mockGitNetwork = vi.mocked(gitNetwork);
const mockPushTarget = vi.mocked(pushTarget);
const mockListRemotes = vi.mocked(listRemotes);
const mockRequire = vi.mocked(requireNoPausedOperation);
const mockConfirm = vi.mocked(confirmDialog);
const mockPublish = vi.mocked(publishDialog);

// `head` is not optional on `RepoInfo`, and leaving it off made the fixture
// lie: `runNet` reads `repo.head.branch` to name the ref a push just moved.
const repo = {
  path: "/repo",
  name: "repo",
  head: { branch: "feature", oid: "a".repeat(40), detached: false, unborn: false },
  isBare: false,
  worktree: null,
} as RepoInfo;

function result(over: Partial<GitOpResult> = {}): GitOpResult {
  return { success: true, code: 0, output: "", ...over };
}

function target(over: Partial<PushTarget> = {}): PushTarget {
  return { branch: "feature", remote: "origin", hasUpstream: true, ...over };
}

function remote(name: string): RemoteInfo {
  return { name, url: `https://example.com/${name}.git`, pushUrl: null, branches: 1 };
}

const toasts = () => useToasts.getState().toasts;
const lastToast = () => toasts()[toasts().length - 1];

beforeEach(() => {
  resetStores();
  vi.mocked(mockGitNetwork).mockReset();
  vi.mocked(mockPushTarget).mockReset();
  mockListRemotes.mockReset().mockResolvedValue([remote("origin")]);
  mockRequire.mockReset().mockResolvedValue(undefined);
  mockConfirm.mockReset().mockResolvedValue(true);
  mockPublish
    .mockReset()
    .mockResolvedValue({ remote: "origin", remoteBranch: "feature", setUpstream: true });
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

  it("raises the publish form for an unpublished branch, then sets upstream", async () => {
    mockPushTarget.mockResolvedValue(target({ hasUpstream: false }));
    mockGitNetwork.mockResolvedValue(result());
    await expect(push(repo)).resolves.toBe(true);
    expect(mockPublish).toHaveBeenCalledOnce();
    expect(mockGitNetwork).toHaveBeenCalledWith("/repo", "push", undefined, [
      "--set-upstream",
      "origin",
      "feature",
    ]);
  });

  /**
   * STATUS §4's remote-pill animation. The graph cannot watch for this itself:
   * a push moves a ref the graph query only learns about on the next refresh,
   * by which time the pill has already redrawn in its new place.
   */
  it("announces the branch a successful push moved, and only then", async () => {
    const seen: string[] = [];
    const listener = (event: Event) => seen.push((event as CustomEvent<string>).detail);
    window.addEventListener(PUSH_FLASH_EVENT, listener);

    mockPushTarget.mockResolvedValue(target());
    mockGitNetwork.mockResolvedValue(result({ success: false, output: "boom" }));
    await push(repo);
    expect(seen).toEqual([]);

    mockGitNetwork.mockResolvedValue(result());
    await push(repo);
    expect(seen).toEqual(["feature"]);

    window.removeEventListener(PUSH_FLASH_EVENT, listener);
  });

  it("does nothing when the publish form is cancelled", async () => {
    mockPushTarget.mockResolvedValue(target({ hasUpstream: false }));
    mockPublish.mockResolvedValue(null);
    await expect(push(repo)).resolves.toBe(false);
    expect(mockGitNetwork).not.toHaveBeenCalled();
  });

  /** STATUS C1: the form's whole reason to exist is that these can differ. */
  it("writes a full refspec when the remote branch name was changed", async () => {
    mockPushTarget.mockResolvedValue(target({ hasUpstream: false }));
    mockPublish.mockResolvedValue({ remote: "fork", remoteBranch: "pr/feature", setUpstream: true });
    mockListRemotes.mockResolvedValue([remote("origin"), remote("fork")]);
    mockGitNetwork.mockResolvedValue(result());

    await expect(push(repo)).resolves.toBe(true);
    expect(mockGitNetwork).toHaveBeenCalledWith("/repo", "push", undefined, [
      "--set-upstream",
      "fork",
      "feature:pr/feature",
    ]);
  });

  it("omits --set-upstream when the form says not to track", async () => {
    mockPushTarget.mockResolvedValue(target({ hasUpstream: false }));
    mockPublish.mockResolvedValue({ remote: "origin", remoteBranch: "feature", setUpstream: false });
    mockGitNetwork.mockResolvedValue(result());
    await push(repo);
    expect(mockGitNetwork).toHaveBeenCalledWith("/repo", "push", undefined, ["origin", "feature"]);
  });

  it("offers the resolved remote as the default, which is not always origin", async () => {
    mockPushTarget.mockResolvedValue(target({ hasUpstream: false, remote: "upstream" }));
    mockListRemotes.mockResolvedValue([remote("origin"), remote("upstream")]);
    mockGitNetwork.mockResolvedValue(result());
    await push(repo);
    expect(mockPublish.mock.calls[0][0].defaultRemote).toBe("upstream");
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
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("explains a repository with no remote", async () => {
    mockPushTarget.mockResolvedValue(target({ remote: null, hasUpstream: false }));
    mockListRemotes.mockResolvedValue([]);
    await expect(push(repo)).resolves.toBe(false);
    expect(lastToast().message).toMatch(/No remote configured/);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("reports a failed target read rather than pushing blind", async () => {
    mockPushTarget.mockRejectedValue(new Error("not a repository"));
    await expect(push(repo)).resolves.toBe(false);
    expect(mockGitNetwork).not.toHaveBeenCalled();
    expect(lastToast()).toMatchObject({ kind: "error", message: "not a repository" });
  });
});

/**
 * STATUS C2, C3 and C7. Each of these used to surface as git's last line of
 * output, which names the problem and not the way out.
 */
describe("classifyFailure", () => {
  it("recognises a credential failure", () => {
    expect(classifyFailure("fatal: Authentication failed for 'https://host/r.git/'")).toBe("auth");
    expect(classifyFailure("git@host: Permission denied (publickey).")).toBe("auth");
    expect(classifyFailure("could not read Username for 'https://host': terminal prompts disabled")).toBe(
      "auth",
    );
  });

  it("recognises a stale lease, and does not confuse it with a plain rejection", () => {
    expect(
      classifyFailure("! [rejected] main -> main (stale info)\nerror: failed to push some refs"),
    ).toBe("lease");
    expect(
      classifyFailure("! [rejected] main -> main (non-fast-forward)\nhint: fetch first"),
    ).toBe("nonFastForward");
  });

  it("recognises an autostash that landed in conflicts", () => {
    expect(classifyFailure("Applying autostash resulted in conflicts.")).toBe("autostash");
  });

  it("returns null for a failure with no special recovery", () => {
    expect(classifyFailure("fatal: not a git repository")).toBeNull();
    expect(classifyFailure("")).toBeNull();
  });
});

describe("failure recovery", () => {
  it("offers the terminal for an auth failure, and opens it on yes", async () => {
    mockGitNetwork.mockResolvedValue(
      result({ success: false, code: 128, output: "fatal: Authentication failed" }),
    );
    await expect(runNet(repo, "push")).resolves.toBe(false);
    expect(mockConfirm.mock.calls[0][0].confirmLabel).toBe("Open terminal");
    expect(useSession.getState().terminalOpen).toBe(true);
  });

  it("leaves the terminal alone when the auth offer is declined", async () => {
    mockConfirm.mockResolvedValue(false);
    mockGitNetwork.mockResolvedValue(
      result({ success: false, code: 128, output: "fatal: Authentication failed" }),
    );
    await runNet(repo, "push");
    expect(useSession.getState().terminalOpen).toBe(false);
  });

  it("offers a fetch after a stale lease, and never force-pushes on its own", async () => {
    mockGitNetwork
      .mockResolvedValueOnce(result({ success: false, code: 1, output: "! [rejected] (stale info)" }))
      .mockResolvedValueOnce(result());
    await expect(runNet(repo, "push")).resolves.toBe(false);
    expect(mockGitNetwork).toHaveBeenLastCalledWith("/repo", "fetch", undefined, [
      "--all",
      "--prune",
    ]);
    expect(
      mockGitNetwork.mock.calls.some((call) => (call[3] ?? []).includes("--force")),
    ).toBe(false);
  });

  it("says the stash was kept when an autostash pull conflicts", async () => {
    mockGitNetwork.mockResolvedValue(
      result({ success: false, code: 1, output: "Applying autostash resulted in conflicts." }),
    );
    await runNet(repo, "pull");
    expect(lastToast()).toMatchObject({ kind: "error" });
    expect(lastToast().message).toMatch(/stash was kept/);
  });

  it("still quotes git for a failure it has no advice about", async () => {
    mockGitNetwork.mockResolvedValue(
      result({ success: false, code: 1, output: "hint: x\nfatal: not a git repository" }),
    );
    await runNet(repo, "fetch");
    expect(lastToast().message).toContain("fatal: not a git repository");
  });
});
