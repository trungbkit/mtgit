import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { cherryPickMany } from "../../ipc/commands";
import { settings } from "../../stores/settings";
import { refreshRepo, requireNoPausedOperation } from "../../ipc/repoState";
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
  const qc = useQueryClient();

  async function run() {
    try {
      await requireNoPausedOperation(repoPath, "cherry-pick");
      // `07-cherry-pick.md` B1: the `-x` trailer was plumbed all the way
      // through and then hardcoded `false` at this one call site.
      const result = await cherryPickMany(
        repoPath,
        oids,
        commitImmediately,
        mainline,
        settings().cherryPickAppendOrigin,
      );
      if (result.success) {
        pushToast(
          "success",
          commitImmediately
            ? `Cherry-picked ${oids.length} commit${oids.length === 1 ? "" : "s"} onto ${branch}.`
            : `Applied ${oids.length} commit${oids.length === 1 ? "" : "s"} to the index.`,
        );
      } else if (result.conflicts.length) {
        pushToast("error", `Cherry-pick paused — ${result.conflicts.length} conflicted file(s).`);
      } else {
        pushToast("error", result.output || "Cherry-pick failed.");
        return;
      }
      // Await before unmounting: the banner has to be up before this popover
      // closes, or the paused sequence has no visible Continue/Abort at all.
      await refreshRepo(qc, repoPath);
      onClose();
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
