import { useCallback, useEffect, useRef, useState } from "react";
import { Toolbar } from "../features/toolbar/Toolbar";
import { TabBar } from "../features/tabs/TabBar";
import { Sidebar } from "../features/sidebar/Sidebar";
import { GraphView } from "../features/graph/GraphView";
import { DetailPanel } from "../features/commit-detail/DetailPanel";
import { TerminalPanel } from "../features/terminal/TerminalPanel";
import { CommandPalette } from "../features/palette/CommandPalette";
import { StatusBar } from "../features/statusbar/StatusBar";
import { ToastContainer } from "../components/ToastContainer";
import { ConflictBanner } from "../components/ConflictBanner";
import { DialogHost } from "../components/DialogHost";
import { useRepoEvents } from "../ipc/events";
import { useSession } from "../stores/session";
import "./app.css";

export function App() {
  const [sidebarW, setSidebarW] = useState(240);
  const [detailW, setDetailW] = useState(420);
  const terminalOpen = useSession((s) => s.terminalOpen);
  const repo = useSession((s) => s.repo);
  const sidebarCollapsed = useSession((s) => s.sidebarCollapsed);
  const setPaletteOpen = useSession((s) => s.setPaletteOpen);
  const toggleTerminal = useSession((s) => s.toggleTerminal);

  useRepoEvents();

  // Global shortcuts: ⌘K palette, ⌘` terminal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "`") {
        e.preventDefault();
        if (repo) toggleTerminal();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [repo, setPaletteOpen, toggleTerminal]);

  return (
    <div className="app">
      <Toolbar />
      <TabBar />
      <ConflictBanner />
      <div className="app-body">
        <div style={{ width: sidebarCollapsed ? 44 : sidebarW, flexShrink: 0 }}>
          <Sidebar />
        </div>
        {!sidebarCollapsed && <Divider onDrag={(dx) => setSidebarW((w) => clamp(w + dx, 160, 480))} />}
        <div className="app-main">
          <GraphView />
          {terminalOpen && repo && <TerminalPanel />}
        </div>
        <Divider onDrag={(dx) => setDetailW((w) => clamp(w - dx, 280, 680))} />
        <div style={{ width: detailW, flexShrink: 0 }}>
          <DetailPanel />
        </div>
      </div>
      <StatusBar />
      <CommandPalette />
      <ToastContainer />
      <DialogHost />
    </div>
  );
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function Divider({ onDrag }: { onDrag: (dx: number) => void }) {
  const lastX = useRef(0);
  const [active, setActive] = useState(false);

  const onMove = useCallback(
    (e: MouseEvent) => {
      onDrag(e.clientX - lastX.current);
      lastX.current = e.clientX;
    },
    [onDrag],
  );

  const stop = useCallback(() => {
    setActive(false);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", stop);
    document.body.style.cursor = "";
  }, [onMove]);

  const start = (e: React.MouseEvent) => {
    lastX.current = e.clientX;
    setActive(true);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", stop);
    document.body.style.cursor = "col-resize";
  };

  return <div className={`divider${active ? " active" : ""}`} onMouseDown={start} />;
}
