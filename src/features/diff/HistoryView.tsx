import { useQuery } from "@tanstack/react-query";
import { fileHistory, lineHistory } from "../../ipc/commands";
import { Avatar } from "../../components/Avatar";
import { Autolinked } from "../../components/Autolinked";
import { Icon } from "../../components/Icon";
import { useSettings } from "../../stores/settings";
import { timeAgo } from "../../lib/time";
import "./history.css";

/** A line range being followed with `-L`; null means whole-file history. */
export interface LineRange {
  start: number;
  end: number;
}

export function HistoryView({
  repoPath,
  file,
  lineRange,
  onClearLineRange,
  onSelectCommit,
}: {
  repoPath: string;
  file: string;
  lineRange?: LineRange | null;
  onClearLineRange?: () => void;
  onSelectCommit: (oid: string, path: string) => void;
}) {
  // Following is a preference rather than a per-view toggle because it is a
  // correctness setting, not a filter: a user who wants renames followed wants
  // them followed in every file. The switch here writes the same setting the
  // settings dialog does.
  const follow = useSettings((s) => s.settings.historyFollowRenames);
  const setFollow = (next: boolean) => useSettings.getState().set({ historyFollowRenames: next });

  const { data, isLoading, error } = useQuery({
    // `follow` and the range are part of the answer, so they are part of the
    // key; the repo path stays at index 1 (invariant 3) so a refresh still
    // reaches this query.
    queryKey: ["fileHistory", repoPath, file, follow, lineRange?.start ?? null, lineRange?.end ?? null],
    queryFn: () =>
      lineRange
        ? lineHistory(repoPath, file, lineRange.start, lineRange.end, 100)
        : fileHistory(repoPath, file, 100, follow),
  });

  return (
    <div className="filehist-wrap">
      <div className="filehist-bar">
        {lineRange ? (
          <span className="filehist-scope">
            <Icon name="pencil" size={11} />
            Lines {lineRange.start}
            {lineRange.start === lineRange.end ? "" : `–${lineRange.end}`}
            <button onClick={onClearLineRange}>Whole file</button>
          </span>
        ) : (
          <label className="filehist-follow">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            Follow renames
          </label>
        )}
      </div>
      <Body
        data={data}
        isLoading={isLoading}
        error={error}
        repoPath={repoPath}
        onSelectCommit={onSelectCommit}
      />
    </div>
  );
}

function Body({
  data,
  isLoading,
  error,
  repoPath,
  onSelectCommit,
}: {
  data: import("../../ipc/types").HistoryEntry[] | undefined;
  isLoading: boolean;
  error: unknown;
  repoPath: string;
  onSelectCommit: (oid: string, path: string) => void;
}) {
  if (isLoading) return <div className="diff-note">Loading history…</div>;
  if (error) return <div className="diff-note">{String(error)}</div>;
  if (!data || data.length === 0) return <div className="diff-note">No history for this file.</div>;

  return (
    <div className="filehist">
      {data.map((h) => (
        <div key={h.oid}>
          {h.renamedFrom && (
            /* The rename is the reason the entries below it exist, so it is
               labelled as a boundary rather than left for the reader to infer
               from a path that quietly changed. */
            <div className="filehist-rename">
              renamed from <code>{h.renamedFrom}</code>
            </div>
          )}
          <button className="filehist-row" onClick={() => onSelectCommit(h.oid, h.path)}>
            <Avatar email={h.email} name={h.author} size={22} />
            <div className="filehist-main">
              <div className="filehist-summary">
                <Autolinked repoPath={repoPath} text={h.summary} />
              </div>
              <div className="filehist-meta">
                {h.author} · {timeAgo(h.timestamp)} · {h.oid.slice(0, 7)}
              </div>
            </div>
          </button>
        </div>
      ))}
    </div>
  );
}
