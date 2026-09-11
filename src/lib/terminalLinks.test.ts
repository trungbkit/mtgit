import { describe, expect, it } from "vitest";
import { findCandidates } from "./terminalLinks";

const REFS = ["main", "develop", "origin/main", "feature/login", "release-1.2", "v1.0.0"];

/**
 * Candidate extraction only. Whether a candidate is a real ref is
 * `core/terminal.rs`'s answer — these tests pin what is *offered* to it, and in
 * particular that nothing overlaps, because two overlapping links in xterm are
 * an unclickable mess.
 */
describe("findCandidates", () => {
  const texts = (line: string, refs = REFS) => findCandidates(line, refs).map((c) => c.text);

  it("finds shas of every length git prints", () => {
    expect(texts("commit 8efd4ae")).toContain("8efd4ae");
    expect(texts("commit 8efd4ae1b2c3d4e5f60718293a4b5c6d7e8f9012")).toContain(
      "8efd4ae1b2c3d4e5f60718293a4b5c6d7e8f9012",
    );
  });

  it("finds ranges whole, and does not also offer the shas inside them", () => {
    expect(texts("8efd4ae..3eb743d")).toEqual(["8efd4ae..3eb743d"]);
    expect(texts("main...develop")).toEqual(["main...develop"]);
  });

  it("finds the revision syntax git uses in its own advice", () => {
    expect(texts("git reset HEAD~1")).toContain("HEAD~1");
    expect(texts("detached at HEAD")).toContain("HEAD");
    expect(texts("HEAD^")).toContain("HEAD^");
  });

  it("matches ref names literally, so slashes and dots survive", () => {
    expect(texts("* feature/login")).toContain("feature/login");
    expect(texts("  release-1.2")).toContain("release-1.2");
    expect(texts("tag: v1.0.0")).toContain("v1.0.0");
  });

  it("prefers the longer ref, so origin/main does not also yield main", () => {
    expect(texts("  origin/main")).toEqual(["origin/main"]);
    expect(texts("Everything up-to-date with origin/main")).toEqual(["origin/main"]);
  });

  it("offers nothing after a path separator, which costs `git branch -a`", () => {
    // The lookbehind that rejects a preceding `/` is what keeps `main` out of
    // `src/main.rs`; it also keeps `origin/main` out of `remotes/origin/main`.
    // Both are deliberate and the filename half is the one worth having — a
    // link on a source path would resolve and jump somewhere unrelated.
    expect(texts("  remotes/origin/main")).toEqual([]);
    expect(texts("modified: src/main.rs")).toEqual([]);
  });

  it("does not match a ref name embedded in a longer word", () => {
    expect(texts("mainly", ["main"])).toEqual([]);
    expect(texts("domain", ["main"])).toEqual([]);
    expect(texts("main-thing", ["main"])).toEqual([]);
  });

  it("reports positions that span exactly the token", () => {
    const [only] = findCandidates("on main now", ["main"]);
    expect(only).toEqual({ text: "main", start: 3, end: 7 });
  });

  it("never returns overlapping candidates", () => {
    const found = findCandidates(
      "Merge 8efd4ae..3eb743d from origin/main into main at HEAD~2",
      REFS,
    );
    for (let i = 1; i < found.length; i++) {
      expect(found[i].start).toBeGreaterThanOrEqual(found[i - 1].end);
    }
  });

  it("survives an empty ref list and an empty line", () => {
    expect(findCandidates("", REFS)).toEqual([]);
    expect(texts("nothing here", [])).toEqual([]);
    // A blank entry in the ref list would compile to an empty alternative and
    // match at every position.
    expect(texts("nothing here", ["", "main"])).toEqual([]);
  });
});
