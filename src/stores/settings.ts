import { create } from "zustand";
import { refreshLanePalette } from "../features/graph/palette";
import { getSettings, saveSettings } from "../ipc/commands";
import type { PersistedRecentRepo, Settings } from "../ipc/types";

/**
 * Application settings (G14), backed by a JSON file the Rust side owns.
 *
 * Three rules hold this together:
 *
 * 1. **The store is optimistic, the file is authoritative.** `set` applies the
 *    change immediately so the UI never lags a click, then writes. The write
 *    returns the *clamped* settings, which are adopted — so asking for a 200px
 *    font shows you the 20px you actually got, rather than lying until restart.
 * 2. **Writes are debounced.** A font-size slider emits a change per pixel;
 *    each one would otherwise be a file write and an IPC round trip.
 * 3. **Appearance is applied by attribute, not by inline style.** `data-theme`
 *    and `data-density` on the root element let `theme.css` hold every value,
 *    which is what keeps the token sets in one readable place instead of
 *    smeared across components.
 */

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  density: "normal",
  fontSize: 13,
  dateStyle: "relative",
  diffMode: "inline",
  diffIgnoreWhitespace: false,
  diffWordWrap: false,
  diffTabWidth: 4,
  defaultCloneDir: null,
  autoFetchMinutes: 1,
  cherryPickAppendOrigin: false,
  historyFollowRenames: true,
  blameHeatmap: true,
  graphColumns: ["author", "date", "sha"],
  graphRefInlineCount: 2,
  terminalFontSize: 12,
  terminalShell: null,
  keybindings: {},
  sidebarWidth: 240,
  detailWidth: 420,
  recentRepos: [],
};

/** Push the appearance settings at the document. Exported for tests. */
export function applyAppearance(settings: Settings): void {
  const root = document.documentElement;
  // "system" is the *absence* of an override, so `prefers-color-scheme` can
  // decide. Writing `data-theme="system"` would need a third branch in every
  // themed rule.
  if (settings.theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", settings.theme);

  root.setAttribute("data-density", settings.density);
  root.style.setProperty("--font-ui-size", `${settings.fontSize}px`);
  // Diff presentation is CSS: `diff.css` reads both, so no component has to
  // thread them down to every rendered line.
  root.style.setProperty("--diff-tab-size", String(settings.diffTabWidth));
  root.toggleAttribute("data-diff-wrap", settings.diffWordWrap);

  // The lane ring is read from these tokens and cached, because the canvas
  // asks for a colour per edge per frame. A theme change has to drop it, or
  // the graph keeps the old theme's lanes until something else forces a read.
  refreshLanePalette();
}

/**
 * Mark the platform on the root element.
 *
 * Not a setting — it cannot change while the app is running — but it is a root
 * attribute that CSS keys off, and root attributes are written here so
 * `theme.css` and its neighbours can keep every value in one readable place.
 * `tabs.css` uses it to reserve the macOS traffic-light gutter, which only
 * exists on the platform whose titlebar the tab strip replaces.
 *
 * `navigator.userAgent` rather than `@tauri-apps/plugin-os`: the question is
 * which chrome this window was given, the user agent answers it synchronously
 * on the first frame, and a plugin would cost a JS package, a Rust crate, a
 * `lib.rs` registration and a capability entry to answer it a round trip
 * later — which is a frame of the tab strip drawn under the traffic lights.
 * `lib/keys.ts` and `Sidebar.tsx` already choose their modifier labels the
 * same way.
 *
 * Called from `main.tsx` rather than from `applyAppearance`, which does not
 * run until the settings file has been read.
 */
export function applyPlatform(): void {
  document.documentElement.setAttribute(
    "data-platform",
    /mac/i.test(navigator.userAgent) ? "macos" : "other",
  );
}

/**
 * Raising the settings screen from outside the shell — the toolbar gear, the
 * command palette, the cheat sheet's footer. An event rather than a store
 * flag: the panel is the shell's own state, and a second copy of "is settings
 * open" is a second thing to keep in sync.
 */
export const OPEN_SETTINGS_EVENT = "mtgit-open-settings";

export function openSettings(): void {
  window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT));
}

interface SettingsState {
  settings: Settings;
  /** False until the file has been read; the UI renders defaults meanwhile. */
  loaded: boolean;
  load: () => Promise<void>;
  set: (patch: Partial<Settings>) => void;
  reset: () => void;
}

const SAVE_DELAY_MS = 250;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
// Identifies the write in flight. A slow write must not adopt its own answer
// over a change the user made while it was running, and the timer handle
// cannot say so: it is cleared as the write starts, so testing it would
// discard *every* result.
let saveToken = 0;

export const useSettings = create<SettingsState>((set, get) => {
  function schedule() {
    clearTimeout(saveTimer);
    const token = ++saveToken;
    saveTimer = setTimeout(() => {
      void saveSettings(get().settings)
        .then((stored) => {
          if (token !== saveToken) return;
          // Adopt the clamped values: asking for a 200px font and being shown
          // 200px until restart is a lie the user finds out about later.
          set({ settings: stored });
          applyAppearance(stored);
        })
        .catch(() => {
          /* A settings write that fails must not break the session. */
        });
    }, SAVE_DELAY_MS);
  }

  return {
    settings: DEFAULT_SETTINGS,
    loaded: false,

    load: async () => {
      try {
        const settings = await getSettings();
        set({ settings, loaded: true });
        applyAppearance(settings);
      } catch {
        // No settings file and no backend is still a usable app.
        set({ loaded: true });
        applyAppearance(get().settings);
      }
    },

    set: (patch) => {
      const settings = { ...get().settings, ...patch };
      set({ settings });
      applyAppearance(settings);
      schedule();
    },

    reset: () => {
      // `recentRepos` is not a preference — resetting appearance must not
      // forget every repository the user has ever opened.
      get().set({ ...DEFAULT_SETTINGS, recentRepos: get().settings.recentRepos });
    },
  };
});

/** Read one setting without subscribing. */
export function settings(): Settings {
  return useSettings.getState().settings;
}

/**
 * Mirror the recent-repo list into the settings file.
 *
 * `stores/session` stays the single writer and keeps its `localStorage` copy:
 * that one is synchronous, so the start screen draws on the first frame
 * instead of after an IPC round trip. This is the durable half — it survives a
 * cleared WebView, and it is what a user copying `settings.json` to a new
 * machine expects to bring with them.
 */
export function persistRecentRepos(recent: PersistedRecentRepo[]): void {
  if (!useSettings.getState().loaded) return;
  useSettings.getState().set({ recentRepos: recent });
}

/**
 * The recent list to boot from: the settings file's, when `localStorage` has
 * none. Returns null when there is nothing to restore, so the caller can leave
 * its own list alone rather than overwriting it with an empty one.
 */
export function restorableRecentRepos(current: PersistedRecentRepo[]): PersistedRecentRepo[] | null {
  if (current.length) return null;
  const stored = useSettings.getState().settings.recentRepos;
  return stored.length ? stored : null;
}
