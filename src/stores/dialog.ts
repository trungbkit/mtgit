import { create } from "zustand";

/**
 * A promise-based modal dialog system replacing the browser's `prompt()` /
 * `confirm()`. Call `promptDialog(...)` / `confirmDialog(...)` from anywhere and
 * `await` the result; `<DialogHost/>` (mounted once in the app) renders it.
 */

export interface PromptOptions {
  title: string;
  message?: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Return an error string to block submission, or null when valid. */
  validate?: (value: string) => string | null;
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
}

/**
 * The publish form (STATUS C1). A dialog *kind* rather than a component the
 * caller mounts, because it is raised from `features/network/net.ts` — a
 * plain module with no place in the tree — and the convention here is that
 * every modal is awaited from this store.
 */
export interface PublishOptions {
  branch: string;
  remotes: import("../ipc/types").RemoteInfo[];
  defaultRemote: string;
}

export interface PublishChoice {
  remote: string;
  remoteBranch: string;
  setUpstream: boolean;
}

export interface ChoiceOptions {
  title: string;
  message?: string;
  choices: { label: string; value: string; danger?: boolean }[];
  cancelLabel?: string;
}

interface PromptRequest extends PromptOptions {
  kind: "prompt";
  resolve: (value: string | null) => void;
}
interface ConfirmRequest extends ConfirmOptions {
  kind: "confirm";
  resolve: (value: boolean) => void;
}
interface ChoiceRequest extends ChoiceOptions {
  kind: "choice";
  resolve: (value: string | null) => void;
}
interface PublishRequest extends PublishOptions {
  kind: "publish";
  resolve: (value: PublishChoice | null) => void;
}
export type DialogRequest = PromptRequest | ConfirmRequest | ChoiceRequest | PublishRequest;

interface DialogState {
  current: DialogRequest | null;
  open: (req: DialogRequest) => void;
  close: () => void;
}

export const useDialog = create<DialogState>((set) => ({
  current: null,
  open: (req) => set({ current: req }),
  close: () => set({ current: null }),
}));

/** Ask for a line of text. Resolves to the entered value, or null if cancelled. */
export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    useDialog.getState().open({ ...opts, kind: "prompt", resolve });
  });
}

/** Ask for confirmation. Resolves true if confirmed, false if cancelled. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    useDialog.getState().open({ ...opts, kind: "confirm", resolve });
  });
}

export function choiceDialog(opts: ChoiceOptions): Promise<string | null> {
  return new Promise((resolve) => {
    useDialog.getState().open({ ...opts, kind: "choice", resolve });
  });
}

/** Raise the publish form. Resolves to the chosen target, or null if cancelled. */
export function publishDialog(opts: PublishOptions): Promise<PublishChoice | null> {
  return new Promise((resolve) => {
    useDialog.getState().open({ kind: "publish", ...opts, resolve });
  });
}
