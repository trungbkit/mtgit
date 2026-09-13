import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStores } from "../../test/stores";
import { useSession } from "../../stores/session";
import type { CommitDetail, FileChange, FileStatus, RepoInfo } from "../../ipc/types";
import { getCommit, getCommitDiff, getStatus } from "../../ipc/commands";
import { DetailPanel } from "./DetailPanel";

vi.mock("../../ipc/commands", () => {
  const stub = () => vi.fn();
  return {
    commitAdvanced: stub(),
    getCommit: stub(),
    getCommitDiff: stub(),
    getStatus: stub(),
    getFileAt: stub(),
    fileHistory: stub(),
    blameFile: stub(),
    listRefs: stub(),
    completePaths: stub(),
    operationInfo: stub(),
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

const OID = "b".repeat(40);

function change(path: string, status: FileStatus): FileChange {
  return { path, oldPath: null, status, additions: 1, deletions: 1, binary: false };
}

function detail(overrides: Partial<CommitDetail> = {}): CommitDetail {
  return {
    oid: OID,
    summary: "feat: a thing",
    body: "",
    authorName: "Ada L",
    authorEmail: "ada@example.com",
    authorTime: 1_700_000_000,
    committerName: "Ada L",
    committerEmail: "ada@example.com",
    committerTime: 1_700_000_000,
    parents: [],
    files: [
      change("a.ts", "modified"),
      change("b.ts", "modified"),
      change("c.ts", "added"),
      change("d.ts", "deleted"),
    ],
    ...overrides,
  };
}

beforeEach(() => {
  resetStores();
  useSession.setState({ repo, tabs: [repo], startTab: false, activeStart: false, selectedOid: OID });
  vi.mocked(getCommit).mockResolvedValue(detail());
  vi.mocked(getCommitDiff).mockResolvedValue([]);
  vi.mocked(getStatus).mockResolvedValue({
    staged: [],
    unstaged: [],
    conflicted: [],
    isDirty: false,
  });
});

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DetailPanel />
    </QueryClientProvider>,
  );
}

describe("the change summary", () => {
  /**
   * It used to be one joined string — "2 modified + 1 added + 1 deleted" — so
   * the one line that counts the rows below it was the one line in the panel
   * that said "added" in the same grey as "deleted".
   */
  it("colours each count by status, in the rows' own language", async () => {
    const { container } = renderPanel();
    await screen.findByText("feat: a thing");

    const parts = [...container.querySelectorAll(".fs-part")];
    expect(parts.map((p) => p.textContent)).toEqual(["M2 modified", "A1 added", "D1 deleted"]);
    expect(parts[0]).toHaveClass("mod");
    expect(parts[1]).toHaveClass("add");
    expect(parts[2]).toHaveClass("del");
  });

  it("says so plainly when a commit changed nothing", async () => {
    vi.mocked(getCommit).mockResolvedValue(detail({ files: [] }));
    renderPanel();
    expect(await screen.findByText("no changes")).toBeInTheDocument();
  });
});

describe("the commit message", () => {
  it("keeps the subject and body in one scrolling block", async () => {
    vi.mocked(getCommit).mockResolvedValue(detail({ body: "why it was done" }));
    const { container } = renderPanel();
    await screen.findByText("feat: a thing");

    // The box scrolls, not the body inside it — otherwise the scrollbar sits
    // under a summary pinned above it.
    const box = container.querySelector(".detail-message")!;
    expect(box.querySelector(".detail-summary")).toHaveTextContent("feat: a thing");
    expect(box.querySelector(".detail-body")).toHaveTextContent("why it was done");
  });
});

describe("the working-directory banner", () => {
  it("appears only when the working directory has changes, and offers the way in", async () => {
    vi.mocked(getStatus).mockResolvedValue({
      staged: [{ path: "x.ts", status: "modified", size: null }],
      unstaged: [],
      conflicted: [],
      isDirty: true,
    });
    const { container } = renderPanel();
    await screen.findByText("feat: a thing");

    const banner = container.querySelector(".changes-banner")!;
    expect(banner).toHaveTextContent("1 file change in working directory");
    expect(banner.querySelector(".changes-banner-cta")).toHaveTextContent("View Changes");
  });

  it("stays away on a clean tree", async () => {
    const { container } = renderPanel();
    await screen.findByText("feat: a thing");
    expect(container.querySelector(".changes-banner")).toBeNull();
  });
});
