import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { gitAvailable, gitNetwork, openRepo } from "../../ipc/commands";
import { useSession } from "../../stores/session";
import { toastError, useToasts } from "../../stores/toasts";
import "./toolbar.css";

export function Toolbar() {
  const repo = useSession((s) => s.repo);
  const setRepo = useSession((s) => s.setRepo);
  const recentRepos = useSession((s) => s.recentRepos);
  const toggleTerminal = useSession((s) => s.toggleTerminal);
  const setPaletteOpen = useSession((s) => s.setPaletteOpen);
  const qc = useQueryClient();
  const pushToast = useToasts((s) => s.push);

  const [busy, setBusy] = useState(false);
  const [showRecent, setShowRecent] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  const { data: hasGit } = useQuery({ queryKey: ["gitAvailable"], queryFn: gitAvailable });

  useEffect(() => {
    const unlisten = listen<{ op: string; line: string }>("git-progress", (e) => {
      setProgress(`${e.payload.op}: ${e.payload.line}`);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  async function load(path: string) {
    setBusy(true);
    try {
      setRepo(await openRepo(path));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
      setShowRecent(false);
    }
  }

  async function pick() {
    const selected = await openDialog({ directory: true, multiple: false, title: "Open repository" });
    if (typeof selected === "string") await load(selected);
  }

  async function net(op: "fetch" | "pull" | "push") {
    if (!repo) return;
    setProgress(`${op}…`);
    try {
      const res = await gitNetwork(repo.path, op);
      if (res.success) {
        pushToast("success", `${op} complete`);
      } else {
        pushToast("error", `${op} failed: ${res.output.split("\n").pop() ?? ""}`);
      }
      qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === repo.path });
    } catch (e) {
      toastError(e);
    } finally {
      setProgress(null);
    }
  }

  return (
    <header className="toolbar">
      <div className="toolbar-brand">MTGit</div>

      <div className="toolbar-open">
        <button className="primary" onClick={pick} disabled={busy}>
          {busy ? "Opening…" : "Open"}
        </button>
        {recentRepos.length > 0 && (
          <div className="recent-wrap">
            <button onClick={() => setShowRecent((s) => !s)}>Recent ▾</button>
            {showRecent && (
              <ul className="recent-menu">
                {recentRepos.map((p) => (
                  <li key={p} onClick={() => load(p)} title={p}>
                    {p.split("/").pop()}
                    <span className="recent-path">{p}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {repo && (
        <>
          <div className="toolbar-repo">
            <span className="repo-name">{repo.name}</span>
            <span className="branch-chip">
              ⎇ {repo.head.branch ?? (repo.head.detached ? "detached" : "—")}
            </span>
          </div>
          <div className="net-buttons">
            <button onClick={() => net("fetch")} disabled={!hasGit}>Fetch</button>
            <button onClick={() => net("pull")} disabled={!hasGit}>Pull</button>
            <button onClick={() => net("push")} disabled={!hasGit}>Push</button>
          </div>
        </>
      )}

      <div className="toolbar-progress">{progress}</div>

      <div className="toolbar-spacer" />

      {hasGit === false && <span className="git-warn" title="System git not found on PATH">⚠ git missing</span>}
      <button title="Command palette (⌘K)" onClick={() => setPaletteOpen(true)}>⌘K</button>
      {repo && <button title="Terminal" onClick={toggleTerminal}>▁</button>}
      {repo && (
        <button
          title="Refresh"
          onClick={() => qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === repo.path })}
        >
          ↻
        </button>
      )}
    </header>
  );
}
