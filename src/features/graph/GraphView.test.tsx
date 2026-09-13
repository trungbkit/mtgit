import { readFileSync } from "node:fs";
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
        bodyPreview: "",
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
describe("the commit message", () => {
  beforeEach(() => mockGetGraph.mockResolvedValue(page()));

  it("draws the body dimmed and apart from the subject", async () => {
    const withBody = page();
    withBody.rows[0].bodyPreview = "why the change was made";
    mockGetGraph.mockResolvedValue(withBody);

    const { container } = await mount();
    expect(await screen.findByText("initial commit")).toBeInTheDocument();

    // One element, not two words in one string: the Rust side used to splice
    // the body into the summary with an em-dash, which left no way to tell
    // subject from explanation.
    const body = container.querySelector(".row-body");
    expect(body).toHaveTextContent("why the change was made");
    expect(container.querySelector(".row-summary")).not.toHaveTextContent("—");
  });

  it("renders nothing extra for a commit with no body", async () => {
    const { container } = await mount();
    expect(await screen.findByText("initial commit")).toBeInTheDocument();
    expect(container.querySelector(".row-body")).toBeNull();
  });
});

describe("the row band", () => {
  beforeEach(() => mockGetGraph.mockResolvedValue(page()));

  it("tints the selected row with its own lane rather than one blue", async () => {
    const { container } = await mount();
    await screen.findByText("initial commit");

    const row = container.querySelector(".graph-row") as HTMLElement;
    expect(row.style.background).toBe("");

    useSession.getState().selectOid("a".repeat(40));
    await screen.findByText("initial commit");
    // `lane-0` is the ring's first colour; what matters is that the band is a
    // colour at all, and that it came from the lane rather than a class.
    expect((container.querySelector(".graph-row.selected") as HTMLElement).style.background).not.toBe("");
  });
});

/**
 * Banding is drawn by a class, because rows are absolutely positioned and
 * `:nth-child` would describe the virtualizer's DOM order rather than the
 * graph's. That makes it a `background` competing with every other reason a
 * row is coloured — and the rule it competes with hardest lives in a different
 * stylesheet, so neither file shows the conflict.
 *
 * Asserted against the stylesheets because vitest applies none of them.
 */
describe("the alternating row band", () => {
  /** Class-level weight of a selector. `:where()` contributes nothing. */
  function weight(selector: string): number {
    const bare = selector.replace(/:where\([^)]*\)/g, "");
    return (bare.match(/\.[\w-]+|:[\w-]+|\[[^\]]*\]/g) ?? []).length;
  }

  function selectorFor(file: string, declaration: RegExp): string {
    const css = readFileSync(file, "utf8");
    const rule = new RegExp(`([^{}]+)\\{[^}]*${declaration.source}`).exec(css);
    if (!rule) throw new Error(`no rule declaring ${declaration} in ${file}`);
    return rule[1].trim().split("\n").pop()!.trim();
  }

  it("loses to every rule that colours a row for a reason", () => {
    const band = selectorFor("src/features/graph/graph.css", /background: var\(--bg-row-alt\)/);
    const hit = selectorFor("src/features/graph/search.css", /background: var\(--warn-tint\)/);

    // Equal weight is not a tie that banding may win: `graph.css` is bundled
    // after `search.css`, so equal weight means every *other* search hit
    // silently loses its yellow.
    expect(weight(band)).toBeLessThan(weight(hit));
    expect(weight(band)).toBeLessThan(weight(".graph-row:hover"));
  });
});

/**
 * The lanes are a `<canvas>` *underneath* the rows — `.graph-canvas` is z-index
 * 0 and `.graph-row` is z-index 1 — so a row background is a sheet of paint
 * over the graph. An opaque one does not tint a lane, it removes it, and the
 * rows that keep theirs make the result look like a history with no edges.
 *
 * That is what banding did: `--bg-row-alt` was a flat colour, so every odd row
 * erased its own segment of every line. The rule is not "banding must be
 * subtle", it is "anything colouring a whole row must be see-through", which is
 * why this reads all of them rather than the one that broke.
 *
 * Asserted against the stylesheets because vitest applies none of them, and
 * against `theme.css` because the alpha lives in the token, not in the rule.
 */
describe("a row background", () => {
  const themeCss = readFileSync("src/theme.css", "utf8");

  /** Every `background` a `.graph-row` selector declares, across both sheets. */
  function rowBackgrounds(): { selector: string; value: string }[] {
    const found: { selector: string; value: string }[] = [];
    for (const file of ["src/features/graph/graph.css", "src/features/graph/search.css"]) {
      const css = readFileSync(file, "utf8");
      for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const last = selector.trim().split("\n").pop()!.trim();
        // Keyframe stops are `0%`/`100%`, not selectors; the animated value is
        // a tint by construction and there is no element to paint it on.
        if (!last.includes(".graph-row")) continue;
        const decl = /(?:^|;)\s*background\s*:\s*([^;]+)/.exec(body);
        if (decl) found.push({ selector: last, value: decl[1].trim() });
      }
    }
    return found;
  }

  /** A token's value in a theme block, or the literal if it is not a `var()`. */
  function resolve(value: string, blockSelector: RegExp): string {
    const token = /^var\((--[a-z0-9-]+)\)$/.exec(value);
    if (!token) return value;
    const block = new RegExp(`${blockSelector.source}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`).exec(themeCss);
    if (!block) throw new Error(`no theme block matching ${blockSelector}`);
    const decl = new RegExp(`${token[1]}\\s*:\\s*([^;]+)`).exec(block[1]);
    if (!decl) throw new Error(`${token[1]} is not defined in ${blockSelector}`);
    return decl[1].trim();
  }

  /** `#rrggbbaa` / `#rgba` below full opacity, or nothing at all. */
  function isTranslucent(colour: string): boolean {
    if (colour === "transparent" || colour === "none") return true;
    const hex = /^#([0-9a-f]{4}|[0-9a-f]{8})$/i.exec(colour);
    if (!hex) return false;
    const alpha = hex[1].length === 4 ? hex[1][3].repeat(2) : hex[1].slice(6);
    return parseInt(alpha, 16) < 255;
  }

  it("is see-through in every theme, so the lanes under it still join up", () => {
    const backgrounds = rowBackgrounds();
    // A sanity floor: if the selectors are ever renamed, an empty sweep would
    // pass this suite while asserting nothing.
    expect(backgrounds.length).toBeGreaterThanOrEqual(4);

    for (const theme of [/\n:root/, /:root\[data-theme="dark"\]/]) {
      for (const { selector, value } of backgrounds) {
        const colour = resolve(value, theme);
        expect(
          isTranslucent(colour),
          `${selector} paints ${value} (${colour}) over the lane canvas`,
        ).toBe(true);
      }
    }
  });
});

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
