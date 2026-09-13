import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStores } from "../../test/stores";
import { useSettings } from "../../stores/settings";
import type { DiffLine, FileDiff, Hunk } from "../../ipc/types";
import { FileViewer } from "./FileViewer";

vi.mock("../../ipc/commands", () => ({
  applyPatch: vi.fn(),
  fileHistory: vi.fn().mockResolvedValue([]),
  getFileAt: vi.fn(),
  blameFile: vi.fn(),
  saveSettings: vi.fn(),
  getSettings: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn() }));
vi.mock("./highlight", () => ({
  useHighlighter: () => null,
  langForPath: () => null,
  tokenizeLine: (_hl: unknown, text: string) => [{ content: text, color: null }],
}));

function line(kind: DiffLine["kind"], text: string, no: number): DiffLine {
  return { kind, oldNo: kind === "add" ? null : no, newNo: kind === "del" ? null : no, text };
}

function hunk(lines: DiffLine[]): Hunk {
  return { header: "@@ -1,1 +1,1 @@", lines };
}

const diff: FileDiff = {
  path: "src/a.ts",
  oldPath: null,
  status: "modified",
  binary: false,
  isLarge: false,
  additions: 2,
  deletions: 1,
  hunks: [
    hunk([
      line("context", "a", 1),
      line("del", "b", 2),
      line("add", "B", 2),
      line("context", "c", 3),
      line("add", "d", 4),
    ]),
  ],
};

beforeEach(() => {
  resetStores();
  // jsdom lays nothing out and implements no scrolling.
  Element.prototype.scrollIntoView = vi.fn();
});

function renderViewer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FileViewer diff={diff} repoPath="/repo" commitOid={null} headOid={null} isWorkingTree={false} />
    </QueryClientProvider>,
  );
}

describe("the change stepper", () => {
  it("counts changes, not changed lines", () => {
    const { container } = renderViewer();
    // Two runs across five changed-or-context lines: a del/add pair, then a
    // lone add. Counted per line it would read 3.
    expect(container.querySelector(".fv-stepper-count")).toHaveTextContent("2");
  });

  it("lands on the first change, not the second, on the first press", async () => {
    renderViewer();
    await userEvent.click(screen.getByRole("button", { name: "Next change" }));
    expect(screen.getByText("1/2")).toBeInTheDocument();
  });

  it("enters the file from the end when the first press is backwards", async () => {
    renderViewer();
    // The mirror of the test above. Nothing has been stepped to yet, so "back"
    // means the last change — folding the -1 placeholder into the modulo lands
    // on the second to last instead, skipping the one being reached for.
    await userEvent.click(screen.getByRole("button", { name: "Previous change" }));
    expect(screen.getByText("2/2")).toBeInTheDocument();
  });

  it("wraps at both ends, so you can tell you have seen them all", async () => {
    renderViewer();
    const next = screen.getByRole("button", { name: "Next change" });
    await userEvent.click(next);
    await userEvent.click(next);
    expect(screen.getByText("2/2")).toBeInTheDocument();
    await userEvent.click(next);
    expect(screen.getByText("1/2")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Previous change" }));
    expect(screen.getByText("2/2")).toBeInTheDocument();
  });
});

describe("the change shortcuts", () => {
  it("step the diff when the keystroke was not meant for a text field", async () => {
    renderViewer();
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(screen.getByText("1/2")).toBeInTheDocument();
  });

  it("leave the commit message box alone", async () => {
    // `StagingView` renders this diff beside the commit form, and ⌥↓ is how a
    // caret moves by paragraph on macOS. Swallowing it there is a keystroke
    // the user typed into a field going somewhere else instead.
    const { container } = renderViewer();
    const box = document.createElement("textarea");
    container.appendChild(box);
    box.focus();

    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(container.querySelector(".fv-stepper-count")).toHaveTextContent("2");
    expect(screen.queryByText("1/2")).toBeNull();
  });
});

describe("the reading toggles", () => {
  /**
   * Both live in Settings as well. Two *surfaces* on one store is the point; a
   * second copy of the answer is the defect the settings convention names.
   */
  it("write through to the settings store, not to a copy of their own", async () => {
    renderViewer();
    expect(useSettings.getState().settings.diffWordWrap).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Wrap long lines" }));
    expect(useSettings.getState().settings.diffWordWrap).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Ignore whitespace changes" }));
    expect(useSettings.getState().settings.diffIgnoreWhitespace).toBe(true);
  });

  it("show the store's answer rather than their own press count", async () => {
    renderViewer();
    const wrap = screen.getByRole("button", { name: "Wrap long lines" });
    expect(wrap).toHaveAttribute("aria-pressed", "false");

    // Changed from elsewhere — Settings, the same store. The button has to
    // follow, which it only does if it is reading rather than remembering.
    useSettings.getState().set({ diffWordWrap: true });
    expect(await screen.findByRole("button", { name: "Wrap long lines" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
