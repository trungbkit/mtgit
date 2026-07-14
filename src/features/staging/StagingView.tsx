import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  commit as doCommit,
  discardPaths,
  getStatus,
  getWorktreeDiff,
  stagePaths,
  unstagePaths,
} from "../../ipc/commands";
import type { StatusEntry } from "../../ipc/types";
import { useSession } from "../../stores/session";
import { toastError, useToasts } from "../../stores/toasts";
import { confirmDialog } from "../../stores/dialog";
import { FileViewer } from "../diff/FileViewer";
import { FileList } from "../commit-detail/FileList";
import "./staging.css";

export function StagingView() {
  const repo = useSession((s) => s.repo)!;
  const qc = useQueryClient();
  const pushToast = useToasts((s) => s.push);

  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [sel, setSel] = useState<{ path: string; staged: boolean } | null>(null);

  const { data: status } = useQuery({
    queryKey: ["status", repo.path],
    queryFn: () => getStatus(repo.path),
  });

  const { data: diffs } = useQuery({
    queryKey: ["worktreeDiff", repo.path, sel?.path, sel?.staged],
    enabled: !!sel,
    queryFn: () => getWorktreeDiff(repo.path, sel!.staged, sel!.path),
  });

  const refresh = () =>
    qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === repo.path });

  async function run(fn: () => Promise<unknown>) {
    try {
      await fn();
      refresh();
    } catch (e) {
      toastError(e);
    }
  }

  const staged = status?.staged ?? [];
  const unstaged = status?.unstaged ?? [];
  const conflicted = status?.conflicted ?? [];

  async function onCommit() {
    if (!message.trim()) {
      pushToast("error", "Enter a commit message.");
      return;
    }
    try {
      await doCommit(repo.path, message, amend);
      setMessage("");
      setAmend(false);
      pushToast("success", "Committed.");
      refresh();
    } catch (e) {
      toastError(e);
    }
  }

  const activeDiff = diffs?.find((d) => d.path === sel?.path) ?? diffs?.[0];

  return (
    <section className="detail staging">
      <div className="staging-lists">
        {conflicted.length > 0 && (
          <Group title={`Conflicts (${conflicted.length})`} tone="conflict">
            <FileList
              files={conflicted}
              selected={sel?.path ?? null}
              onSelect={(p) => setSel({ path: p, staged: false })}
            />
          </Group>
        )}

        <Group
          title={`Staged (${staged.length})`}
          action={
            staged.length > 0 && (
              <button onClick={() => run(() => unstagePaths(repo.path, staged.map((e) => e.path)))}>
                Unstage all
              </button>
            )
          }
        >
          <FileList
            files={staged}
            selected={sel?.staged ? sel.path : null}
            onSelect={(p) => setSel({ path: p, staged: true })}
            renderActions={(f) => (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  run(() => unstagePaths(repo.path, [f.path]));
                }}
              >
                −
              </button>
            )}
          />
        </Group>

        <Group
          title={`Changes (${unstaged.length})`}
          action={
            unstaged.length > 0 && (
              <button onClick={() => run(() => stagePaths(repo.path, unstaged.map((e) => e.path)))}>
                Stage all
              </button>
            )
          }
        >
          <FileList
            files={unstaged}
            selected={!sel?.staged ? (sel?.path ?? null) : null}
            onSelect={(p) => setSel({ path: p, staged: false })}
            renderActions={(f) => (
              <>
                <button
                  title="Discard"
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (
                      await confirmDialog({
                        title: "Discard changes",
                        message: `Discard changes to ${f.path}? This cannot be undone.`,
                        confirmLabel: "Discard",
                        danger: true,
                      })
                    ) {
                      run(() => discardPaths(repo.path, [f.path]));
                    }
                  }}
                >
                  ⨯
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    run(() => stagePaths(repo.path, [f.path]));
                  }}
                >
                  +
                </button>
              </>
            )}
          />
        </Group>
      </div>

      <div className="staging-diff">
        {activeDiff ? (
          <FileViewer
            diff={activeDiff}
            repoPath={repo.path}
            commitOid={null}
            headOid={repo.head.oid}
            isWorkingTree
          />
        ) : (
          <div className="detail-empty">Select a file to view its diff.</div>
        )}
      </div>

      <div className="commit-form">
        <textarea
          placeholder="Commit message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <div className="commit-actions">
          <label>
            <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} /> Amend
          </label>
          <button className="primary" onClick={onCommit} disabled={staged.length === 0 && !amend}>
            Commit {staged.length > 0 ? `(${staged.length})` : ""}
          </button>
        </div>
      </div>
    </section>
  );
}

function Group({
  title,
  children,
  action,
  tone,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  tone?: "conflict";
}) {
  return (
    <div className={`staging-group${tone ? " " + tone : ""}`}>
      <div className="staging-group-head">
        <span>{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

export type { StatusEntry };
