import { useQueryClient } from "@tanstack/react-query";
import { abortOperation, rebaseAbort, rebaseContinue } from "../ipc/commands";
import { conflictLabel, useConflict } from "../stores/conflict";
import { useSession } from "../stores/session";
import { toastError, useToasts } from "../stores/toasts";
import "./conflictbanner.css";

/**
 * Persistent banner shown while a merge / rebase / cherry-pick / revert is
 * stuck on conflicts. Offers the escape hatches the backend now supports:
 * abort (all) and continue (rebase, once resolved).
 */
export function ConflictBanner() {
  const active = useConflict((s) => s.active);
  const clear = useConflict((s) => s.clear);
  const repoPathActive = useSession((s) => s.repo?.path);
  const toggleTerminal = useSession((s) => s.toggleTerminal);
  const terminalOpen = useSession((s) => s.terminalOpen);
  const pushToast = useToasts((s) => s.push);
  const qc = useQueryClient();

  // Only surface the banner for the repo currently in view.
  if (!active || active.repoPath !== repoPathActive) return null;
  const { repoPath, kind, files } = active;
  const refresh = () => qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === repoPath });

  async function run(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      pushToast("success", ok);
      clear();
      refresh();
    } catch (e) {
      toastError(e);
    }
  }

  async function onContinue() {
    try {
      const res = await rebaseContinue(repoPath);
      if (res.done) {
        pushToast("success", `Rebase complete (${res.applied} commit(s) applied).`);
        clear();
      } else {
        pushToast("error", `Still ${res.conflicts.length} conflicted file(s) — resolve, then continue.`);
        useConflict.getState().set({ repoPath, kind: "rebase", files: res.conflicts });
      }
      refresh();
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="conflict-banner">
      <span className="cb-icon">⚠</span>
      <span className="cb-text">
        <strong>{conflictLabel(kind)} paused —</strong> {files.length} conflicted file
        {files.length === 1 ? "" : "s"}. Resolve them, then continue or abort.
      </span>
      <span className="cb-files" title={files.join("\n")}>
        {files.slice(0, 3).join(", ")}
        {files.length > 3 ? `, +${files.length - 3} more` : ""}
      </span>
      <div className="cb-actions">
        {!terminalOpen && (
          <button className="cb-btn" onClick={toggleTerminal}>
            Open terminal
          </button>
        )}
        {kind === "rebase" && (
          <button className="cb-btn primary" onClick={onContinue}>
            Continue
          </button>
        )}
        <button
          className="cb-btn danger"
          onClick={() =>
            kind === "rebase"
              ? run(() => rebaseAbort(repoPath), "Rebase aborted.")
              : run(() => abortOperation(repoPath), `${conflictLabel(kind)} aborted.`)
          }
        >
          Abort
        </button>
        <button className="cb-btn cb-dismiss" title="Dismiss (I'll resolve manually)" onClick={clear}>
          ✕
        </button>
      </div>
    </div>
  );
}
