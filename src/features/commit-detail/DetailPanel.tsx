import { useQuery } from "@tanstack/react-query";
import { getCommit, getCommitDiff } from "../../ipc/commands";
import { useSession, WORKING } from "../../stores/session";
import { StagingView } from "../staging/StagingView";
import { DiffView } from "../diff/DiffView";
import { FileList } from "./FileList";
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
  return <CommitView repoPath={repo.path} oid={selectedOid} />;
}

function CommitView({ repoPath, oid }: { repoPath: string; oid: string }) {
  const selectedFile = useSession((s) => s.selectedFile);
  const selectFile = useSession((s) => s.selectFile);

  const { data: detail } = useQuery({
    queryKey: ["commit", repoPath, oid],
    queryFn: () => getCommit(repoPath, oid),
  });
  const { data: diffs } = useQuery({
    queryKey: ["commitDiff", repoPath, oid],
    queryFn: () => getCommitDiff(repoPath, oid),
  });

  if (!detail) {
    return (
      <section className="detail">
        <div className="detail-empty">Loading…</div>
      </section>
    );
  }

  const date = new Date(detail.authorTime * 1000);
  const activeDiff = diffs?.find((d) => d.path === selectedFile) ?? diffs?.[0];

  return (
    <section className="detail">
      <div className="detail-header">
        <div className="avatar" style={{ background: hashColor(detail.authorEmail) }}>
          {initials(detail.authorName)}
        </div>
        <div className="detail-who">
          <div className="detail-author">{detail.authorName}</div>
          <div className="detail-email">{detail.authorEmail}</div>
        </div>
        <div className="detail-date">{date.toLocaleString()}</div>
      </div>

      <div className="detail-summary">{detail.summary}</div>
      {detail.body && <pre className="detail-body">{detail.body}</pre>}

      <div className="detail-oid mono">
        {detail.oid.slice(0, 10)}
        {detail.parents.length > 0 && (
          <span className="detail-parents"> · parents {detail.parents.map((p) => p.slice(0, 7)).join(", ")}</span>
        )}
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
          onSelect={selectFile}
        />
        <div className="detail-diff">
          {activeDiff ? (
            <DiffView diff={activeDiff} />
          ) : (
            <div className="detail-empty">No file changes.</div>
          )}
        </div>
      </div>
    </section>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join("");
}

function hashColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) & 0xffff;
  return `hsl(${h % 360} 45% 40%)`;
}
