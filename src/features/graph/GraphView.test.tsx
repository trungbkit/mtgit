import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

// jsdom lays nothing out, so the real virtualizer reports zero rows and every
// assertion below would pass against a component that rendered nothing. The
// stub has to carry every method `GraphView` calls — `measure` is the one the
// density change asks for, and a missing method throws at mount, not at the
// assertion.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 28, size: 28 })),
    scrollToIndex: vi.fn(),
    measure: vi.fn(),
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

/**
 * One menu per row, raised from anywhere on it.
 *
 * The graph used to answer a right-click with two different menus depending on
 * which part of the row the pointer was over: the ref pill gave branch actions,
 * everything else gave commit actions, and the author cell gave neither — it
 * ran an author search instead. Whichever one you wanted, half the row was the
 * wrong place to click.
 */
describe("the row context menu", () => {
  beforeEach(() => mockGetGraph.mockResolvedValue(page()));

  it("opens on the commit message and offers the commit's own actions", async () => {
    await mount();
    fireEvent.contextMenu(await screen.findByText("initial commit"));
    expect(await screen.findByText("Checkout this commit")).toBeInTheDocument();
    expect(screen.getByText("Create branch here…")).toBeInTheDocument();
  });

  it("opens on a ref pill too, with that ref's actions rather than only the commit's", async () => {
    await mount();
    fireEvent.contextMenu(await screen.findByText("main"));
    // The ref is a submenu of the row's menu, not a menu of its own: both
    // halves have to be reachable from the one gesture.
    expect(await screen.findByText("Branch main (checked out)")).toBeInTheDocument();
    expect(screen.getByText("Checkout this commit")).toBeInTheDocument();
  });

  it("opens on the author column, which used to swallow the gesture", async () => {
    await mount();
    fireEvent.contextMenu(await screen.findByText("Ada L"));
    expect(await screen.findByText("Checkout this commit")).toBeInTheDocument();
  });
});
