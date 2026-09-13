import { readFileSync } from "node:fs";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStores } from "../../test/stores";
import { useSession } from "../../stores/session";
import type { BranchInfo, RepoInfo } from "../../ipc/types";
import {
  listContributors,
  listRefs,
  listRemotes,
  listSubmodules,
  listWorktrees,
  stashList,
} from "../../ipc/commands";
import { Sidebar } from "./Sidebar";

vi.mock("../../ipc/commands", () => {
  const stub = () => vi.fn();
  return {
    addRemote: stub(),
    clearHistory: stub(),
    createWorktree: stub(),
    createBranch: stub(),
    createTag: stub(),
    deleteBranch: stub(),
    deleteRemoteBranch: stub(),
    deleteTag: stub(),
    gitNetwork: stub(),
    listRefs: stub(),
    listRemotes: stub(),
    listContributors: stub(),
    listSubmodules: stub(),
    listWorktrees: stub(),
    mergeAdvanced: stub(),
    mergeRelation: stub(),
    openRepo: stub(),
    rebaseStandard: stub(),
    removeRemote: stub(),
    removeWorktree: stub(),
    renameRemote: stub(),
    rewriteInfo: stub(),
    renameBranch: stub(),
    setRemoteUrl: stub(),
    stashApply: stub(),
    stashDrop: stub(),
    stashList: stub(),
    stashPop: stub(),
    unsetUpstream: stub(),
    updateSubmodules: stub(),
    getStatus: stub(),
    operationInfo: stub(),
  };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn() }));

const repo: RepoInfo = {
  name: "fixture",
  path: "/repo",
  head: { branch: "main", oid: "a".repeat(40), detached: false, unborn: false },
  isBare: false,
  worktree: null,
};

function branch(name: string, extra: Partial<BranchInfo> = {}): BranchInfo {
  return {
    name,
    oid: "b".repeat(40),
    isHead: false,
    upstream: null,
    ahead: null,
    behind: null,
    upstreamGone: false,
    ...extra,
  };
}

beforeEach(() => {
  resetStores();
  useSession.setState({ repo, tabs: [repo], startTab: false, activeStart: false });
  // `restoreMocks` clears implementations between tests, so they are given
  // here rather than in the hoisted factory, which runs once.
  vi.mocked(listRefs).mockResolvedValue({
    local: [branch("main", { isHead: true }), branch("fix-ui", { ahead: 2, behind: 12 })],
    remote: [],
    tags: [],
  });
  vi.mocked(listRemotes).mockResolvedValue([]);
  vi.mocked(stashList).mockResolvedValue([]);
  vi.mocked(listWorktrees).mockResolvedValue([]);
  vi.mocked(listSubmodules).mockResolvedValue([]);
  vi.mocked(listContributors).mockResolvedValue([]);
});

function renderSidebar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Sidebar />
    </QueryClientProvider>,
  );
}

describe("branch rows", () => {
  it("fills the checked-out row rather than merely bolding it", async () => {
    const { container } = renderSidebar();
    await screen.findByText("main");

    const filled = container.querySelectorAll(".ref-item.head");
    expect(filled).toHaveLength(1);
    expect(filled[0]).toHaveTextContent("main");

    // The fill and the `check` glyph say it twice, which is enough. The dot
    // said it a third time and carried the tooltip, which the row now holds.
    expect(container.querySelector(".head-dot")).toBeNull();
    expect(filled[0]).toHaveAttribute("title", "HEAD: main");
  });

  it("reads ahead and behind counts count-first", async () => {
    const { container } = renderSidebar();
    await screen.findByText("fix-ui");

    const counts = container.querySelector(".ahead-behind");
    expect(counts).not.toBeNull();
    expect(within(counts as HTMLElement).getByText("2↑")).toBeInTheDocument();
    expect(within(counts as HTMLElement).getByText("12↓")).toBeInTheDocument();
  });
});

describe("the header row", () => {
  it("has no control that does nothing when pressed", async () => {
    const { container } = renderSidebar();
    await screen.findByText("main");

    // A one-segment segmented control is a label drawn as a button. The other
    // segment would have been "Agents", which is out of scope.
    expect(container.querySelector(".seg-btn")).toBeNull();
    expect(screen.getByText(/^Viewing /)).toBeInTheDocument();
  });

  it("keeps advertising the filter chord, glyph or no glyph", async () => {
    renderSidebar();
    await screen.findByText("main");

    // The placeholder is the only place this chord appears. A magnifier does
    // not advertise a keystroke.
    const field = screen.getByPlaceholderText(/^Filter \(/);
    expect(field).toBeInTheDocument();
  });
});

describe("the glyph column", () => {
  it("carries no emoji", () => {
    // Emoji render at a different weight on every platform and ignore
    // `currentColor`, so they cannot follow a theme — which is why `Icon.tsx`
    // exists. Two survived in the sidebar until the folder and lock glyphs.
    const source = readFileSync("src/features/sidebar/Sidebar.tsx", "utf8");
    expect(source).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });
});
