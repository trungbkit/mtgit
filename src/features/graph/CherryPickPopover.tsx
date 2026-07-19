import { useState } from "react";
import { cherryPickMany } from "../../ipc/commands";
import { useConflict } from "../../stores/conflict";
import { toastError, useToasts } from "../../stores/toasts";
import "./cherry-pick.css";

export function CherryPickPopover({
  repoPath,
  branch,
  oids,
  parents,
  onClose,
}: {
  repoPath: string;
  branch: string;
  oids: string[];
  parents: string[];
  onClose: () => void;
}) {
  const [commitImmediately, setCommitImmediately] = useState(true);
  const [mainline, setMainline] = useState(parents.length > 1 ? 1 : undefined);
  const pushToast = useToasts((state) => state.push);

  async function run() {
    try {
      const result = await cherryPickMany(repoPath, oids, commitImmediately, mainline);
      if (result.success) {
        pushToast(
          "success",
          commitImmediately
            ? `Cherry-picked ${oids.length} commit${oids.length === 1 ? "" : "s"} onto ${branch}.`
            : `Applied ${oids.length} commit${oids.length === 1 ? "" : "s"} to the index.`,
        );
        onClose();
      } else if (result.conflicts.length) {
        useConflict.getState().set({
          repoPath,
          kind: "cherryPick",
          files: result.conflicts,
          currentSha: oids[0],
          current: 1,
          total: oids.length,
          canSkip: true,
        });
        pushToast("error", `Cherry-pick paused — ${result.conflicts.length} conflicted file(s).`);
        onClose();
      } else {
        pushToast("error", result.output || "Cherry-pick failed.");
      }
    } catch (error) {
      toastError(error);
    }
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
