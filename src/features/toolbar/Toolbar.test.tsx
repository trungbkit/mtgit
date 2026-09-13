import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStores } from "../../test/stores";
import { useSession } from "../../stores/session";
import type { RepoInfo } from "../../ipc/types";
import { gitAutoFetch, historyStatus, listRefs, listRemotes, stashList } from "../../ipc/commands";
import { Toolbar } from "./Toolbar";

// Replaced wholesale, so every named import the toolbar reaches for has to
// exist here or the import itself throws.
vi.mock("../../ipc/commands", () => {
  const stub = () => vi.fn();
  return {
    createBranch: stub(),
    createTag: stub(),
    clearHistory: stub(),
    gitAutoFetch: stub(),
    gitNetwork: stub(),
    historyStatus: stub(),
    listRefs: stub(),
    listRemotes: stub(),
    mergeTarget: stub(),
    openRepo: stub(),
    redo: stub(),
    setUpstream: stub(),
    stashSave: stub(),
    stashList: stub(),
    stashPop: stub(),
    undo: stub(),
    getStatus: stub(),
    operationInfo: stub(),
    getGraph: stub(),
    graphKey: stub(),
  };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const repo: RepoInfo = {
  name: "fixture",
  path: "/repo",
  head: { branch: "main", oid: "a".repeat(40), detached: false, unborn: false },
  isBare: false,
  worktree: null,
};

beforeEach(() => {
  resetStores();
  // `restoreMocks` clears every implementation between tests, so the answers
  // are given here rather than in the factory above — which runs once.
  vi.mocked(listRefs).mockResolvedValue({ local: [], remote: [], tags: [] });
  vi.mocked(listRemotes).mockResolvedValue([]);
  vi.mocked(stashList).mockResolvedValue([]);
  vi.mocked(historyStatus).mockResolvedValue({ undoLabel: null, redoLabel: null, restoredMessage: null });
  vi.mocked(gitAutoFetch).mockResolvedValue({ success: true, output: "", code: 0 });
});

function renderToolbar() {
  useSession.setState({ repo, tabs: [repo], startTab: false, activeStart: false });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Toolbar />
    </QueryClientProvider>,
  );
}

describe("the right-hand group", () => {
  /**
   * It used to hold four buttons of which two — "Actions" and "Settings" — were
   * drawn with the same `gear` glyph, so the group read as a coin flip rather
   * than a set of choices. Settings now lives at the end of the tab strip with
   * the other window-level controls, and Layout is gone: it toggled the
   * sidebar, which the status bar already does and with an on/off state this
   * group had no way to show.
   */
  it("draws no two controls with the same glyph", () => {
    const { container } = renderToolbar();
    const group = container.querySelector(".tb-right");
    expect(group).not.toBeNull();

    const glyphs = [...group!.querySelectorAll("svg.icon")].map((svg) => svg.innerHTML);
    expect(glyphs.length).toBeGreaterThan(0);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it("does not duplicate the status bar's sidebar toggle", () => {
    renderToolbar();
    expect(screen.queryByRole("button", { name: "Layout" })).toBeNull();
  });
});
