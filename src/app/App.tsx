import { useCallback, useEffect, useRef, useState } from "react";
import { Toolbar } from "../features/toolbar/Toolbar";
import { TabBar } from "../features/tabs/TabBar";
import { Sidebar } from "../features/sidebar/Sidebar";
import { GraphView } from "../features/graph/GraphView";
import { DetailPanel } from "../features/commit-detail/DetailPanel";
import { TerminalPanel } from "../features/terminal/TerminalPanel";
import { CommandPalette } from "../features/palette/CommandPalette";
import { StatusBar } from "../features/statusbar/StatusBar";
import { StartScreen } from "../features/start/StartScreen";
import { CloneDialog } from "../features/start/CloneDialog";
import { ToastContainer } from "../components/ToastContainer";
import { ConflictBanner } from "../components/ConflictBanner";
import { DialogHost } from "../components/DialogHost";
import { DetachedHeadBanner } from "../components/DetachedHeadBanner";
import { refreshLanePalette } from "../features/graph/palette";
import { SettingsDialog } from "../features/settings/SettingsDialog";
import { ShortcutsOverlay } from "../features/settings/ShortcutsOverlay";
import { useRepoEvents } from "../ipc/events";
import { isTypingTarget, matches } from "../lib/keys";
import { hydrateRecentRepos, useSession, WORKING } from "../stores/session";
import { OPEN_SETTINGS_EVENT, useSettings } from "../stores/settings";
import "./app.css";

export function App() {
  const [sidebarW, setSidebarW] = useState(240);
  const [detailW, setDetailW] = useState(420);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const terminalOpen = useSession((s) => s.terminalOpen);
  const repo = useSession((s) => s.repo);
  const sidebarCollapsed = useSession((s) => s.sidebarCollapsed);
  const activeStart = useSession((s) => s.activeStart);
  const cloneOpen = useSession((s) => s.cloneOpen);
  const setCloneOpen = useSession((s) => s.setCloneOpen);
  const setRepo = useSession((s) => s.setRepo);
  const setPaletteOpen = useSession((s) => s.setPaletteOpen);
  const toggleTerminal = useSession((s) => s.toggleTerminal);
  const selectOid = useSession((s) => s.selectOid);

  useRepoEvents();

  // Settings drive the theme, so they are read before anything else paints.
  useEffect(() => {
    void useSettings.getState().load().then(hydrateRecentRepos);
  }, []);

  // The OS theme can change while the app is open, and "system" has to follow
  // it. The CSS does the work; this only refreshes the lane ring, which is
  // read from the tokens and cached.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => refreshLanePalette();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  // Application-level shortcuts. The chords live in `lib/keys`, so they are
  // rebindable and appear in the cheat sheet; this only says what they do.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matches(e, "palette.open")) {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (matches(e, "terminal.toggle")) {
        e.preventDefault();
        if (repo) toggleTerminal();
      } else if (matches(e, "settings.open")) {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (matches(e, "commit.focus")) {
        // STATUS B5: the listener used to live in `StagingView`, which mounts
        // only once the WIP row is selected — so the shortcut that is supposed
        // to *get you to* the commit message only worked once you were already
        // there. Selecting WIP here mounts the view, which then focuses its
        // own field on mount.
        e.preventDefault();
        if (repo) selectOid(WORKING);
      } else if (matches(e, "help.shortcuts") && !isTypingTarget(e)) {
        // The only unmodified chord in the map, so it is also the only one
        // that has to check where the keystroke was going.
        e.preventDefault();
        setShortcutsOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [repo, selectOid, setPaletteOpen, toggleTerminal]);

  // Opening settings from anywhere (the toolbar gear, the cheat sheet).
  useEffect(() => {
    const open = () => setSettingsOpen(true);
    window.addEventListener(OPEN_SETTINGS_EVENT, open);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, open);
  }, []);

  return (
    <div className="app">
      <Toolbar />
      <TabBar />
      <ConflictBanner />
      <DetachedHeadBanner />
      {activeStart ? (
        <StartScreen />
      ) : (
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
      )}
      <StatusBar />
      {cloneOpen && <CloneDialog onClose={() => setCloneOpen(false)} onCloned={setRepo} />}
      <CommandPalette />
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {shortcutsOpen && (
        <ShortcutsOverlay
          onClose={() => setShortcutsOpen(false)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}
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
