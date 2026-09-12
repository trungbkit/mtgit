import { checkoutAdvanced, openRepo, worktreeHolding } from "../ipc/commands";
import { requireNoPausedOperation } from "../ipc/repoState";
import type { CheckoutResult } from "../ipc/types";
import { choiceDialog, confirmDialog } from "../stores/dialog";
import { useToasts } from "../stores/toasts";
import { useSession } from "../stores/session";

/**
 * "Nothing was checked out here."
 *
 * Every abandoned path in this module throws the same object rather than a
 * fresh `Error` per site, so a caller can tell "the user backed out" from "git
 * failed" — and so switching to another worktree, which *did* something but
 * not here, can bow out without the caller announcing a checkout that never
 * happened.
 */
export const CANCELLED = new Error("Checkout cancelled.");

export function isCancelled(error: unknown): boolean {
  return error === CANCELLED;
}

function finish(result: CheckoutResult): CheckoutResult {
  if (result.stashConflicts) {
    useToasts.getState().push("error", "Checkout succeeded, but restoring the automatic stash conflicted. The stash was kept.");
  }
  if (result.submodulesChanged) {
    useToasts.getState().push("info", "Submodules changed — update them from the Submodules section or terminal.");
  }
  return result;
}

/**
 * Does this git failure mean "the working tree is in the way"?
 *
 * Invariant 8 leaves us a plain string, so the classification is textual. It
 * is shared with the cherry-pick fallback (`07-cherry-pick.md` B4) rather than
 * copied: checkout and cherry-pick are refused by the same code inside git and
 * print the same sentences, and two regexes that drift apart would offer the
 * stash on one gesture and not the other.
 */
export function looksLikeDirtyTreeCollision(text: string): boolean {
  return /local changes|would be overwritten|untracked working tree files|checkout conflict/i.test(
    text,
  );
}

/** Checkout with Git's normal carry-forward behavior and collision recovery. */
export async function smartCheckout(path: string, target: string): Promise<CheckoutResult> {
  // Every checkout in the app comes through here — sidebar, graph rows, ref
  // pills, toolbar, palette and the drop flows — which makes this the one place
  // §5.3's refusal has to live for checkout. It must sit *outside* the try in
  // `smartCheckoutInner`, whose catch matches error text for collision recovery
  // and would otherwise read a refusal as something to recover from.
  await requireNoPausedOperation(path, `check out ${target}`);
  // One checkout at a time (`02-checkout.md` §3). The toolbar greys its
  // mutating buttons while `checkoutTarget` is set, but a context menu or a
  // double-clicked ref pill can still fire during the window — and two
  // checkouts racing over one index is the failure that gating exists to
  // prevent, not the greyed button.
  const inFlight = useSession.getState().checkoutTarget;
  if (inFlight) {
    throw new Error(`Already checking out ${inFlight}.`);
  }
  useSession.getState().setCheckoutTarget(target);
  try {
    return await smartCheckoutInner(path, target);
  } finally {
    useSession.getState().setCheckoutTarget(null);
  }
}

async function smartCheckoutInner(path: string, target: string): Promise<CheckoutResult> {
  try {
    return finish(await checkoutAdvanced(path, target, "normal"));
  } catch (error) {
    const text = String(error);
    // `02-checkout.md` §7: git refuses with "already checked out at <path>",
    // which names a directory and offers nothing. The useful reply is the
    // worktree's own name and a way to go there — the tab strip P1 built is
    // what makes switching cheap enough to be the default answer.
    if (/already (?:checked out|used by (?:worktree|another worktree))/i.test(text)) {
      const holder = await worktreeHolding(path, target).catch(() => null);
      const choice = await choiceDialog({
        title: `${target} is checked out elsewhere`,
        message: holder
          ? `The worktree "${holder.name}" has ${target} checked out, at ${holder.path}. A branch can only be checked out in one worktree at a time.`
          : `${target} is checked out in another worktree. A branch can only be checked out in one worktree at a time.`,
        choices: holder
          ? [
              { label: `Open the "${holder.name}" worktree`, value: "open" },
              { label: "Check out this commit instead (detached)", value: "detach" },
            ]
          : [{ label: "Check out this commit instead (detached)", value: "detach" }],
      });
      if (choice === "open" && holder) {
        const opened = await openRepo(holder.path);
        useSession.getState().setRepo(opened);
        useToasts.getState().push("success", `Switched to the "${holder.name}" worktree.`);
        // Reported here rather than by the caller, because the caller's
        // message ("Checked out <target>") would be about this repository and
        // the checkout happened in a different one. `CANCELLED` is what every
        // "nothing happened here" path in this module throws, and callers
        // already funnel it into a single toast — see `isCancelled`.
        throw CANCELLED;
      }
      if (choice === "detach") {
        // The commit, not the branch: this is the request git can satisfy.
        return finish(await checkoutAdvanced(path, `${target}^{commit}`, "normal"));
      }
      throw CANCELLED;
    }
    const remoteConflict = text.match(/REMOTE_NAME_CONFLICT\|([^|]+)\|([^|]+)\|([^\s]*)/);
    if (remoteConflict) {
      const [, local, remote, upstream] = remoteConflict;
      const choice = await choiceDialog({
        title: `Local branch ${local} already exists`,
        message: upstream
          ? `${local} tracks ${upstream}, not ${remote}.`
          : `${local} does not track ${remote}.`,
        choices: [
          { label: `Check out existing ${local}`, value: "existing" },
          { label: `Create ${local}-1 tracking ${remote}`, value: "new" },
        ],
      });
      if (choice === "existing") return finish(await checkoutAdvanced(path, local));
      if (choice === "new") return finish(await checkoutAdvanced(path, remote, "normal", `${local}-1`));
      throw CANCELLED;
    }
    if (!looksLikeDirtyTreeCollision(text)) throw error;
    const choice = await choiceDialog({
      title: `Cannot check out ${target}`,
      message: `${text}\n\nChoose how MTGit should handle the colliding changes.`,
      choices: [
        { label: "Stash changes and continue", value: "stash" },
        { label: "Discard changes", value: "discard", danger: true },
      ],
    });
    if (!choice) throw CANCELLED;
    if (
      choice === "discard" &&
      !(await confirmDialog({
        title: "Discard local changes",
        message: `Discard all local changes that block checkout of ${target}? Untracked files are also removed.`,
        confirmLabel: "Discard and checkout",
        danger: true,
      }))
    ) {
      throw CANCELLED;
    }
    return finish(await checkoutAdvanced(path, target, choice as "stash" | "discard"));
  }
}
