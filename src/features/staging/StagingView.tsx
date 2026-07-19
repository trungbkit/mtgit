import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  commitAdvanced,
  discardPaths,
  getHeadMessage,
  getStatus,
  getWorktreeDiff,
  ignorePath,
  listRefs,
  resolveConflictSide,
  stagePaths,
  unstagePaths,
} from "../../ipc/commands";
import type { StatusEntry } from "../../ipc/types";
import { useSession } from "../../stores/session";
import { toastError, useToasts } from "../../stores/toasts";
import { confirmDialog } from "../../stores/dialog";
import { FileViewer } from "../diff/FileViewer";
import { FileList } from "../commit-detail/FileList";
import { ConflictEditor } from "./ConflictEditor";
import { useConflict } from "../../stores/conflict";
import { ContextMenu, type MenuState } from "../../components/ContextMenu";
import { copyText } from "../../lib/clipboard";
import "./staging.css";

export function StagingView() {
  const repo = useSession((s) => s.repo)!;
  const qc = useQueryClient();
  const pushToast = useToasts((s) => s.push);

  const draftKey = `mtgit.commitDraft.${repo.path}`;
  const savedDraft = (() => {
    try {
      return JSON.parse(localStorage.getItem(draftKey) ?? "{}") as { summary?: string; description?: string };
    } catch {
      return {};
    }
  })();
  const [summary, setSummary] = useState(savedDraft.summary ?? "");
  const [description, setDescription] = useState(savedDraft.description ?? "");
  const [amend, setAmend] = useState(false);
  const [hookFailure, setHookFailure] = useState<string | null>(null);
  const [sel, setSel] = useState<{ path: string; staged: boolean } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const summaryRef = useRef<HTMLInputElement>(null);

  const { data: status } = useQuery({
    queryKey: ["status", repo.path],
    queryFn: () => getStatus(repo.path),
  });
  const { data: refs } = useQuery({
    queryKey: ["refs", repo.path],
    queryFn: () => listRefs(repo.path),
  });

  useEffect(() => {
    localStorage.setItem(draftKey, JSON.stringify({ summary, description }));
  }, [description, draftKey, summary]);

  useEffect(() => {
    const restore = (event: Event) => {
      const message = (event as CustomEvent<string>).detail;
      const [first = "", ...rest] = message.split("\n");
      setSummary(first);
      setDescription(rest.join("\n").trimStart());
    };
    window.addEventListener("mtgit-restore-commit-message", restore);
    return () => window.removeEventListener("mtgit-restore-commit-message", restore);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        summaryRef.current?.focus();
      } else if (event.key === "Enter") {
        event.preventDefault();
        onCommit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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

  async function onCommit(noVerify = false) {
    if (!summary.trim()) {
      pushToast("error", "Enter a commit message.");
      return;
    }
    try {
      const result = await commitAdvanced(repo.path, summary.trim(), description.trim(), amend, noVerify);
      if (!result.success) {
        setHookFailure(result.output);
        pushToast("error", result.output || "Commit failed.");
        return;
      }
      setSummary("");
      setDescription("");
      setAmend(false);
      setHookFailure(null);
      localStorage.removeItem(draftKey);
      pushToast("success", `Committed ${result.oid?.slice(0, 7) ?? ""}.`);
      refresh();
    } catch (e) {
      toastError(e);
    }
  }

  const activeDiff = diffs?.find((d) => d.path === sel?.path) ?? diffs?.[0];
  const selectedConflict = !!sel && conflicted.some((entry) => entry.path === sel.path);
  const headRef = refs?.local.find((branch) => branch.isHead);
  const amendPushed = amend && headRef?.upstream && (headRef.ahead ?? 0) === 0;

  async function toggleAmend(next: boolean) {
    setAmend(next);
    if (!next) return;
    try {
      const message = await getHeadMessage(repo.path);
      const [first = "", ...rest] = message.trimEnd().split("\n");
      setSummary(first);
      setDescription(rest.join("\n").trimStart());
    } catch (error) {
      toastError(error);
      setAmend(false);
    }
  }

  return (
    <section className="detail staging">
      <div className="staging-lists">
        {conflicted.length > 0 && (
          <Group title={`Conflicts (${conflicted.length})`} tone="conflict">
            <FileList
              files={conflicted}
              selected={sel?.path ?? null}
              onSelect={(p) => setSel({ path: p, staged: false })}
              renderActions={(file) => (
                <>
                  <button
                    title="Resolve using ours"
                    onClick={(event) => {
                      event.stopPropagation();
                      run(async () => {
                        await resolveConflictSide(repo.path, file.path, "ours");
                        const active = useConflict.getState().active;
                        if (active) useConflict.getState().set({ ...active, files: active.files.filter((path) => path !== file.path) });
                      });
                    }}
                  >
                    O
                  </button>
                  <button
                    title="Resolve using theirs"
                    onClick={(event) => {
                      event.stopPropagation();
                      run(async () => {
                        await resolveConflictSide(repo.path, file.path, "theirs");
                        const active = useConflict.getState().active;
                        if (active) useConflict.getState().set({ ...active, files: active.files.filter((path) => path !== file.path) });
                      });
                    }}
                  >
                    T
                  </button>
                </>
              )}
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
            onContextMenu={(event, file) => {
              event.preventDefault();
              setMenu({
                x: event.clientX,
                y: event.clientY,
                items: [
                  { label: "Unstage file", onClick: () => run(() => unstagePaths(repo.path, [file.path])) },
                  { label: "Open in external editor", onClick: () => openPath(`${repo.path}/${file.path}`).catch(toastError) },
                  { label: "Copy path", onClick: () => copyText(file.path) },
                ],
              });
            }}
          />
        </Group>

        <Group
          title={`Changes (${unstaged.length})`}
          action={
            unstaged.length > 0 && (
              <span className="staging-bulk">
                <button
                  className="danger-link"
                  onClick={async () => {
                    if (
                      await confirmDialog({
                        title: "Discard all unstaged changes",
                        message: `Permanently discard changes in ${unstaged.length} listed file(s)?`,
                        confirmLabel: "Discard all",
                        danger: true,
                      })
                    ) {
                      run(() => discardPaths(repo.path, unstaged.map((entry) => entry.path)));
                    }
                  }}
                >
                  Discard all
                </button>
                <button onClick={() => run(() => stagePaths(repo.path, unstaged.map((e) => e.path)))}>
                  Stage all
                </button>
              </span>
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
            onContextMenu={(event, file) => {
              event.preventDefault();
              setMenu({
                x: event.clientX,
                y: event.clientY,
                items: [
                  { label: "Stage file", onClick: () => run(() => stagePaths(repo.path, [file.path])) },
                  {
                    label: "Discard changes…",
                    danger: true,
                    onClick: async () => {
                      if (
                        await confirmDialog({
                          title: "Discard changes",
                          message: `Discard changes to ${file.path}?`,
                          confirmLabel: "Discard",
                          danger: true,
                        })
                      ) {
                        run(() => discardPaths(repo.path, [file.path]));
                      }
                    },
                  },
                  { label: "Ignore", onClick: () => run(() => ignorePath(repo.path, file.path)) },
                  { label: "Open in external editor", onClick: () => openPath(`${repo.path}/${file.path}`).catch(toastError) },
                  { label: "Copy path", onClick: () => copyText(file.path) },
                ],
              });
            }}
          />
        </Group>
      </div>

      <div className="staging-diff">
        {selectedConflict && sel ? (
          <ConflictEditor repoPath={repo.path} file={sel.path} />
        ) : activeDiff ? (
          <FileViewer
            diff={activeDiff}
            repoPath={repo.path}
            commitOid={null}
            headOid={repo.head.oid}
            isWorkingTree
            worktreeStaged={sel?.staged}
          />
        ) : (
          <div className="detail-empty">Select a file to view its diff.</div>
        )}
      </div>

      <div className="commit-form">
        <div className="commit-summary-wrap">
          <input
            ref={summaryRef}
            className={summary.length > 50 ? "long" : ""}
            placeholder="Summary"
            value={summary}
            onChange={(event) => setSummary(event.target.value.replace(/\n/g, ""))}
          />
          <span>{summary.length}</span>
        </div>
        <textarea
          placeholder="Description (optional)"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        {amendPushed && (
          <div className="commit-warning">This commit is already pushed. Amending it will require a force push.</div>
        )}
        {repo.head.detached && (
          <div className="commit-warning">Detached HEAD: create a branch to keep this commit reachable.</div>
        )}
        {hookFailure && (
          <div className="hook-failure">
            <pre>{hookFailure}</pre>
            <button onClick={() => onCommit(true)}>Commit anyway (skip hooks)</button>
          </div>
        )}
        <div className="commit-actions">
          {repo.head.oid ? (
            <label>
              <input type="checkbox" checked={amend} onChange={(e) => toggleAmend(e.target.checked)} /> Amend last commit
            </label>
          ) : (
            <span />
          )}
          <button
            className="primary"
            onClick={() => onCommit()}
            disabled={!summary.trim() || (staged.length === 0 && !amend)}
            title={!summary.trim() ? "Enter a summary" : staged.length === 0 && !amend ? "Stage at least one file" : ""}
          >
            {amend ? "Amend Previous Commit" : `Commit changes to ${staged.length} file${staged.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
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
