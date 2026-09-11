import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { cancelGitNetwork, cloneRepo } from "../../ipc/commands";
import type { RepoInfo } from "../../ipc/types";
import { joinPath, parseProgress, repoNameFromUrl, validateCloneUrl } from "../../lib/cloneurl";
import { settings } from "../../stores/settings";
import { toastError, useToasts } from "../../stores/toasts";
import "./start.css";

const LAST_DIR_KEY = "mtgit.cloneParentDir";

/**
 * The clone form (G1).
 *
 * Not a `choiceDialog` / `promptDialog`: those take one value, and clone takes
 * five plus a live progress bar. The generic dialog host stays for one-value
 * questions.
 */
export function CloneDialog({ onClose, onCloned }: { onClose: () => void; onCloned: (repo: RepoInfo) => void }) {
  const [url, setUrl] = useState("");
  // The configured default wins; the last directory used is the fallback,
  // which is the behaviour there was before the setting existed.
  const [parent, setParent] = useState(
    () => settings().defaultCloneDir || localStorage.getItem(LAST_DIR_KEY) || "",
  );
  const [folder, setFolder] = useState("");
  // The folder name follows the URL until the user types one, and then stops:
  // overwriting a name they chose is the more annoying failure of the two.
  const [folderTouched, setFolderTouched] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [recurse, setRecurse] = useState(false);
  const [depth, setDepth] = useState("");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ phase: string; percent: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const pushToast = useToasts((s) => s.push);

  useEffect(() => urlRef.current?.focus(), []);

  const effectiveFolder = folderTouched ? folder : repoNameFromUrl(url);
  const dest = joinPath(parent, effectiveFolder);
  const urlError = url.trim() ? validateCloneUrl(url) : null;
  const depthError = depth.trim() && !/^\d+$/.test(depth.trim()) ? "Depth must be a whole number." : null;
  const ready = !!url.trim() && !urlError && !!parent && !!effectiveFolder && !depthError;

  // Attached on mount rather than on `busy`: the first "Cloning into…" lines
  // arrive before an effect keyed on `busy` could have subscribed.
  useEffect(() => {
    const unlisten = listen<{ op: string; line: string }>("git-progress", (event) => {
      if (event.payload.op !== "clone") return;
      const parsed = parseProgress(event.payload.line);
      if (parsed) setProgress(parsed);
      else if (event.payload.line.trim()) setNote(event.payload.line.trim());
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  async function pickParent() {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "Where to clone",
        defaultPath: parent || undefined,
      });
      if (typeof selected === "string") setParent(selected);
    } catch (e) {
      toastError(e);
    }
  }

  async function start() {
    if (!ready || busy) return;
    setBusy(true);
    setProgress(null);
    setNote(null);
    try {
      const repo = await cloneRepo(url.trim(), dest, {
        recurseSubmodules: recurse,
        depth: depth.trim() ? Number(depth.trim()) : undefined,
        branch: branch.trim() || undefined,
      });
      localStorage.setItem(LAST_DIR_KEY, parent);
      pushToast("success", `Cloned ${repo.name}`);
      onCloned(repo);
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  }

  function cancel() {
    if (!busy) return onClose();
    // The backend registered the clone's PID under its destination path, so
    // the existing network-cancel path reaches it unchanged.
    cancelGitNetwork(dest)
      .then(() => setNote("Cancelling…"))
      .catch(toastError);
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <div
        className="modal clone-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Clone a repository"
        onKeyDown={(e) => {
          if (e.key === "Escape") cancel();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start();
        }}
      >
        <h2>Clone a repository</h2>

        <label className="field">
          <span>Repository URL</span>
          <input
            ref={urlRef}
            value={url}
            disabled={busy}
            placeholder="https://github.com/org/repo.git"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.metaKey && !e.ctrlKey && ready && start()}
          />
        </label>
        {urlError && <div className="field-error">{urlError}</div>}

        <div className="field-row">
          <label className="field grow">
            <span>Clone into</span>
            <input value={parent} disabled={busy} placeholder="Choose a folder…" onChange={(e) => setParent(e.target.value)} />
          </label>
          <button disabled={busy} onClick={pickParent}>
            Browse…
          </button>
        </div>

        <label className="field">
          <span>Folder name</span>
          <input
            value={effectiveFolder}
            disabled={busy}
            placeholder="repo"
            onChange={(e) => {
              setFolderTouched(true);
              setFolder(e.target.value);
            }}
          />
        </label>

        {dest && <div className="clone-dest">Will create {dest}</div>}

        <button className="link-btn" disabled={busy} onClick={() => setAdvanced((a) => !a)}>
          {advanced ? "▾" : "▸"} Advanced
        </button>
        {advanced && (
          <div className="clone-advanced">
            <label className="check">
              <input type="checkbox" checked={recurse} disabled={busy} onChange={(e) => setRecurse(e.target.checked)} />
              Clone submodules recursively
            </label>
            <div className="field-row">
              <label className="field">
                <span>Shallow depth</span>
                <input
                  value={depth}
                  disabled={busy}
                  placeholder="full history"
                  inputMode="numeric"
                  onChange={(e) => setDepth(e.target.value)}
                />
              </label>
              <label className="field">
                <span>Branch</span>
                <input
                  value={branch}
                  disabled={busy}
                  placeholder="default branch"
                  onChange={(e) => setBranch(e.target.value)}
                />
              </label>
            </div>
            {depthError && <div className="field-error">{depthError}</div>}
            <div className="hint">
              git ignores a shallow depth when the source is a plain local path — use a <code>file://</code> URL there.
            </div>
          </div>
        )}

        {busy && (
          <div className="clone-progress">
            <div className="bar">
              <div className="bar-fill" style={{ width: `${progress?.percent ?? 0}%` }} />
            </div>
            <div className="clone-progress-text">
              {progress ? `${progress.phase} ${progress.percent}%` : (note ?? "Starting…")}
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button onClick={cancel}>{busy ? "Cancel clone" : "Cancel"}</button>
          <button className="primary" disabled={!ready || busy} onClick={start}>
            {busy ? "Cloning…" : "Clone"}
          </button>
        </div>
      </div>
    </div>
  );
}
