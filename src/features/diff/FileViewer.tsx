import { useEffect, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import type { FileDiff } from "../../ipc/types";
import { useSession } from "../../stores/session";
import { toastError } from "../../stores/toasts";
import { DiffView } from "./DiffView";
import { FileContentView } from "./FileContentView";
import { BlameView } from "./BlameView";
import { HistoryView } from "./HistoryView";
import "./fileviewer.css";

type SubMode = "diff" | "file" | "blame" | "history";

export function FileViewer({
  diff,
  repoPath,
  commitOid,
  headOid,
  isWorkingTree,
  onClose,
  onSelectCommit,
}: {
  diff: FileDiff;
  repoPath: string;
  /** Commit being viewed; null when viewing the working tree. */
  commitOid: string | null;
  headOid: string | null;
  isWorkingTree: boolean;
  onClose?: () => void;
  onSelectCommit?: (oid: string) => void;
}) {
  const mode = useSession((s) => s.diffMode);
  const setMode = useSession((s) => s.setDiffMode);
  const [sub, setSub] = useState<SubMode>("diff");

  // Reset to the diff tab whenever the selected file changes.
  useEffect(() => {
    setSub("diff");
  }, [diff.path]);

  const fileOid = commitOid ?? headOid;
  const dir = diff.path.includes("/") ? diff.path.slice(0, diff.path.lastIndexOf("/") + 1) : "";
  const name = diff.path.slice(dir.length);

  async function editInWorkdir() {
    try {
      await openPath(`${repoPath}/${diff.path}`);
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="fileviewer">
      <div className="fv-breadcrumb">
        <button
          className="fv-edit"
          onClick={editInWorkdir}
          disabled={!isWorkingTree && diff.status === "deleted"}
          title="Open file in the working directory"
        >
          ✎ Edit in Working Directory
        </button>
        <span className="fv-path">
          {dir}
          <b>{name}</b>
        </span>
        <span className="fv-encoding">UTF-8</span>
        {onClose && (
          <button className="fv-close" title="Close" onClick={onClose}>
            ✕
          </button>
        )}
      </div>

      <div className="fv-toolbar">
        <div className="fv-tabs">
          <button className={sub === "file" ? "on" : ""} onClick={() => setSub("file")} disabled={!fileOid}>
            File View
          </button>
          <button className={sub === "diff" ? "on" : ""} onClick={() => setSub("diff")}>
            Diff View
          </button>
        </div>
        <div className="fv-actions">
          <button className={sub === "blame" ? "on" : ""} onClick={() => setSub("blame")}>
            Blame
          </button>
          <button className={sub === "history" ? "on" : ""} onClick={() => setSub("history")}>
            History
          </button>
        </div>
        {(sub === "diff" || sub === "file") && (
          <div className="fv-stats">
            <span className="diff-stat add">+{diff.additions}</span>
            <span className="diff-stat del">−{diff.deletions}</span>
          </div>
        )}
        {sub === "diff" && (
          <div className="diff-mode-toggle">
            <button className={mode === "inline" ? "on" : ""} onClick={() => setMode("inline")}>
              Inline
            </button>
            <button className={mode === "split" ? "on" : ""} onClick={() => setMode("split")}>
              Split
            </button>
          </div>
        )}
      </div>

      <div className="fv-body">
        {sub === "diff" && <DiffView diff={diff} mode={mode} />}
        {sub === "file" &&
          (fileOid ? (
            <FileContentView repoPath={repoPath} oid={fileOid} file={diff.path} />
          ) : (
            <div className="diff-note">No committed version to show.</div>
          ))}
        {sub === "blame" && (
          <BlameView repoPath={repoPath} oid={isWorkingTree ? null : commitOid} file={diff.path} />
        )}
        {sub === "history" && (
          <HistoryView
            repoPath={repoPath}
            file={diff.path}
            onSelectCommit={(oid) => onSelectCommit?.(oid)}
          />
        )}
      </div>
    </div>
  );
}
