import { listen } from "@tauri-apps/api/event";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { getStatus, gitAvailable, listRefs } from "../../ipc/commands";
import { useSession } from "../../stores/session";
import "./statusbar.css";

export function StatusBar() {
  const repo = useSession((s) => s.repo);
  const sidebarCollapsed = useSession((s) => s.sidebarCollapsed);
  const toggleSidebar = useSession((s) => s.toggleSidebar);
  const terminalOpen = useSession((s) => s.terminalOpen);
  const toggleTerminal = useSession((s) => s.toggleTerminal);

  const [progress, setProgress] = useState<string | null>(null);
  const clearTimer = useRef<number | undefined>(undefined);

  const { data: hasGit } = useQuery({ queryKey: ["gitAvailable"], queryFn: gitAvailable });
  const { data: status } = useQuery({
    queryKey: ["status", repo?.path],
    enabled: !!repo,
    queryFn: () => getStatus(repo!.path),
  });
  const { data: refs } = useQuery({
    queryKey: ["refs", repo?.path],
    enabled: !!repo,
    queryFn: () => listRefs(repo!.path),
  });

  useEffect(() => {
    const unlisten = listen<{ op: string; line: string }>("git-progress", (e) => {
      setProgress(`${e.payload.op}: ${e.payload.line}`);
      window.clearTimeout(clearTimer.current);
      clearTimer.current = window.setTimeout(() => setProgress(null), 4000);
    });
    return () => {
      unlisten.then((fn) => fn());
      window.clearTimeout(clearTimer.current);
    };
  }, []);

  const head = repo?.head.branch;
  const current = refs?.local.find((b) => b.isHead);
  const dirty =
    (status?.staged.length ?? 0) + (status?.unstaged.length ?? 0) + (status?.conflicted.length ?? 0);

  return (
    <footer className="statusbar">
      <div className="sb-left">
        {repo ? (
          <>
            <span className="sb-branch">⎇ {head ?? (repo.head.detached ? "detached" : "—")}</span>
            <span className={`sb-clean${dirty ? " dirty" : ""}`}>
              {dirty ? `${dirty} uncommitted` : "clean"}
            </span>
            {current && (current.ahead || current.behind) ? (
              <span className="sb-ab">
                {current.ahead ? `↑${current.ahead}` : ""} {current.behind ? `↓${current.behind}` : ""}
              </span>
            ) : null}
          </>
        ) : (
          <span className="sb-branch">No repository</span>
        )}
      </div>

      <div className="sb-center">{progress}</div>

      <div className="sb-right">
        {hasGit === false && <span className="sb-warn" title="System git not found on PATH">⚠ git missing</span>}
        <button
          className={`sb-icon${!sidebarCollapsed ? " on" : ""}`}
          title="Toggle sidebar"
          onClick={toggleSidebar}
        >
          ▤
        </button>
        <button
          className={`sb-icon${terminalOpen ? " on" : ""}`}
          title="Toggle terminal"
          disabled={!repo}
          onClick={() => repo && toggleTerminal()}
        >
          ▁
        </button>
        <span className="sb-zoom">100%</span>
        <span className="sb-git-dot" title={hasGit ? "git available" : "git missing"} data-ok={!!hasGit} />
        <span className="sb-version">{__APP_VERSION__}</span>
      </div>
    </footer>
  );
}
