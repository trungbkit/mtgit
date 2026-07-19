import { checkoutAdvanced } from "../ipc/commands";
import type { CheckoutResult } from "../ipc/types";
import { choiceDialog, confirmDialog } from "../stores/dialog";
import { useToasts } from "../stores/toasts";
import { useSession } from "../stores/session";

function finish(result: CheckoutResult): CheckoutResult {
  if (result.stashConflicts) {
    useToasts.getState().push("error", "Checkout succeeded, but restoring the automatic stash conflicted. The stash was kept.");
  }
  if (result.submodulesChanged) {
    useToasts.getState().push("info", "Submodules changed — update them from the Submodules section or terminal.");
  }
  return result;
}

/** Checkout with Git's normal carry-forward behavior and collision recovery. */
export async function smartCheckout(path: string, target: string): Promise<CheckoutResult> {
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
      throw new Error("Checkout cancelled.");
    }
    const looksLikeCollision =
      /local changes|would be overwritten|untracked working tree files|checkout conflict/i.test(text);
    if (!looksLikeCollision) throw error;
    const choice = await choiceDialog({
      title: `Cannot check out ${target}`,
      message: `${text}\n\nChoose how MTGit should handle the colliding changes.`,
      choices: [
        { label: "Stash changes and continue", value: "stash" },
        { label: "Discard changes", value: "discard", danger: true },
      ],
    });
    if (!choice) throw new Error("Checkout cancelled.");
    if (
      choice === "discard" &&
      !(await confirmDialog({
        title: "Discard local changes",
        message: `Discard all local changes that block checkout of ${target}? Untracked files are also removed.`,
        confirmLabel: "Discard and checkout",
        danger: true,
      }))
    ) {
      throw new Error("Checkout cancelled.");
    }
    return finish(await checkoutAdvanced(path, target, choice as "stash" | "discard"));
  }
}
