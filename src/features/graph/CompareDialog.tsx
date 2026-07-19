import { useEffect, useState } from "react";
import { compareCommits } from "../../ipc/commands";
import type { FileDiff } from "../../ipc/types";
import { toastError } from "../../stores/toasts";
import { FileViewer } from "../diff/FileViewer";
import "./compare.css";

export function CompareDialog({
  repoPath,
  oldOid,
  newOid,
  onClose,
}: {
  repoPath: string;
  oldOid: string;
  newOid: string;
  onClose: () => void;
}) {
  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    compareCommits(repoPath, oldOid, newOid).then(setDiffs).catch(toastError);
  }, [newOid, oldOid, repoPath]);

  return (
    <div className="compare-overlay" onMouseDown={onClose}>
      <div className="compare-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <strong>Compare {oldOid.slice(0, 7)} → {newOid.slice(0, 7)}</strong>
          <button onClick={onClose}>✕</button>
        </header>
        <aside>
          {diffs.map((diff, index) => (
            <button key={diff.path} className={selected === index ? "selected" : ""} onClick={() => setSelected(index)}>
              <span>{diff.status.slice(0, 1).toUpperCase()}</span>
              {diff.path}
            </button>
          ))}
        </aside>
        <main>
          {diffs[selected] ? (
            <FileViewer
              diff={diffs[selected]}
              repoPath={repoPath}
              commitOid={newOid}
              headOid={newOid}
              isWorkingTree={false}
            />
          ) : (
            <div className="detail-empty">The commits have no file differences.</div>
          )}
        </main>
      </div>
    </div>
  );
}
