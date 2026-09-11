import { useEffect, useState } from "react";
import { compareCommits } from "../../ipc/commands";
import type { FileDiff } from "../../ipc/types";
import { toastError } from "../../stores/toasts";
import { FileViewer } from "../diff/FileViewer";
import "./compare.css";

/**
 * Two commits side by side, as a *sheet* rather than a modal (G24).
 *
 * It was a modal overlay, which made comparing a mode you had to leave: the
 * commit you were reading was gone behind it, and closing was the only exit.
 * It now renders inside the detail panel's stack, so Back is the exit and the
 * commit underneath is still there.
 */
export function CompareView({
  repoPath,
  oldOid,
  newOid,
  onSelectCommit,
}: {
  repoPath: string;
  oldOid: string;
  newOid: string;
  onSelectCommit?: (oid: string) => void;
}) {
  const [diffs, setDiffs] = useState<FileDiff[] | null>(null);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    setDiffs(null);
    setSelected(0);
    compareCommits(repoPath, oldOid, newOid).then(setDiffs).catch(toastError);
  }, [newOid, oldOid, repoPath]);

  return (
    <div className="compare-sheet">
      <aside>
        {(diffs ?? []).map((diff, index) => (
          <button
            key={diff.path}
            className={selected === index ? "selected" : ""}
            onClick={() => setSelected(index)}
          >
            <span>{diff.status.slice(0, 1).toUpperCase()}</span>
            {diff.path}
          </button>
        ))}
        {diffs?.length === 0 && <div className="compare-empty">No differences.</div>}
      </aside>
      <main>
        {diffs === null ? (
          <div className="detail-empty">Comparing…</div>
        ) : diffs[selected] ? (
          <FileViewer
            diff={diffs[selected]}
            repoPath={repoPath}
            commitOid={newOid}
            headOid={newOid}
            isWorkingTree={false}
            onSelectCommit={onSelectCommit}
          />
        ) : (
          <div className="detail-empty">Select a file to see its diff.</div>
        )}
      </main>
    </div>
  );
}
