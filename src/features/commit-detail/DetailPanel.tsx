import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { commitAdvanced, getCommit, getCommitDiff, getStatus } from "../../ipc/commands";
import { refreshRepo } from "../../ipc/repoState";
import type { CommitDetail, FileStatus } from "../../ipc/types";
import { Icon } from "../../components/Icon";
import { useSettings } from "../../stores/settings";
import { useSession, WORKING } from "../../stores/session";
import { toastError, useToasts } from "../../stores/toasts";
import { StagingView } from "../staging/StagingView";
import { FileViewer } from "../diff/FileViewer";
import { FileList, STATUS_MARK } from "./FileList";
import { Avatar } from "../../components/Avatar";
import { Autolinked } from "../../components/Autolinked";
import { ContextMenu, type MenuState } from "../../components/ContextMenu";
import { seedSearch } from "../../stores/search";
import { pushDetail, sheetTitle, useDetailStack } from "../../stores/detailStack";
import { CompareView } from "../graph/CompareView";
import { copyText } from "../../lib/clipboard";
import { formatTimestamp } from "../../lib/time";
import "./detail.css";

export function DetailPanel() {
  const repo = useSession((s) => s.repo);
  const selectedOid = useSession((s) => s.selectedOid);
  const selectOid = useSession((s) => s.selectOid);
  const stack = useDetailStack((s) => s.stack);
  const clearStack = useDetailStack((s) => s.clear);
  // Selecting a row means "look at this", not "add a layer": the stack is
  // dropped so the panel shows the selection rather than a sheet about some
  // other commit.
  useEffect(() => {
    clearStack();
  }, [selectedOid, clearStack]);

  const { data: status } = useQuery({
    queryKey: ["status", repo?.path],
    enabled: !!repo,
    queryFn: () => getStatus(repo!.path),
  });

  if (!repo) {
    return (
      <section className="detail">
        <div className="detail-empty">Select a commit to see its details.</div>
      </section>
    );
  }
  if (stack.length > 0) {
    // A sheet is layered over the selection (G24). The base is still the
    // selected row underneath — Back reveals it rather than re-fetching it.
    return <SheetStack repoPath={repo.path} headOid={repo.head.oid} />;
  }
  if (selectedOid === WORKING) {
    return <StagingView />;
  }
  const changed = new Set([
    ...(status?.staged ?? []).map((entry) => entry.path),
    ...(status?.unstaged ?? []).map((entry) => entry.path),
    ...(status?.conflicted ?? []).map((entry) => entry.path),
  ]).size;
  return (
    <div className="detail-shell">
      {changed > 0 && (
        <button className="changes-banner" onClick={() => selectOid(WORKING)}>
          <span>
            {changed} file change{changed === 1 ? "" : "s"} in working directory
          </span>
          {/* The whole strip is the target; this is the affordance saying so,
              not a second button inside the first. */}
          <span className="changes-banner-cta">View Changes</span>
        </button>
      )}
      {selectedOid ? (
        <CommitView repoPath={repo.path} oid={selectedOid} headOid={repo.head.oid} />
      ) : (
        <section className="detail">
          <div className="detail-empty">Select a commit to see its details.</div>
        </section>
      )}
    </div>
  );
}

/**
 * The pushed sheets, newest on top, with a crumb trail back to the selection.
 *
 * Only the top sheet is rendered. Keeping the ones beneath mounted would mean
 * a virtualized diff and a Shiki highlighter per layer, and the user cannot
 * see them; the crumb trail is what makes the depth legible instead.
 */
function SheetStack({ repoPath, headOid }: { repoPath: string; headOid: string | null }) {
  const stack = useDetailStack((s) => s.stack);
  const pop = useDetailStack((s) => s.pop);
  const clear = useDetailStack((s) => s.clear);
  const top = stack[stack.length - 1];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const el = event.target as HTMLElement | null;
      if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) return;
      event.preventDefault();
      pop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pop]);

  if (!top) return null;
  return (
    <div className="detail-shell">
      <div className="detail-crumbs">
        <button onClick={pop} title="Back (Escape)">
          ‹ Back
        </button>
        <button className="detail-crumb-root" onClick={clear}>
          selection
        </button>
        {stack.map((sheet, i) => (
          <span key={i} className={`detail-crumb${i === stack.length - 1 ? " current" : ""}`}>
            {sheetTitle(sheet)}
          </span>
        ))}
      </div>
      {top.kind === "commit" ? (
        <CommitView repoPath={repoPath} oid={top.oid} headOid={headOid} />
      ) : (
        <CompareView
          repoPath={repoPath}
          oldOid={top.oldOid}
          newOid={top.newOid}
          onSelectCommit={(oid) => pushDetail({ kind: "commit", oid })}
        />
      )}
    </div>
  );
}

interface SummaryPart {
  /** The `.file-mark` colour class, so the counts read in the same language
   *  the rows two lines below them do. */
  cls: string;
  ch: string;
  label: string;
}

/**
 * The change counts, as parts rather than one joined string.
 *
 * Joined, it could only ever be one colour — while the rows it describes were
 * already colour-coded by status, so the summary was the one place in the panel
 * that said "added" in the same grey as "deleted".
 */
function summarize(files: { status: FileStatus }[]): SummaryPart[] {
  let mod = 0;
  let add = 0;
  let del = 0;
  for (const f of files) {
    if (f.status === "added" || f.status === "untracked") add++;
    else if (f.status === "deleted") del++;
    else mod++;
  }
  const parts: SummaryPart[] = [];
  if (mod) parts.push({ ...STATUS_MARK.modified, label: `${mod} modified` });
  if (add) parts.push({ ...STATUS_MARK.added, label: `${add} added` });
  if (del) parts.push({ ...STATUS_MARK.deleted, label: `${del} deleted` });
  return parts;
}

function CommitView({ repoPath, oid, headOid }: { repoPath: string; oid: string; headOid: string | null }) {
  const selectedFile = useSession((s) => s.selectedFile);
  const selectFile = useSession((s) => s.selectFile);
  const selectOid = useSession((s) => s.selectOid);
  const qc = useQueryClient();
  const pushToast = useToasts((s) => s.push);

  const [amending, setAmending] = useState(false);
  const [amendMsg, setAmendMsg] = useState("");
  const [closedFile, setClosedFile] = useState(false);
  const [fileMenu, setFileMenu] = useState<MenuState | null>(null);

  const { data: detail } = useQuery({
    queryKey: ["commit", repoPath, oid],
    queryFn: () => getCommit(repoPath, oid),
  });
  const ignoreWhitespace = useSettings((s) => s.settings.diffIgnoreWhitespace);
  const { data: diffs } = useQuery({
    queryKey: ["commitDiff", repoPath, oid, ignoreWhitespace],
    queryFn: () => getCommitDiff(repoPath, oid),
  });

  useEffect(() => {
    setAmending(false);
    setClosedFile(false);
  }, [oid]);

  if (!detail) {
    return (
      <section className="detail">
        <div className="detail-empty">Loading…</div>
      </section>
    );
  }

  const isHead = headOid === oid;
  const activeDiff = closedFile ? undefined : diffs?.find((d) => d.path === selectedFile) ?? diffs?.[0];
  const committerDiffers =
    detail.committerEmail !== detail.authorEmail || detail.committerName !== detail.authorName;

  async function updateMessage() {
    try {
      const [summary = "", ...rest] = amendMsg.split("\n");
      const result = await commitAdvanced(repoPath, summary, rest.join("\n").trimStart(), true);
      if (!result.success) throw new Error(result.output);
      pushToast("success", "Commit message updated.");
      setAmending(false);
      await refreshRepo(qc, repoPath);
      if (result.oid) selectOid(result.oid);
    } catch (e) {
      toastError(e);
    }
  }

  function startAmend(d: CommitDetail) {
    setAmendMsg(d.body ? `${d.summary}\n\n${d.body}` : d.summary);
    setAmending(true);
  }

  return (
    <section className="detail">
      <div className="detail-topbar">
        <span className="detail-commitid" onClick={() => copyText(detail.oid)} title="Copy full SHA">
          commit: {detail.oid.slice(0, 6)}
        </span>
      </div>

      {amending ? (
        <div className="amend-box">
          <textarea value={amendMsg} onChange={(e) => setAmendMsg(e.target.value)} autoFocus />
          <div className="amend-actions">
            <button className="amend-update" onClick={updateMessage} disabled={!amendMsg.trim()}>
              Update Message
            </button>
            <button className="amend-cancel" onClick={() => setAmending(false)}>
              Cancel Amend
            </button>
          </div>
        </div>
      ) : (
        <div className="detail-message">
          <div className="detail-summary">
            <Autolinked repoPath={repoPath} text={detail.summary} />
            {isHead && (
              <button className="detail-amend-btn" title="Amend message" onClick={() => startAmend(detail)}>
                <Icon name="pencil" size={12} />
              </button>
            )}
          </div>
          {detail.body && (
            <pre className="detail-body">
              <Autolinked repoPath={repoPath} text={detail.body} />
            </pre>
          )}
        </div>
      )}

      <div className="detail-people">
        <div className="detail-person">
          <Avatar email={detail.authorEmail} name={detail.authorName} size={28} />
          <div className="detail-who">
            <span className="detail-author">{detail.authorName}</span>
            <span className="detail-when">authored {formatTimestamp(detail.authorTime)}</span>
          </div>
          <span className="detail-parents">
            {detail.parents.length > 0 ? (
              <>
                parent:{" "}
                {detail.parents.map((p, i) => (
                  <span key={p}>
                    {i > 0 && ", "}
                    {/* Pushes a sheet rather than moving the graph selection:
                        following a parent is a detour, and the row you came
                        from should still be where you left it (G24). */}
                    <button
                      className="detail-parent-link"
                      title={`Open ${p.slice(0, 7)} without losing this one`}
                      onClick={() => pushDetail({ kind: "commit", oid: p })}
                    >
                      {p.slice(0, 6)}
                    </button>
                  </span>
                ))}
              </>
            ) : (
              "root commit"
            )}
          </span>
        </div>
        {committerDiffers && (
          <div className="detail-person">
            <Avatar email={detail.committerEmail} name={detail.committerName} size={28} />
            <div className="detail-who">
              <span className="detail-author">{detail.committerName}</span>
              <span className="detail-when">committed {formatTimestamp(detail.committerTime)}</span>
            </div>
          </div>
        )}
      </div>

      <div className="detail-filesummary">
        {summarize(detail.files).map((part) => (
          <span key={part.label} className={`fs-part ${part.cls}`}>
            <span className="fs-mark">{part.ch}</span>
            {part.label}
          </span>
        ))}
        {detail.files.length === 0 && <span className="fs-part">no changes</span>}
      </div>

      <div className="detail-split">
        <FileList
          files={detail.files.map((f) => ({
            path: f.path,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
          }))}
          selected={activeDiff?.path ?? null}
          onSelect={(p) => {
            setClosedFile(false);
            selectFile(p);
          }}
          onContextMenu={(event, file) => {
            event.preventDefault();
            setFileMenu({
              x: event.clientX,
              y: event.clientY,
              items: [
                {
                  // §2: a file row is one of the search field's entry points.
                  label: "Search commits touching this file",
                  onClick: () => seedSearch(repoPath, `file:${file.path}`),
                },
                {
                  label: "Search commits that changed this file's content",
                  onClick: () => seedSearch(repoPath, `file:${file.path} change:`),
                },
                { separator: true },
                { label: "Copy path", onClick: () => copyText(file.path) },
              ],
            });
          }}
        />
        <div className="detail-diff">
          {activeDiff ? (
            <FileViewer
              diff={activeDiff}
              repoPath={repoPath}
              commitOid={oid}
              headOid={headOid}
              isWorkingTree={false}
              onClose={() => setClosedFile(true)}
              onSelectCommit={(o) => selectOid(o)}
            />
          ) : (
            <div className="detail-empty">Select a file to view its diff.</div>
          )}
        </div>
      </div>
      <ContextMenu menu={fileMenu} onClose={() => setFileMenu(null)} />
    </section>
  );
}
