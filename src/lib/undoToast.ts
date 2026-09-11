import type { QueryClient } from "@tanstack/react-query";
import { historyStatus, undo } from "../ipc/commands";
import { refreshRepo } from "../ipc/repoState";
import { toastError, useToasts } from "../stores/toasts";

/**
 * Report a mutation, with Undo on the toast itself (§3.3).
 *
 * The undo journal landed in P3 and the toolbar button has always worked; what
 * was missing is that the moment you want it is the moment you read the toast,
 * and by the time you have found the toolbar the toast is gone. This is the
 * half that makes the journal feel like a safety net.
 *
 * **Undo is offered only when the journal actually grew.** `capture` is read
 * before the operation and compared after: an unchanged label means git
 * recorded nothing (the operation was a no-op, or it is not undoable at all),
 * and a toast offering to undo something that never happened would undo the
 * *previous* operation instead. Two identical operations in a row therefore
 * lose the offer — a false negative, which is the side to err on.
 */
export async function captureUndoPoint(path: string): Promise<string | null> {
  return historyStatus(path)
    .then((status) => status.undoLabel)
    .catch(() => null);
}

export async function toastWithUndo(
  qc: QueryClient,
  path: string,
  message: string,
  capture: string | null,
): Promise<void> {
  const push = useToasts.getState().push;
  const label = await captureUndoPoint(path);
  if (!label || label === capture) {
    push("success", message);
    return;
  }
  push("success", message, {
    label: "Undo",
    run: async () => {
      try {
        await undo(path);
        await refreshRepo(qc, path);
        push("info", `Undid ${label}.`);
      } catch (error) {
        toastError(error);
      }
    },
  });
}
