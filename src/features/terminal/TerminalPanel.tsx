import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ptyKill, ptyResize, ptySpawn, ptyWrite } from "../../ipc/commands";
import { useSession } from "../../stores/session";
import "./terminal.css";

export function TerminalPanel() {
  const repo = useSession((s) => s.repo);
  const toggleTerminal = useSession((s) => s.toggleTerminal);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!repo || !containerRef.current) return;
    const container = containerRef.current;

    const term = new Terminal({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12,
      theme: { background: "#1b1f24", foreground: "#cdd9e5", cursor: "#6cb6ff" },
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    let ptyId: string | null = null;
    let disposed = false;
    let unlistenOut: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;

    (async () => {
      unlistenOut = await listen<{ id: string; data: string }>("pty-output", (e) => {
        if (e.payload.id === ptyId) term.write(e.payload.data);
      });
      unlistenExit = await listen<{ id: string }>("pty-exit", (e) => {
        if (e.payload.id === ptyId) term.writeln("\r\n[process exited]");
      });
      ptyId = await ptySpawn(repo.path, term.rows, term.cols);
      term.onData((d) => {
        if (ptyId) ptyWrite(ptyId, d).catch(() => {});
      });
    })();

    const ro = new ResizeObserver(() => {
      if (disposed) return;
      try {
        fit.fit();
        if (ptyId) ptyResize(ptyId, term.rows, term.cols).catch(() => {});
      } catch {
        /* fit can throw if detached */
      }
    });
    ro.observe(container);

    return () => {
      disposed = true;
      ro.disconnect();
      unlistenOut?.();
      unlistenExit?.();
      if (ptyId) ptyKill(ptyId).catch(() => {});
      term.dispose();
    };
  }, [repo?.path]);

  return (
    <div className="terminal-panel">
      <div className="terminal-head">
        <span>Terminal — {repo?.name}</span>
        <button onClick={toggleTerminal} title="Close">✕</button>
      </div>
      <div className="terminal-body" ref={containerRef} />
    </div>
  );
}
