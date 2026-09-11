import { listen } from "@tauri-apps/api/event";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Terminal, type ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  listRefs,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
  resolveTerminalTokens,
} from "../../ipc/commands";
import { findCandidates } from "../../lib/terminalLinks";
import { revealCommit } from "../../stores/reveal";
import { useSession } from "../../stores/session";
import "./terminal.css";

export function TerminalPanel() {
  const repo = useSession((s) => s.repo);
  const toggleTerminal = useSession((s) => s.toggleTerminal);
  const containerRef = useRef<HTMLDivElement>(null);

  // Ref names are matched literally against terminal output, so the link
  // provider needs the live set. Read through a ref, not a dependency: the
  // terminal is torn down and respawned by the effect below, and a ref list
  // that changes on every fetch must not kill the user's shell.
  const { data: refs } = useQuery({
    queryKey: ["refs", repo?.path],
    enabled: !!repo?.path,
    queryFn: () => listRefs(repo!.path),
  });
  const refNames = useRef<string[]>([]);
  refNames.current = [
    ...(refs?.local ?? []).map((b) => b.name),
    ...(refs?.remote ?? []).map((b) => b.name),
    ...(refs?.tags ?? []).map((t) => t.name),
  ];

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

    /**
     * Terminal links (G19): a sha, branch, tag or `a..b` printed by any
     * command becomes a click that reveals it in the graph.
     *
     * xterm asks for links per line on hover, so the backend round-trip
     * happens at most once per line the mouse passes over — cheap enough to
     * do live, and the only way the decision stays with git.
     */
    const linkProvider = term.registerLinkProvider({
      provideLinks(lineNumber, callback) {
        const buffer = term.buffer.active;
        const line = buffer.getLine(buffer.viewportY + lineNumber - 1);
        const text = line?.translateToString(true) ?? "";
        const candidates = findCandidates(text, refNames.current);
        if (!candidates.length || !repo) return callback(undefined);

        resolveTerminalTokens(
          repo.path,
          candidates.map((c) => c.text),
        )
          .then((resolved) => {
            const byToken = new Map(resolved.map((r) => [r.token, r]));
            const links: ILink[] = [];
            for (const candidate of candidates) {
              // The backend trims trailing punctuation, so a candidate can
              // come back under a shorter key than it was sent as.
              const hit =
                byToken.get(candidate.text) ??
                byToken.get(candidate.text.replace(/[.,:;)\]"']+$/, ""));
              if (!hit) continue;
              links.push({
                // xterm columns are 1-based, and `end` is inclusive.
                range: {
                  start: { x: candidate.start + 1, y: lineNumber },
                  end: { x: candidate.start + hit.token.length, y: lineNumber },
                },
                text: hit.token,
                decorations: { underline: true, pointerCursor: true },
                activate: () => revealCommit(hit.oid),
              });
            }
            callback(links.length ? links : undefined);
          })
          .catch(() => callback(undefined));
      },
    });

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
      linkProvider.dispose();
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
