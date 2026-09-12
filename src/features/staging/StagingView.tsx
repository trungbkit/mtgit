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
  copyChangesToWorktree,
  listContributors,
  listRefs,
  listWorktrees,
  commitTemplate,
  operationContinue,
  resolveConflictSide,
  stagePaths,
  stashSave,
  stashSaveStaged,
  unstagePaths,
} from "../../ipc/commands";
import { refreshRepo } from "../../ipc/repoState";
import type { StatusEntry } from "../../ipc/types";
import { useSession } from "../../stores/session";
import { toastError, useToasts } from "../../stores/toasts";
import { confirmDialog } from "../../stores/dialog";
import { FileViewer } from "../diff/FileViewer";
import { FileList } from "../commit-detail/FileList";
import { ConflictPanel } from "./ConflictPanel";
import { ContextMenu, type MenuItem, type MenuState } from "../../components/ContextMenu";
import { Autolinked } from "../../components/Autolinked";
import { addCoAuthor, coAuthorEmails } from "../../lib/coauthors";
import { matches } from "../../lib/keys";
import { copyText } from "../../lib/clipboard";
import { useSettings } from "../../stores/settings";
import { conflictLabel, useConflict } from "../../stores/conflict";
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
  const { data: template } = useQuery({
    queryKey: ["commitTemplate", repo.path],
    queryFn: () => commitTemplate(repo.path),
    staleTime: 60_000,
  });
  const { data: contributors } = useQuery({
    queryKey: ["contributors", repo.path],
    queryFn: () => listContributors(repo.path),
    staleTime: 30_000,
  });
  // Only for the "Copy changes to worktree…" entry, which does not exist until
  // there is a second worktree to copy into (`01-commit.md` §3.2).
  const { data: worktrees } = useQuery({
    queryKey: ["worktrees", repo.path],
    queryFn: () => listWorktrees(repo.path),
    staleTime: 30_000,
  });

  // `commit.template` seeds an *empty* message only (`01-commit.md` §7).
  // Overwriting a draft would throw away work the user already typed, and a
  // template that reappears every time you clear the box is unusable.
  const seededTemplate = useRef(false);
  useEffect(() => {
    if (seededTemplate.current || !template) return;
    if (summary.trim() || description.trim()) {
      // There was already a draft; the template's moment has passed.
      seededTemplate.current = true;
      return;
    }
    seededTemplate.current = true;
    const [first = "", ...rest] = template.split("\n");
    setSummary(first);
    setDescription(rest.join("\n").replace(/^\n+/, ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template]);

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

  // The commit field takes focus as soon as this view mounts, which is what
  // makes the app-level `commit.focus` chord work from anywhere (STATUS B5):
  // App selects the WIP row, mounting this, and this lands the caret.
  useEffect(() => {
    summaryRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (matches(event, "commit.focus")) {
        event.preventDefault();
        summaryRef.current?.focus();
      } else if (matches(event, "commit.submit")) {
        event.preventDefault();
        onCommit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const ignoreWhitespace = useSettings((s) => s.settings.diffIgnoreWhitespace);
  const { data: diffs } = useQuery({
    queryKey: ["worktreeDiff", repo.path, sel?.path, sel?.staged, ignoreWhitespace],
    enabled: !!sel,
    queryFn: () => getWorktreeDiff(repo.path, sel!.staged, sel!.path),
  });

  const refresh = () => refreshRepo(qc, repo.path);

  async function run(fn: () => Promise<unknown>) {
    try {
      await fn();
      refresh();
    } catch (e) {
      toastError(e);
    }
  }

  /**
   * The `…` menu on a section header (`01-commit.md` §3.2).
   *
   * GitLens treats moving uncommitted work between worktrees as a first-class
   * action, and it is the whole point of having worktrees: you started in the
   * wrong one. Stash sits beside it because both answer "get this out of my
   * way", and the header is where the pile of changes is.
   */
  const sectionMenu = (event: React.MouseEvent, stagedOnly: boolean): void => {
    const others = (worktrees ?? []).filter((wt) => !wt.isCurrent);
    const what = stagedOnly ? "staged changes" : "all changes";
    const items: MenuItem[] = [
      {
        label: stagedOnly ? "Stash staged changes" : "Stash all changes",
        onClick: () =>
          run(async () => {
            if (stagedOnly) await stashSaveStaged(repo.path);
            // Untracked files are part of "all changes" here; leaving them
            // behind is how a stash-and-switch loses a brand-new file.
            else await stashSave(repo.path, undefined, true);
            pushToast("success", `Stashed ${what}.`);
          }),
      },
    ];
    if (others.length) {
      items.push({ separator: true });
      for (const wt of others) {
        items.push({
          label: `Copy ${what} to “${wt.name}”…`,
          onClick: () =>
            run(async () => {
              const copied = await copyChangesToWorktree(repo.path, wt.name, stagedOnly);
              // "Copy", so the toast says what is *still here* as well as what
              // is now there — the gesture is easy to read as a move.
              pushToast(
                copied.skipped ? "info" : "success",
                `Copied ${copied.files} file(s) to “${copied.worktree}”. This worktree keeps them too.` +
                  (copied.skipped
                    ? ` ${copied.skipped} change(s) could not be expressed as a patch and stayed here only.`
                    : ""),
              );
            }),
        });
      }
    }
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  const staged = status?.staged ?? [];
  const unstaged = status?.unstaged ?? [];
  const conflicted = status?.conflicted ?? [];
  const conflictedFiles = conflicted.length;
  // Read, never written, here: `ipc/repoState.ts:syncOperation` is the only
  // writer to this store in the whole frontend (STATUS §1.1).
  const operation = useConflict((s) => s.active);

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
                      run(() => resolveConflictSide(repo.path, file.path, "ours"));
                    }}
                  >
                    O
                  </button>
                  <button
                    title="Resolve using theirs"
                    onClick={(event) => {
                      event.stopPropagation();
                      run(() => resolveConflictSide(repo.path, file.path, "theirs"));
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
              <span className="staging-bulk">
                <button onClick={() => run(() => unstagePaths(repo.path, staged.map((e) => e.path)))}>
                  Unstage all
                </button>
                <button
                  className="staging-more"
                  title="Stash or copy the staged changes"
                  onClick={(event) => sectionMenu(event, true)}
                >
                  ⋯
                </button>
              </span>
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
                <button
                  className="staging-more"
                  title="Stash or copy every uncommitted change"
                  onClick={(event) => sectionMenu(event, false)}
                >
                  ⋯
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
          <ConflictPanel
            repoPath={repo.path}
            file={sel.path}
            onSelectFile={(path) => setSel({ path, staged: false })}
          />
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
        <div className="commit-extras">
          {/* Co-author picker (`01-commit.md` §7). Pairing is common enough
              that typing the trailer by hand — and getting the address wrong —
              is a real cost; the list is the repository's own contributors. */}
          <button
            className="commit-coauthor"
            disabled={!contributors?.length}
            title={
              contributors?.length
                ? "Add a Co-authored-by trailer"
                : "No contributors to add yet"
            }
            onClick={(event) => {
              const already = coAuthorEmails(description);
              const items: MenuItem[] = (contributors ?? [])
                .filter((c) => c.email && !already.has(c.email.toLowerCase()))
                .slice(0, 25)
                .map((c) => ({
                  label: `${c.name || c.email} <${c.email}>`,
                  onClick: () => setDescription((body) => addCoAuthor(body, c.name, c.email)),
                }));
              setMenu({
                x: event.clientX,
                y: event.clientY,
                items: items.length ? items : [{ label: "Everyone is already credited", disabled: true }],
              });
            }}
          >
            + Co-author
          </button>
          {/* Autolinks in the preview, so a ticket reference is verifiable
              before the commit exists rather than after (G20). */}
          {(summary.trim() || description.trim()) && (
            <div className="commit-preview">
              <Autolinked repoPath={repo.path} text={`${summary}\n${description}`.trim()} />
            </div>
          )}
        </div>
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
          {/* STATUS B6 / `01-commit.md` §5: mid-operation, the button that
              finishes what you are doing is Continue, not Commit. Committing
              by hand during a rebase creates a commit the sequencer does not
              know about, which is the mistake this prevents. The banner keeps
              its own Continue — this is the second place, not a replacement,
              because this is where the user's hands already are. */}
          {operation && operation.repoPath === repo.path ? (
            <button
              className="primary"
              onClick={() =>
                run(async () => {
                  const result = await operationContinue(repo.path);
                  if (!result.success) throw new Error(result.output);
                })
              }
              disabled={conflictedFiles > 0}
              title={
                conflictedFiles > 0
                  ? `Resolve ${conflictedFiles} conflicted file(s) first`
                  : `Continue the ${conflictLabel(operation.kind).toLowerCase()}`
              }
            >
              Continue {conflictLabel(operation.kind)}
              {operation.total && operation.total > 1
                ? ` (${operation.current ?? 1} of ${operation.total})`
                : ""}
            </button>
          ) : (
            <button
              className="primary"
              onClick={() => onCommit()}
              disabled={!summary.trim() || (staged.length === 0 && !amend)}
              title={!summary.trim() ? "Enter a summary" : staged.length === 0 && !amend ? "Stage at least one file" : ""}
            >
              {amend ? "Amend Previous Commit" : `Commit changes to ${staged.length} file${staged.length === 1 ? "" : "s"}`}
            </button>
          )}
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
