import { describe, expect, it } from "vitest";
import { findRefs } from "./refFinder";
import type { BranchInfo, RefList } from "../ipc/types";

const branch = (name: string, isHead = false): BranchInfo => ({
  name,
  oid: `oid-${name}`,
  isHead,
  upstream: null,
  ahead: null,
  behind: null,
  upstreamGone: false,
});

const refs: RefList = {
  local: [branch("main", true), branch("remainder"), branch("feat/login")],
  remote: [branch("origin/main"), branch("origin/feat/login")],
  tags: [branch("v1.0.0"), branch("main-release")],
};

describe("the branch finder's ranking", () => {
  it("puts an exact match above one that merely contains the query", () => {
    // `remainder` contains "main"; offering it first is the failure mode a
    // plain substring filter has.
    expect(findRefs(refs, "main").map((r) => r.name).slice(0, 2)).toEqual([
      "main",
      "origin/main",
    ]);
  });

  it("reads a remote branch's name after the remote", () => {
    const names = findRefs(refs, "feat/log").map((r) => r.name);
    expect(names).toEqual(["feat/login", "origin/feat/login"]);
  });

  it("ranks local branches above remote ones and tags", () => {
    const names = findRefs(refs, "").map((r) => r.name);
    expect(names.slice(0, 3)).toEqual(["main", "remainder", "feat/login"]);
    expect(names[names.length - 1]).toBe("main-release");
  });

  it("falls back to a scattered subsequence rather than nothing", () => {
    expect(findRefs(refs, "flgn").map((r) => r.name)).toContain("feat/login");
  });

  it("returns nothing for a query no ref can match", () => {
    expect(findRefs(refs, "zzz")).toEqual([]);
  });

  it("carries the tip oid, which is what the finder scrolls to", () => {
    expect(findRefs(refs, "v1.0.0")[0]).toMatchObject({ oid: "oid-v1.0.0", kind: "tag" });
  });

  it("has nothing to offer before the ref list has loaded", () => {
    expect(findRefs(undefined, "main")).toEqual([]);
  });
});
