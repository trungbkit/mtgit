import { gitNetwork, listRemotes, pushTarget } from "../../ipc/commands";
import { requireNoPausedOperation } from "../../ipc/repoState";
import type { RepoInfo } from "../../ipc/types";
import { confirmDialog, publishDialog } from "../../stores/dialog";
import { openTerminal } from "../../stores/session";
import { toastError, useToasts } from "../../stores/toasts";

export type NetOp = "fetch" | "pull" | "push";

/**
 * The failures that deserve more than a quoted last line of git output.
 *
 * Classified from the text because that is all a shelled-out `git` gives us
 * (invariant 6) — there is no structured error to read. Each of these has a
 * *next step* the user cannot guess from git's advice:
 *
 * - `auth` — git cannot prompt (we run it non-interactively), so the failure
 *   reads as a bare "Authentication failed" with no way forward. The terminal
 *   panel is the way forward, because that is where a credential helper or an
 *   ssh passphrase prompt can actually run.
 * - `lease` — `--force-with-lease` refused because the remote moved. Fetching
 *   and retrying is almost always right, and `--force` almost never is.
 * - `nonFastForward` — an ordinary push rejected; pull first.
 * - `autostash` — `git pull --autostash` restored its stash into conflicts.
 *   The stash is still there, and saying so is the whole point: the failure is
 *   otherwise buried in output nobody reads (`04-pull.md` B3).
 */
export type NetFailure = "auth" | "lease" | "nonFastForward" | "autostash" | null;

export function classifyFailure(output: string): NetFailure {
  const text = output.toLowerCase();
  // Order matters: an autostash conflict and a lease rejection both mention
  // "conflict"-ish words, and a lease rejection also says "rejected".
  if (
    text.includes("applying autostash resulted in conflicts") ||
    text.includes("could not restore untracked files from stash")
  ) {
    return "autostash";
  }
  if (
    text.includes("authentication failed") ||
    text.includes("could not read username") ||
    text.includes("could not read password") ||
    text.includes("permission denied (publickey)") ||
    text.includes("terminal prompts disabled") ||
    text.includes("invalid username or token")
  ) {
    return "auth";
  }
  if (text.includes("stale info") || text.includes("stale-info")) return "lease";
  if (
    text.includes("non-fast-forward") ||
    text.includes("fetch first") ||
    text.includes("updates were rejected because the remote contains work")
  ) {
    return "nonFastForward";
  }
  return null;
}

/**
 * "A push landed on these refs" — the graph flashes the matching remote pills
 * (`03-push.md` §7, STATUS §4).
 *
 * An event rather than a store field: the pill animation is a moment, not
 * state, and nothing needs to be able to ask later whether a push happened.
 * The payload is the *local* branch name; the graph matches both the remote
 * pill (`origin/main`) and the local pill that absorbed it.
 */
export const PUSH_FLASH_EVENT = "mtgit:pushed";

export function announcePush(branch: string | null | undefined): void {
  if (!branch) return;
  window.dispatchEvent(new CustomEvent(PUSH_FLASH_EVENT, { detail: branch }));
}

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
    // Only pull. Fetch touches no ref the paused operation cares about, and a
    // push of the pre-operation tip is still a legal thing to want — §5.3 names
    // pull because it is the one that merges into a conflicted tree.
    if (op === "pull") await requireNoPausedOperation(repo.path, "pull");
    const res = await gitNetwork(repo.path, op, undefined, extra);
    if (res.success) {
      toast("success", successMessage ?? `${op} complete`);
      if (op === "push") announcePush(repo.head.branch);
      return true;
    }
    await reportFailure(repo, op, res.output);
    return false;
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

/**
 * Raise the publish form, then push what it chose (STATUS C1).
 *
 * The refspec is written out in full (`<local>:<remote>`) rather than relying
 * on the branch names matching, because the form lets them differ — which is
 * the point of having a form.
 */
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
  const remotes = await listRemotes(repo.path).catch(() => []);
  if (!remotes.length) {
    toast("error", "No remote configured — add one before pushing.");
    return false;
  }
  const choice = await publishDialog({
    branch: target.branch,
    remotes,
    defaultRemote: target.remote ?? remotes[0].name,
  });
  if (!choice) return false;

  const refspec =
    choice.remoteBranch === target.branch
      ? target.branch
      : `${target.branch}:${choice.remoteBranch}`;
  return runNet(
    repo,
    "push",
    [...(choice.setUpstream ? ["--set-upstream"] : []), choice.remote, refspec, ...(extra ?? [])],
    `Published ${target.branch} to ${choice.remote}/${choice.remoteBranch}`,
  );
}

/**
 * Turn a failed network op into something actionable.
 *
 * Deliberately *not* a retry loop: each recovery is offered, never performed
 * on the user's behalf. A push that force-pushes itself after a lease failure
 * is exactly the accident `--force-with-lease` exists to prevent.
 */
async function reportFailure(repo: RepoInfo, op: NetOp, output: string): Promise<void> {
  const toast = useToasts.getState().push;
  const lastLine = output.split("\n").filter((line) => line.trim()).pop() ?? "";

  switch (classifyFailure(output)) {
    case "auth": {
      const ok = await confirmDialog({
        title: "Authentication failed",
        message:
          `${repo.name} refused the credentials for this ${op}. MTGit runs git without a ` +
          "terminal, so a password, token or ssh passphrase prompt has nowhere to appear. " +
          "Open the terminal panel and run the command there once — the credential helper " +
          "will remember it.",
        confirmLabel: "Open terminal",
      });
      if (ok) openTerminal();
      return;
    }
    case "lease": {
      const ok = await confirmDialog({
        title: "The remote moved",
        message:
          "The push was refused because someone else has pushed since your last fetch, so " +
          "the lease no longer matches. Fetch to see their work, then decide — force-pushing " +
          "over it would discard it.",
        confirmLabel: "Fetch now",
      });
      if (ok) await runNet(repo, "fetch", ["--all", "--prune"], "Fetched");
      return;
    }
    case "nonFastForward": {
      const ok = await confirmDialog({
        title: "Push rejected",
        message:
          "The remote has commits you do not. Pull them first, then push again.",
        confirmLabel: "Pull now",
      });
      if (ok) await runNet(repo, "pull", undefined, "Pulled");
      return;
    }
    case "autostash":
      // The stash survives, which is the fact that decides what to do next.
      toast(
        "error",
        "Pull restored your stashed changes into conflicts. The stash was kept — resolve the " +
          "conflicts, or drop it from the Stashes section.",
      );
      return;
    default:
      toast("error", `${op} failed: ${lastLine}`);
  }
}
