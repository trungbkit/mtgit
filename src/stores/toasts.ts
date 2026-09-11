import { create } from "zustand";

export type ToastKind = "info" | "success" | "error";

/**
 * An action offered on the toast itself — in practice, Undo (§3.3).
 *
 * The undo journal has existed since P3, but reaching it meant finding the
 * toolbar button *after* the toast that told you what happened had gone. An
 * action on the toast is the half that makes the journal feel like a safety
 * net rather than a feature.
 */
export interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
}

interface ToastState {
  toasts: Toast[];
  push: (kind: ToastKind, message: string, action?: ToastAction) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, message, action) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message, action }] }));
    // Failures remain until dismissed so raw git errors are never lost. So does
    // anything carrying an action: a five-second Undo is an Undo that is only
    // there for people who were already looking.
    if (kind !== "error" && !action) {
      setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 5000);
    }
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/**
 * Report a failed command as an error toast.
 *
 * "Cancelled" is reported as *info*: the user abandoning a dialog is not a
 * failure, and a red toast for it teaches people to distrust red toasts.
 */
export function toastError(e: unknown) {
  const text = String(e).replace(/^Error:\s*/, "");
  useToasts.getState().push(/cancelled\.?$/i.test(text) ? "info" : "error", text);
}
