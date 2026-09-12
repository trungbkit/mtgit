import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { runCherryPick } from "../../lib/cherryPick";
import "./cherry-pick.css";

export function CherryPickPopover({
  repoPath,
  branch,
  oids,
  parents,
  onPicked,
  onClose,
}: {
  repoPath: string;
  branch: string;
  oids: string[];
  parents: string[];
  /** The commits that were picked, so the graph can flash their source rows. */
  onPicked: (oids: string[]) => void;
  onClose: () => void;
}) {
  const [commitImmediately, setCommitImmediately] = useState(true);
  const [mainline, setMainline] = useState(parents.length > 1 ? 1 : undefined);
  const qc = useQueryClient();

  async function run() {
    const done = await runCherryPick({
      repoPath,
      oids,
      branch,
      commitImmediately,
      mainline,
      qc,
      onPicked,
    });
    if (done) onClose();
  }

  return (
    <div className="pick-overlay" onMouseDown={onClose}>
      <div className="pick-popover" onMouseDown={(event) => event.stopPropagation()}>
        <h3>Cherry-pick {oids.length === 1 ? oids[0].slice(0, 7) : `${oids.length} commits`}?</h3>
        <p>
          Apply onto <strong>{branch}</strong>. Multiple commits are applied oldest to newest.
        </p>
        {parents.length > 1 && (
          <fieldset>
            <legend>Mainline parent</legend>
            {parents.map((parent, index) => (
              <label key={parent}>
                <input
                  type="radio"
                  checked={mainline === index + 1}
                  onChange={() => setMainline(index + 1)}
                />
                Parent {index + 1} ({parent.slice(0, 7)})
              </label>
            ))}
          </fieldset>
        )}
        <label className="pick-checkbox">
          <input
            type="checkbox"
            checked={commitImmediately}
            onChange={(event) => setCommitImmediately(event.target.checked)}
          />
          Commit immediately
        </label>
        <div className="pick-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={run}>Cherry-pick</button>
        </div>
      </div>
    </div>
  );
}
