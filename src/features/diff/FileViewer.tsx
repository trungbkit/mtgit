import { useEffect, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { useQueryClient } from "@tanstack/react-query";
import type { FileDiff, Hunk } from "../../ipc/types";
import { applyPatch } from "../../ipc/commands";
import { useSession } from "../../stores/session";
import { toastError, useToasts } from "../../stores/toasts";
import { confirmDialog } from "../../stores/dialog";
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
  worktreeStaged,
  onClose,
  onSelectCommit,
}: {
  diff: FileDiff;
  repoPath: string;
  /** Commit being viewed; null when viewing the working tree. */
  commitOid: string | null;
  headOid: string | null;
  isWorkingTree: boolean;
  worktreeStaged?: boolean;
  onClose?: () => void;
  onSelectCommit?: (oid: string) => void;
}) {
  const mode = useSession((s) => s.diffMode);
  const setMode = useSession((s) => s.setDiffMode);
  const [sub, setSub] = useState<SubMode>("diff");
  const qc = useQueryClient();
  const pushToast = useToasts((state) => state.push);

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

  async function applyHunk(hunk: Hunk, reverse: boolean, cached: boolean, selected?: Set<number>) {
    try {
      await applyPatch(repoPath, buildPatch(diff, hunk, selected), cached, reverse);
      pushToast("success", reverse ? (cached ? "Hunk unstaged." : "Hunk discarded.") : "Hunk staged.");
      qc.invalidateQueries({ predicate: (query) => query.queryKey[1] === repoPath });
    } catch (error) {
      toastError(error);
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
        {sub === "diff" && (
          <DiffView
            diff={diff}
            mode={mode}
            staging={isWorkingTree ? (worktreeStaged ? "unstage" : "stage") : null}
            onHunkAction={(hunk) => applyHunk(hunk, !!worktreeStaged, true)}
            onLinesAction={(hunk, selected) => applyHunk(hunk, !!worktreeStaged, true, selected)}
            onDiscardHunk={
              isWorkingTree && !worktreeStaged
                ? async (hunk) => {
                    if (
                      await confirmDialog({
                        title: "Discard hunk",
                        message: `Discard this hunk from ${diff.path}?`,
                        confirmLabel: "Discard hunk",
                        danger: true,
                      })
                    ) {
                      applyHunk(hunk, true, false);
                    }
                  }
                : undefined
            }
          />
        )}
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

function buildPatch(diff: FileDiff, hunk: Hunk, selected?: Set<number>): string {
  const oldPath = diff.status === "added" || diff.status === "untracked" ? "/dev/null" : `a/${diff.oldPath ?? diff.path}`;
  const newPath = diff.status === "deleted" ? "/dev/null" : `b/${diff.path}`;
  let header = hunk.header;
  let lines = hunk.lines.map((line, index) => ({ ...line, index }));

  if (selected) {
    const match = hunk.header.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    const oldStart = Number(match?.[1] ?? 1);
    const newStart = Number(match?.[2] ?? 1);
    lines = lines.flatMap((line) => {
      if (line.kind === "add" && !selected.has(line.index)) return [];
      if (line.kind === "del" && !selected.has(line.index)) return [{ ...line, kind: "context" as const }];
      return [line];
    });
    const oldCount = lines.filter((line) => line.kind !== "add").length;
    const newCount = lines.filter((line) => line.kind !== "del").length;
    header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${match?.[3] ?? ""}`;
  }

  const body = lines
    .map((line) => `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}\n`)
    .join("");
  return `diff --git a/${diff.oldPath ?? diff.path} b/${diff.path}\n--- ${oldPath}\n+++ ${newPath}\n${header}\n${body}`;
}
