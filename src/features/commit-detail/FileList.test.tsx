import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FileStatus } from "../../ipc/types";
import { FileList, type FileItem } from "./FileList";

function file(path: string, status: FileStatus = "modified"): FileItem {
  return { path, status };
}

function renderList(files: FileItem[]) {
  return render(<FileList files={files} selected={null} onSelect={vi.fn()} />);
}

/**
 * A commit under one deep tree repeats the same directory on every row, and the
 * basename is the only part anybody reads. The row used to print the whole path
 * as one flat string in one colour, with the ellipsis on the *end* — so a long
 * path truncated away the half that identifies the file.
 */
describe("a file row", () => {
  it("dims its directory and bolds its basename", () => {
    const { container } = renderList([file("src/features/graph/GraphView.tsx")]);

    const row = container.querySelector(".file-row")!;
    expect(row.querySelector(".file-dir")).toHaveTextContent("src/features/graph/");
    expect(row.querySelector("b")).toHaveTextContent("GraphView.tsx");
  });

  it("clips the directory, never the filename", () => {
    const { container } = renderList([file("a/very/deep/tree/of/directories/file.ts")]);
    expect(container.querySelector(".file-name b")).toHaveTextContent("file.ts");

    // Read from the stylesheet: vitest applies none of it, so a `toHaveStyle`
    // here would assert against an empty rule and pass whatever the file said.
    // The ellipsis has to be on the directory and `flex-shrink: 0` on the
    // basename; put the ellipsis back on `.file-name` and the *filename* is
    // what a long path truncates away.
    const css = readFileSync("src/features/commit-detail/filelist.css", "utf8");
    expect(css).toMatch(/\.file-dir\s*\{[^}]*text-overflow:\s*ellipsis/);
    expect(css).toMatch(/\.file-name b\s*\{[^}]*flex-shrink:\s*0/);
    expect(css).not.toMatch(/\.file-name\s*\{[^}]*text-overflow/);
  });

  it("carries the full path as its tooltip whatever is drawn", () => {
    const { container } = renderList([file("deep/nested/thing.ts")]);
    expect(container.querySelector(".file-row")).toHaveAttribute("title", "deep/nested/thing.ts");
  });

  it("shows only the leaf in tree mode, with no directory span", async () => {
    const { container } = renderList([file("src/app/App.tsx")]);
    await userEvent.click(screen.getByRole("button", { name: "Tree" }));

    expect(container.querySelector(".file-row .file-dir")).toBeNull();
    expect(container.querySelector(".file-row b")).toHaveTextContent("App.tsx");
  });
});

describe("sorting", () => {
  const files = [
    file("z/one.ts", "modified"),
    file("a/two.ts", "added"),
    file("m/three.ts", "deleted"),
  ];

  const names = (container: HTMLElement) =>
    [...container.querySelectorAll(".file-name")].map((n) => n.textContent);

  it("starts in the order the commit gives", () => {
    const { container } = renderList(files);
    expect(names(container)).toEqual(["z/one.ts", "a/two.ts", "m/three.ts"]);
  });

  it("groups added files together when sorted by status", async () => {
    const { container } = renderList(files);
    await userEvent.click(screen.getByRole("button", { name: /Path order/ }));

    // A before D before M, which is what the marks sort as.
    expect(names(container)).toEqual(["a/two.ts", "m/three.ts", "z/one.ts"]);
  });

  it("sorts by basename, not by path, when sorted by name", async () => {
    const { container } = renderList(files);
    await userEvent.click(screen.getByRole("button", { name: /Path order/ }));
    await userEvent.click(screen.getByRole("button", { name: /By status/ }));

    expect(names(container)).toEqual(["z/one.ts", "m/three.ts", "a/two.ts"]);
  });

  it("hides the control in tree mode, where it would change nothing", async () => {
    renderList(files);
    await userEvent.click(screen.getByRole("button", { name: "Tree" }));
    expect(screen.queryByRole("button", { name: /Path order/ })).toBeNull();
  });
});
