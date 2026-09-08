import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { operationAbort, operationContinue, operationSkip } from "../ipc/commands";
import { refreshRepo } from "../ipc/repoState";
import { REVEAL_BANNER_EVENT, conflictLabel, useConflict } from "../stores/conflict";
import { useSession, WORKING } from "../stores/session";
import { toastError, useToasts } from "../stores/toasts";
import "./conflictbanner.css";

/**
 * Persistent banner shown while a merge / rebase / cherry-pick / revert is
 * stuck on conflicts. Offers the escape hatches the backend now supports:
 * abort (all) and continue (rebase, once resolved).
 */
export function ConflictBanner() {
  const active = useConflict((s) => s.active);
  const repoPathActive = useSession((s) => s.repo?.path);
  const toggleTerminal = useSession((s) => s.toggleTerminal);
  const terminalOpen = useSession((s) => s.terminalOpen);
  const selectOid = useSession((s) => s.selectOid);
  const pushToast = useToasts((s) => s.push);
  const qc = useQueryClient();
  const bannerRef = useRef<HTMLDivElement>(null);
  const flashTimer = useRef<number | null>(null);
  const [flash, setFlash] = useState(false);

  // A refused operation points here (§5.3). The refusal already toasted; this
  // is the other half of "points at the banner" — without it the user is told
  // to look at something that never moved.
  useEffect(() => {
    const reveal = () => {
      bannerRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      setFlash(true);
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlash(false), 950);
    };
    window.addEventListener(REVEAL_BANNER_EVENT, reveal);
    return () => {
      window.removeEventListener(REVEAL_BANNER_EVENT, reveal);
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    };
  }, []);

  // Only surface the banner for the repo currently in view.
  if (!active || active.repoPath !== repoPathActive) return null;
  const { repoPath, kind, files, currentSha, current, total, canSkip } = active;
  // Clearing and re-setting the banner is `refreshRepo`'s job, not ours: the
  // backend owns both the conflict list and the `i of n` counter (it bumps its
  // sequence meta on continue/skip), so anything computed here would be a
  // second, drifting copy of state git already has (overview §5.1).
  const refresh = () => refreshRepo(qc, repoPath);

  async function run(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      pushToast("success", ok);
      await refresh();
    } catch (e) {
      toastError(e);
    }
  }

  async function onContinue(skip = false) {
    try {
      const res = await (skip ? operationSkip(repoPath) : operationContinue(repoPath));
      if (res.success) {
        pushToast("success", `${conflictLabel(kind)} ${skip ? "skipped the commit and continued" : "complete"}.`);
      } else {
        pushToast("error", `Still ${res.conflicts.length} conflicted file(s) — resolve, then continue.`);
      }
      await refresh();
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className={`conflict-banner${flash ? " flash" : ""}`} ref={bannerRef}>
      <span className="cb-icon">⚠</span>
      <span className="cb-text">
        <strong>{conflictLabel(kind)} in progress</strong>
        {currentSha ? ` — stopped at ${currentSha.slice(0, 7)}` : ""}
        {total ? ` (${current ?? 1} of ${total})` : ""} — {files.length} conflicted file
        {files.length === 1 ? "" : "s"}.
      </span>
      <button className="cb-files" title={files.join("\n")} onClick={() => selectOid(WORKING)}>
        {files.slice(0, 3).join(", ")}
        {files.length > 3 ? `, +${files.length - 3} more` : ""}
      </button>
      <div className="cb-actions">
        {!terminalOpen && (
          <button className="cb-btn" onClick={toggleTerminal}>
            Open terminal
          </button>
        )}
        {canSkip && (
          <button className="cb-btn" onClick={() => onContinue(true)}>
            Skip commit
          </button>
        )}
        <button className="cb-btn primary" disabled={files.length > 0} onClick={() => onContinue(false)}>
          Continue
        </button>
        <button
          className="cb-btn danger"
          onClick={() => run(() => operationAbort(repoPath), `${conflictLabel(kind)} aborted.`)}
        >
          Abort
        </button>
      </div>
    </div>
  );
}
