import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { openPath } from "@tauri-apps/plugin-opener";
import type { DiffViewMode, FileDiff, Hunk } from "../../ipc/types";
import { applyPatch, fileHistory } from "../../ipc/commands";
import { refreshRepo } from "../../ipc/repoState";
import { Icon } from "../../components/Icon";
import { useSettings } from "../../stores/settings";
import { toastError, useToasts } from "../../stores/toasts";
import { confirmDialog } from "../../stores/dialog";
import { DiffView } from "./DiffView";
import { FileContentView } from "./FileContentView";
import { BlameView } from "./BlameView";
import { HistoryView, type LineRange } from "./HistoryView";
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
  // Inline/split is a preference, not session state: it moved to the settings
  // file so it survives a restart, which is what `02` of the appearance tab
  // promises.
  const mode = useSettings((s) => s.settings.diffMode);
  const setMode = (next: DiffViewMode) => useSettings.getState().set({ diffMode: next });
  const [sub, setSub] = useState<SubMode>("diff");
  const [lineRange, setLineRange] = useState<LineRange | null>(null);
  const follow = useSettings((s) => s.settings.historyFollowRenames);
  const qc = useQueryClient();
  const pushToast = useToasts((state) => state.push);

  // Reset to the diff tab whenever the selected file changes. The line range
  // goes with it: line 40 of the file you just left means nothing here.
  useEffect(() => {
    setSub("diff");
    setLineRange(null);
  }, [diff.path]);

  // Revision navigation (G22). The list is the file's own history, so ◀ / ▶
  // step through the commits that touched *this file* rather than through the
  // graph — which is the difference between "the previous version of this
  // file" and "the previous commit", and on a busy repo they are far apart.
  const { data: revisions } = useQuery({
    queryKey: ["fileHistory", repoPath, diff.path, follow, null, null],
    queryFn: () => fileHistory(repoPath, diff.path, 100, follow),
    enabled: !!onSelectCommit,
  });
  const revIndex = useMemo(
    () => (revisions && commitOid ? revisions.findIndex((r) => r.oid === commitOid) : -1),
    [revisions, commitOid],
  );

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
      await refreshRepo(qc, repoPath);
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
          <Icon name="pencil" size={12} /> Edit in Working Directory
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
          {onSelectCommit && revIndex >= 0 && revisions && (
            <span className="fv-revnav" title="Revisions of this file">
              <button
                onClick={() => onSelectCommit(revisions[revIndex + 1].oid)}
                disabled={revIndex + 1 >= revisions.length}
                aria-label="Older revision"
              >
                ‹
              </button>
              <span>
                rev {revIndex + 1} / {revisions.length}
              </span>
              <button
                onClick={() => onSelectCommit(revisions[revIndex - 1].oid)}
                disabled={revIndex <= 0}
                aria-label="Newer revision"
              >
                ›
              </button>
            </span>
          )}
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
          <BlameView
            repoPath={repoPath}
            oid={isWorkingTree ? null : commitOid}
            file={diff.path}
            onLineRange={(start, end) => {
              setLineRange({ start, end });
              setSub("history");
            }}
          />
        )}
        {sub === "history" && (
          <HistoryView
            repoPath={repoPath}
            file={diff.path}
            lineRange={lineRange}
            onClearLineRange={() => setLineRange(null)}
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
