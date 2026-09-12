import type { QueryClient } from "@tanstack/react-query";
import { cherryPickMany } from "../ipc/commands";
import { refreshRepo, requireNoPausedOperation } from "../ipc/repoState";
import { confirmDialog } from "../stores/dialog";
import { toastError, useToasts } from "../stores/toasts";
import { settings } from "../stores/settings";
import { looksLikeDirtyTreeCollision } from "./checkout";

export interface CherryPickRequest {
  repoPath: string;
  oids: string[];
  /** Branch the commits land on — for the toast, which is about where. */
  branch: string;
  commitImmediately: boolean;
  mainline?: number;
  qc: QueryClient;
  /** Called with the picked oids on success, so the graph can flash them. */
  onPicked?: (oids: string[]) => void;
}

/**
 * Run a cherry-pick and report it, including the two recoveries the spec asks
 * for (`07-cherry-pick.md` B4 and §3).
 *
 * Shared between the confirm popover and the composite drop action rather than
 * written twice: the dirty-tree fallback has three outcomes with three
 * different right answers, and a second copy would inevitably get one of them
 * wrong.
 *
 * Returns true when the operation reached a reportable end — the caller closes
 * its popover then. False means the user backed out, or it failed outright and
 * the popover should stay up so they can change something.
 */
export async function runCherryPick(request: CherryPickRequest): Promise<boolean> {
  const { repoPath, oids, branch, commitImmediately, mainline, qc, onPicked } = request;
  const toast = useToasts.getState().push;
  const count = `${oids.length} commit${oids.length === 1 ? "" : "s"}`;
  try {
    await requireNoPausedOperation(repoPath, "cherry-pick");
    // B1: the `-x` trailer was plumbed all the way through and then hardcoded
    // `false` at the one call site until P6.
    const pick = (stashFallback: boolean) =>
      cherryPickMany(
        repoPath,
        oids,
        commitImmediately,
        mainline,
        settings().cherryPickAppendOrigin,
        stashFallback,
      );

    let result = await pick(false);
    // B4: `git cherry-pick` has no `--autostash`, so a tree it refuses to
    // overwrite is a dead end unless we offer the stash. Offered rather than
    // taken silently, exactly as checkout offers it — a stash the user did not
    // ask for is a surprise their next `git stash list` delivers.
    if (!result.success && !result.conflicts.length && looksLikeDirtyTreeCollision(result.output)) {
      const stash = await confirmDialog({
        title: "Uncommitted changes are in the way",
        message: `${result.output}\n\nMTGit can stash them, cherry-pick, and put them back.`,
        confirmLabel: "Stash and cherry-pick",
      });
      if (!stash) return false;
      result = await pick(true);
    }

    if (result.success) {
      toast(
        "success",
        commitImmediately
          ? `Cherry-picked ${count} onto ${branch}.`
          : `Applied ${count} to the index.`,
      );
      // The correspondence between what was picked and what appeared at the
      // tip (§3). Only on success: flashing the sources of a pick that did not
      // happen says the opposite of what it means.
      onPicked?.(oids);
    } else if (result.conflicts.length) {
      toast("error", `Cherry-pick paused — ${result.conflicts.length} conflicted file(s).`);
    } else {
      toast("error", result.output || "Cherry-pick failed.");
      return false;
    }

    if (result.stashKept) {
      // Leads with the fact that decides what happens next, as STATUS C7
      // established for the autostash toast.
      toast(
        "info",
        "Your stashed changes were kept — restore them with Pop once the cherry-pick is settled.",
      );
    }
    // Awaited before the caller unmounts anything: the banner has to be up
    // before a popover closes, or a paused sequence has no visible
    // Continue / Abort at all.
    await refreshRepo(qc, repoPath);
    return true;
  } catch (error) {
    toastError(error);
    return false;
  }
}
