import { useState } from "react";
import type { RemoteInfo } from "../../ipc/types";
import { validateRefName } from "../../lib/refname";
import "./publish.css";

/**
 * The publish form (`03-push.md` B2, STATUS C1).
 *
 * A first push had been a yes/no confirm, which quietly decided three things
 * for the user: which remote, what the branch is called there, and whether to
 * track it. All three are choices people actually make — a fork workflow
 * pushes to `fork`, and `feature/x` is often `pr/feature-x` on the remote.
 * The generic dialog host takes one value, so this is its own form, with
 * `features/start/CloneDialog.tsx` as the precedent.
 */
export function PublishDialog({
  branch,
  remotes,
  defaultRemote,
  onCancel,
  onPublish,
}: {
  branch: string;
  remotes: RemoteInfo[];
  defaultRemote: string;
  onCancel: () => void;
  onPublish: (choice: { remote: string; remoteBranch: string; setUpstream: boolean }) => void;
}) {
  const [remote, setRemote] = useState(defaultRemote);
  const [remoteBranch, setRemoteBranch] = useState(branch);
  const [setUpstream, setSetUpstream] = useState(true);

  const nameError = remoteBranch.trim() ? validateRefName(remoteBranch.trim()) : "Enter a branch name.";

  return (
    <div className="publish-overlay" onMouseDown={onCancel}>
      <form
        className="publish-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (nameError) return;
          onPublish({ remote, remoteBranch: remoteBranch.trim(), setUpstream });
        }}
      >
        <header>
          <h2>Publish branch</h2>
          <p>
            <code>{branch}</code> has no upstream yet.
          </p>
        </header>

        <label>
          <span>Remote</span>
          <select value={remote} onChange={(event) => setRemote(event.target.value)}>
            {remotes.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
                {r.url ? ` — ${r.url}` : ""}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Branch name on the remote</span>
          <input
            autoFocus
            value={remoteBranch}
            onChange={(event) => setRemoteBranch(event.target.value)}
            placeholder={branch}
            spellCheck={false}
          />
        </label>
        {nameError && <div className="publish-error">{nameError}</div>}

        <label className="publish-check">
          <input
            type="checkbox"
            checked={setUpstream}
            onChange={(event) => setSetUpstream(event.target.checked)}
          />
          <span>
            Track this branch
            <em>
              Later pushes and pulls go to {remote}/{remoteBranch.trim() || branch} without asking.
            </em>
          </span>
        </label>

        <footer>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!!nameError}>
            Push to {remote}
          </button>
        </footer>
      </form>
    </div>
  );
}
