import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStores } from "../test/stores";
import { getSettings, saveSettings } from "../ipc/commands";
import type { Settings } from "../ipc/types";
import {
  DEFAULT_SETTINGS,
  applyAppearance,
  persistRecentRepos,
  restorableRecentRepos,
  useSettings,
} from "./settings";

vi.mock("../ipc/commands", () => ({ getSettings: vi.fn(), saveSettings: vi.fn() }));

const mockGet = vi.mocked(getSettings);
const mockSave = vi.mocked(saveSettings);

function settings(over: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...over };
}

const root = () => document.documentElement;

beforeEach(() => {
  resetStores();
  mockGet.mockReset().mockResolvedValue(settings());
  mockSave.mockReset().mockImplementation(async (s) => s);
  root().removeAttribute("data-theme");
  root().removeAttribute("data-density");
  root().removeAttribute("data-diff-wrap");
  root().removeAttribute("style");
  vi.useRealTimers();
});

describe("applyAppearance", () => {
  it("writes no data-theme for “system”, so prefers-color-scheme decides", () => {
    applyAppearance(settings({ theme: "system" }));
    expect(root().hasAttribute("data-theme")).toBe(false);
  });

  it("writes an explicit theme, which must win over the OS in both directions", () => {
    applyAppearance(settings({ theme: "light" }));
    expect(root().getAttribute("data-theme")).toBe("light");
    applyAppearance(settings({ theme: "dark" }));
    expect(root().getAttribute("data-theme")).toBe("dark");
    applyAppearance(settings({ theme: "system" }));
    expect(root().hasAttribute("data-theme")).toBe(false);
  });

  it("drives density, font size and diff presentation from the same place", () => {
    applyAppearance(settings({ density: "compact", fontSize: 15, diffTabWidth: 2, diffWordWrap: true }));
    expect(root().getAttribute("data-density")).toBe("compact");
    expect(root().style.getPropertyValue("--font-ui-size")).toBe("15px");
    expect(root().style.getPropertyValue("--diff-tab-size")).toBe("2");
    expect(root().hasAttribute("data-diff-wrap")).toBe(true);

    applyAppearance(settings({ diffWordWrap: false }));
    expect(root().hasAttribute("data-diff-wrap")).toBe(false);
  });
});

describe("load", () => {
  it("adopts the file and applies it", async () => {
    mockGet.mockResolvedValue(settings({ theme: "light", density: "comfortable" }));
    await useSettings.getState().load();
    expect(useSettings.getState().settings.theme).toBe("light");
    expect(useSettings.getState().loaded).toBe(true);
    expect(root().getAttribute("data-density")).toBe("comfortable");
  });

  it("still starts, with defaults applied, when the file cannot be read", async () => {
    // No settings file and no backend is still a usable app — and it must not
    // be an *unstyled* one, so the defaults are applied rather than skipped.
    mockGet.mockRejectedValue(new Error("no config directory"));
    await useSettings.getState().load();
    expect(useSettings.getState().settings).toEqual(DEFAULT_SETTINGS);
    expect(useSettings.getState().loaded).toBe(true);
    expect(root().getAttribute("data-density")).toBe("normal");
  });
});

describe("set", () => {
  it("applies immediately, so no control waits on a file write", () => {
    useSettings.getState().set({ theme: "dark" });
    expect(useSettings.getState().settings.theme).toBe("dark");
    expect(root().getAttribute("data-theme")).toBe("dark");
  });

  it("merges rather than replacing", () => {
    useSettings.getState().set({ theme: "dark" });
    useSettings.getState().set({ fontSize: 16 });
    expect(useSettings.getState().settings).toMatchObject({ theme: "dark", fontSize: 16 });
  });

  it("writes once for a burst of changes", async () => {
    vi.useFakeTimers();
    for (let size = 10; size <= 20; size++) useSettings.getState().set({ fontSize: size });
    expect(mockSave).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(mockSave).toHaveBeenCalledOnce();
    expect(mockSave.mock.calls[0][0].fontSize).toBe(20);
  });

  it("adopts the clamped values the backend actually stored", async () => {
    // Asking for a 200px font and being shown 200px until restart is a lie the
    // user only finds out about later.
    vi.useFakeTimers();
    mockSave.mockImplementation(async (s) => ({ ...s, fontSize: 20 }));
    useSettings.getState().set({ fontSize: 200 });
    await vi.advanceTimersByTimeAsync(300);
    expect(useSettings.getState().settings.fontSize).toBe(20);
  });

  it("survives a failed write without breaking the session", async () => {
    vi.useFakeTimers();
    mockSave.mockRejectedValue(new Error("disk full"));
    useSettings.getState().set({ theme: "light" });
    await vi.advanceTimersByTimeAsync(300);
    expect(useSettings.getState().settings.theme).toBe("light");
  });
});

describe("reset", () => {
  it("restores the defaults but keeps the recent-repo list", () => {
    // Resetting appearance must not forget every repository ever opened.
    const recentRepos = [{ path: "/a", name: "a", lastOpened: 1, branch: "main" }];
    useSettings.getState().set({ theme: "dark", fontSize: 18, recentRepos });
    useSettings.getState().reset();

    const after = useSettings.getState().settings;
    expect(after.theme).toBe("system");
    expect(after.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
    expect(after.recentRepos).toEqual(recentRepos);
  });
});

describe("recent repos mirroring", () => {
  const recent = [{ path: "/a", name: "a", lastOpened: 1, branch: null }];

  it("does not write before the file has been read", () => {
    // Otherwise the very first `saveRecent` would overwrite the stored list
    // with the empty one this session started from.
    persistRecentRepos(recent);
    expect(useSettings.getState().settings.recentRepos).toEqual([]);
  });

  it("mirrors once loaded", async () => {
    await useSettings.getState().load();
    persistRecentRepos(recent);
    expect(useSettings.getState().settings.recentRepos).toEqual(recent);
  });

  it("offers the stored list only when the caller has none", async () => {
    mockGet.mockResolvedValue(settings({ recentRepos: recent }));
    await useSettings.getState().load();

    expect(restorableRecentRepos([])).toEqual(recent);
    const existing = [{ path: "/b", name: "b", lastOpened: 2, branch: null }];
    expect(restorableRecentRepos(existing)).toBeNull();
  });

  it("offers nothing when the file has nothing, rather than an empty list", async () => {
    await useSettings.getState().load();
    expect(restorableRecentRepos([])).toBeNull();
  });
});
