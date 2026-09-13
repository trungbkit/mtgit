import { readFileSync } from "node:fs";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DiffLine, FileDiff, Hunk } from "../../ipc/types";
import { changeRuns, DiffView, totalDiffLines } from "./DiffView";

// Shiki loads a wasm grammar per language; the rows under test are the same
// either way, and the real highlighter makes every case here async.
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

function diff(hunks: Hunk[]): FileDiff {
  return {
    path: "a.ts",
    oldPath: null,
    status: "modified",
    additions: 1,
    deletions: 1,
    binary: false,
    isLarge: false,
    hunks,
  };
}

/**
 * A "change" is a run of consecutive changed lines, not a line. Stepping line
 * by line through a forty-line replacement is scrolling with extra steps, and
 * the ruler would draw forty marks where the file has one edit.
 */
describe("change runs", () => {
  it("treats a block of consecutive changed lines as one change", () => {
    const runs = changeRuns([
      hunk([
        line("context", "a", 1),
        line("del", "b", 2),
        line("del", "c", 3),
        line("add", "B", 2),
        line("context", "d", 4),
      ]),
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ offset: 1, length: 3, kind: "mixed" });
  });

  it("separates runs that a context line sits between", () => {
    const runs = changeRuns([
      hunk([
        line("add", "a", 1),
        line("context", "b", 2),
        line("del", "c", 3),
      ]),
    ]);

    expect(runs.map((r) => r.kind)).toEqual(["add", "del"]);
    expect(runs.map((r) => r.offset)).toEqual([0, 2]);
  });

  it("keeps counting across hunk boundaries", () => {
    const runs = changeRuns([
      hunk([line("context", "a", 1), line("add", "b", 2)]),
      hunk([line("del", "c", 9)]),
    ]);

    // Offsets are into the flattened line list, which is the ruler's
    // coordinate space — restart them per hunk and every mark after the first
    // hunk lands in the wrong place.
    expect(runs.map((r) => r.offset)).toEqual([1, 2]);
    expect(totalDiffLines([hunk([line("context", "a", 1), line("add", "b", 2)]), hunk([line("del", "c", 9)])])).toBe(3);
  });

  it("finds nothing in a hunk of pure context", () => {
    expect(changeRuns([hunk([line("context", "a", 1)])])).toEqual([]);
  });
});

describe("the rendered diff", () => {
  const sample = diff([
    hunk([
      line("context", "a", 1),
      line("del", "b", 2),
      line("add", "B", 2),
      line("context", "c", 3),
      line("add", "d", 4),
    ]),
  ]);

  it("marks the first line of each run, and only the first", () => {
    const { container } = render(<DiffView diff={sample} mode="inline" />);
    const marked = [...container.querySelectorAll("[data-change]")];

    expect(marked.map((el) => el.getAttribute("data-change"))).toEqual(["0", "1"]);
  });

  it("marks the same two runs in split view", () => {
    const { container } = render(<DiffView diff={sample} mode="split" />);
    const marked = [...container.querySelectorAll(".split-row[data-change]")];

    expect(marked.map((el) => el.getAttribute("data-change"))).toEqual(["0", "1"]);
  });

  it("draws one ruler mark per run, coloured by what the run is", () => {
    const { container } = render(<DiffView diff={sample} mode="inline" />);
    const marks = [...container.querySelectorAll(".diff-ruler-mark")];

    expect(marks).toHaveLength(2);
    expect(marks[0]).toHaveClass("mixed");
    expect(marks[1]).toHaveClass("add");
  });

  it("shows no ruler for a diff with nothing in it to point at", () => {
    const { container } = render(
      <DiffView diff={diff([hunk([line("context", "a", 1)])])} mode="inline" />,
    );
    expect(container.querySelector(".diff-ruler")).toBeNull();
  });

  /**
   * jsdom lays nothing out, so the scroller's metrics are stated rather than
   * measured. What is under test is which element the ruler is listening to,
   * which does not need real geometry.
   */
  function measure(el: Element, scrollTop: number, clientHeight: number, scrollHeight: number) {
    for (const [key, value] of Object.entries({ scrollTop, clientHeight, scrollHeight })) {
      Object.defineProperty(el, key, { value, configurable: true, writable: true });
    }
  }

  it("follows the scroller across a change of view mode", () => {
    const { container, rerender } = render(<DiffView diff={sample} mode="inline" />);
    const box = () => container.querySelector(".diff-ruler-viewport") as HTMLElement;

    // `InlineDiff` and `SplitDiff` are different components, so this unmounts
    // one scroller and mounts another. The ref object the ruler closes over is
    // the same one either way — which is exactly why the effect cannot notice
    // on its own that the node underneath it has been replaced.
    rerender(<DiffView diff={sample} mode="split" />);

    const scroller = container.querySelector(".diff-code.split") as HTMLElement;
    measure(scroller, 100, 100, 400);
    scroller.dispatchEvent(new Event("scroll"));

    expect(box().style.top).toBe("25%");
    expect(box().style.height).toBe("25%");
  });

  it("keeps the ruler out of the scroller", () => {
    // Inside it, the ruler is positioned against the content box and scrolls
    // away — the same trap `graph.css` documents for the marker gutter.
    const { container } = render(<DiffView diff={sample} mode="inline" />);
    expect(container.querySelector(".diff-code .diff-ruler")).toBeNull();
    expect(container.querySelector(".diff-pane > .diff-ruler")).not.toBeNull();
  });
});

describe("the split filler", () => {
  it("is hatched, not filled", () => {
    // A flat block reads as "a line with another background"; this is "no line
    // here at all". Asserted against the stylesheet because vitest applies none
    // of it, so `toHaveStyle` would read an empty rule and pass regardless.
    const css = readFileSync("src/features/diff/diff.css", "utf8");
    expect(css).toMatch(/\.dline\.empty\s*\{[^}]*repeating-linear-gradient/);
  });
});
