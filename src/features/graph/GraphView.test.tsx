import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { resetStores } from "../../test/stores";
import { useSession } from "../../stores/session";
import type { GraphPage, RepoInfo } from "../../ipc/types";
import { getGraph, getRemoteUrl, getStatus, wipRows } from "../../ipc/commands";

// Everything `GraphView` (and the `SearchBar` it renders) reaches for. The
// module is replaced wholesale, so every named import has to exist here or the
// import itself throws.
vi.mock("../../ipc/commands", () => {
  const stub = () => vi.fn().mockResolvedValue(null);
  return {
    getGraph: vi.fn(),
    getStatus: vi.fn(),
    wipRows: vi.fn(),
    getRemoteUrl: vi.fn(),
    commitStats: stub(),
    listRefs: stub(),
    listContributors: stub(),
    completePaths: stub(),
    containingRefs: stub(),
    searchCommits: stub(),
    cancelSearch: stub(),
    createBranch: stub(),
    deleteBranch: stub(),
    deleteTag: stub(),
    gitNetwork: stub(),
    renameBranch: stub(),
    createPatch: stub(),
    createTag: stub(),
    createWorktree: stub(),
    openRepo: stub(),
    worktreeHolding: stub(),
    mergeAdvanced: stub(),
    mergeRelation: stub(),
    rebaseStandard: stub(),
    rewriteInfo: stub(),
    resetTo: stub(),
    revertCommit: stub(),
  };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));

// jsdom lays nothing out, so the real virtualizer measures a zero-height
// scroller and returns no rows — which would let the assertion below pass
// against a component that rendered nothing at all.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 28, size: 28 })),
    scrollToIndex: vi.fn(),
  }),
}));

const mockGetGraph = vi.mocked(getGraph);

const repo: RepoInfo = {
  name: "fixture",
  path: "/repo",
  head: { branch: "main", oid: "a".repeat(40), detached: false, unborn: false },
  isBare: false,
  worktree: null,
};

function page(): GraphPage {
  return {
    total: 1,
    head: "a".repeat(40),
    rows: [
      {
        oid: "a".repeat(40),
        parents: [],
        summary: "initial commit",
        author: "Ada L",
        email: "ada@example.com",
        timestamp: 1_700_000_000,
        lane: 0,
        color: 0,
        edges: [],
        refs: [{ name: "main", kind: "localBranch", isHead: true }],
        unpushed: false,
        unpulled: false,
      },
    ],
  };
}

async function mount() {
  const { GraphView } = await import("./GraphView");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <GraphView />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  resetStores();
  vi.clearAllMocks();
  useSession.setState({ repo });
  // Set after `clearAllMocks`, which strips the factory's own resolutions —
  // a query resolving `undefined` is a react-query warning, not a failure, so
  // it would otherwise sit in the output unexplained.
  vi.mocked(getStatus).mockResolvedValue({
    staged: [],
    unstaged: [],
    conflicted: [],
    isDirty: false,
  });
  vi.mocked(wipRows).mockResolvedValue([]);
  vi.mocked(getRemoteUrl).mockResolvedValue(null);
  // jsdom has no canvas backend; the lane painter asks for one every frame.
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
});

describe("opening a repository", () => {
  /**
   * The render that crashed the app: `isPending` returns early, so the *first*
   * render runs fewer hooks than the second. Any hook declared below those
   * returns makes React throw "rendered more hooks than during the previous
   * render", and every repository open goes through this transition.
   */
  it("survives the pending-to-loaded transition without changing its hook count", async () => {
    let resolvePage: (value: GraphPage) => void = () => {};
    mockGetGraph.mockReturnValue(new Promise<GraphPage>((resolve) => (resolvePage = resolve)));

    await mount();
    expect(await screen.findByText("Loading history…")).toBeInTheDocument();

    resolvePage(page());
    expect(await screen.findByText("initial commit")).toBeInTheDocument();
  });

  it("renders the row's ref pill once history arrives", async () => {
    mockGetGraph.mockResolvedValue(page());
    await mount();
    expect(await screen.findByText("main")).toBeInTheDocument();
  });
});
