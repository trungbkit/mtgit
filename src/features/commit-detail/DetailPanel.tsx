import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { commit as doCommit, getCommit, getCommitDiff } from "../../ipc/commands";
import type { CommitDetail, FileStatus } from "../../ipc/types";
import { useSession, WORKING } from "../../stores/session";
import { toastError, useToasts } from "../../stores/toasts";
import { StagingView } from "../staging/StagingView";
import { FileViewer } from "../diff/FileViewer";
import { FileList } from "./FileList";
import { Avatar } from "../../components/Avatar";
import { copyText } from "../../lib/clipboard";
import { formatTimestamp } from "../../lib/time";
import "./detail.css";

export function DetailPanel() {
  const repo = useSession((s) => s.repo);
  const selectedOid = useSession((s) => s.selectedOid);

  if (selectedOid === WORKING) {
    return <StagingView />;
  }
  if (!repo || !selectedOid) {
    return (
      <section className="detail">
        <div className="detail-empty">Select a commit to see its details.</div>
      </section>
    );
  }
  return <CommitView repoPath={repo.path} oid={selectedOid} headOid={repo.head.oid} />;
}

function summarize(files: { status: FileStatus }[]): string {
  let mod = 0;
  let add = 0;
  let del = 0;
  for (const f of files) {
    if (f.status === "added" || f.status === "untracked") add++;
    else if (f.status === "deleted") del++;
    else mod++;
  }
  const parts: string[] = [];
  if (mod) parts.push(`${mod} modified`);
  if (add) parts.push(`${add} added`);
  if (del) parts.push(`${del} deleted`);
  return parts.join(" + ") || "no changes";
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

  const { data: detail } = useQuery({
    queryKey: ["commit", repoPath, oid],
    queryFn: () => getCommit(repoPath, oid),
  });
  const { data: diffs } = useQuery({
    queryKey: ["commitDiff", repoPath, oid],
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
      const newOid = await doCommit(repoPath, amendMsg, true);
      pushToast("success", "Commit message updated.");
      setAmending(false);
      qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === repoPath });
      selectOid(newOid);
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
            {detail.summary}
            {isHead && (
              <button className="detail-amend-btn" title="Amend message" onClick={() => startAmend(detail)}>
                ✎
              </button>
            )}
          </div>
          {detail.body && <pre className="detail-body">{detail.body}</pre>}
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
            {detail.parents.length > 0
              ? `parent: ${detail.parents.map((p) => p.slice(0, 6)).join(", ")}`
              : "root commit"}
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
        <span className="fs-count">{summarize(detail.files)}</span>
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
    </section>
  );
}
