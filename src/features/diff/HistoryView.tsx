import { useQuery } from "@tanstack/react-query";
import { fileHistory } from "../../ipc/commands";
import { Avatar } from "../../components/Avatar";
import { timeAgo } from "../../lib/time";
import "./history.css";

export function HistoryView({
  repoPath,
  file,
  onSelectCommit,
}: {
  repoPath: string;
  file: string;
  onSelectCommit: (oid: string) => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["fileHistory", repoPath, file],
    queryFn: () => fileHistory(repoPath, file, 100),
  });

  if (isLoading) return <div className="diff-note">Loading history…</div>;
  if (error) return <div className="diff-note">{String(error)}</div>;
  if (!data || data.length === 0) return <div className="diff-note">No history for this file.</div>;

  return (
    <div className="filehist">
      {data.map((h) => (
        <button key={h.oid} className="filehist-row" onClick={() => onSelectCommit(h.oid)}>
          <Avatar email={h.email} name={h.author} size={22} />
          <div className="filehist-main">
            <div className="filehist-summary">{h.summary}</div>
            <div className="filehist-meta">
              {h.author} · {timeAgo(h.timestamp)} · {h.oid.slice(0, 7)}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
