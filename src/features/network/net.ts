import { gitNetwork, pushTarget } from "../../ipc/commands";
import type { RepoInfo } from "../../ipc/types";
import { confirmDialog } from "../../stores/dialog";
import { toastError, useToasts } from "../../stores/toasts";

export type NetOp = "fetch" | "pull" | "push";

/**
 * Run a network op and report its outcome. `gitNetwork` resolves with a
 * `GitOpResult` even when git exits non-zero, so callers that only `await` it
 * report success on failure — this is the one place that check lives.
 *
 * Returns true when git exited zero.
 */
export async function runNet(
  repo: RepoInfo,
  op: NetOp,
  extra?: string[],
  successMessage?: string,
): Promise<boolean> {
  const toast = useToasts.getState().push;
  try {
    const res = await gitNetwork(repo.path, op, undefined, extra);
    if (res.success) {
      toast("success", successMessage ?? `${op} complete`);
    } else {
      toast("error", `${op} failed: ${res.output.split("\n").pop() ?? ""}`);
    }
    return res.success;
  } catch (e) {
    toastError(e);
    return false;
  }
}

/**
 * Push, publishing the branch when it has no upstream (D5).
 *
 * Without this, the first push on a new branch fails with git's raw "The
 * current branch X has no upstream branch" advice; GitKraken instead offers to
 * publish it. The remote is resolved by the backend — it is not always
 * called "origin".
 */
export async function push(repo: RepoInfo, extra?: string[]): Promise<boolean> {
  let target;
  try {
    target = await pushTarget(repo.path);
  } catch (e) {
    toastError(e);
    return false;
  }

  if (!target.hasUpstream) return publish(repo, target, extra);

  const ok = await runNet(repo, "push", extra);
  if (ok || extra?.includes("--set-upstream")) return ok;

  // Our pre-flight read can be stale (the upstream may have been dropped in
  // the terminal since the last refresh); trust git's own verdict too.
  const fresh = await pushTarget(repo.path).catch(() => null);
  if (fresh && !fresh.hasUpstream) return publish(repo, fresh, extra);
  return false;
}

/** Ask, then `push --set-upstream <remote> <branch>`. */
async function publish(
  repo: RepoInfo,
  target: { branch: string | null; remote: string | null },
  extra?: string[],
): Promise<boolean> {
  const toast = useToasts.getState().push;
  if (!target.branch) {
    toast("error", "Detached HEAD — check out a branch before pushing.");
    return false;
  }
  if (!target.remote) {
    toast("error", "No remote configured — add one before pushing.");
    return false;
  }
  const ok = await confirmDialog({
    title: "Publish branch",
    message: `'${target.branch}' has no upstream branch. Push it to ${target.remote} and track it?`,
    confirmLabel: `Push to ${target.remote}`,
  });
  if (!ok) return false;
  return runNet(repo, "push", ["--set-upstream", target.remote, target.branch, ...(extra ?? [])]);
}
