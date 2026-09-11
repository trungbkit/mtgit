import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStores } from "../test/stores";
import { seedSearch, useSearch } from "./search";
import type { SearchHit, SearchResults } from "../ipc/types";

const REPO = "/repo";
const OTHER = "/other";

const s = () => useSearch.getState();

function hits(n: number): SearchHit[] {
  return Array.from({ length: n }, (_, i) => ({
    oid: `${i}`.padStart(40, "0"),
    index: i * 10,
    pageHint: 0,
  }));
}

function results(n: number): SearchResults {
  return {
    hits: hits(n),
    truncated: false,
    cancelled: false,
    summary: `${n} results`,
    notes: [],
  };
}

beforeEach(() => {
  localStorage.clear();
  resetStores();
});

describe("result handling", () => {
  it("lands on no hit, so a graph does not scroll out from under someone still typing", () => {
    s().begin(REPO, "fix");
    s().finish(REPO, "fix", results(37));
    const state = s().get(REPO);
    expect(state.running).toBe(false);
    expect(state.cursor).toBe(-1);
    expect(state.hits).toHaveLength(37);
    expect(state.summary).toBe("37 results");
  });

  it("records which query the hits belong to", () => {
    s().setQuery(REPO, "later text");
    s().begin(REPO, "fix");
    s().finish(REPO, "fix", results(2));
    expect(s().get(REPO).submitted).toBe("fix");
    expect(s().get(REPO).query).toBe("later text");
  });

  it("a failure drops the stale hits rather than leaving them navigable", () => {
    s().finish(REPO, "fix", results(5));
    s().fail(REPO, "unterminated quote");
    const state = s().get(REPO);
    expect(state.error).toBe("unterminated quote");
    expect(state.hits).toEqual([]);
    expect(state.cursor).toBe(-1);
    expect(state.running).toBe(false);
  });

  it("typing again clears the error but keeps the hits on screen", () => {
    s().fail(REPO, "bad");
    s().setQuery(REPO, "m");
    expect(s().get(REPO).error).toBeNull();
  });

  it("clear empties the query and the results but keeps recent and pinned", () => {
    s().remember(REPO, "author:@me");
    s().pin(REPO, "mine", "author:@me");
    s().finish(REPO, "x", results(3));
    s().clear(REPO);
    const state = s().get(REPO);
    expect(state.query).toBe("");
    expect(state.submitted).toBe("");
    expect(state.hits).toEqual([]);
    expect(state.recent).toEqual(["author:@me"]);
    expect(state.pinned).toEqual([{ name: "mine", query: "author:@me" }]);
  });

  it("keeps each repo's search separate, so a tab switch does not leak hits", () => {
    s().finish(REPO, "a", results(3));
    s().setQuery(OTHER, "b");
    expect(s().get(OTHER).hits).toEqual([]);
    expect(s().get(REPO).hits).toHaveLength(3);
  });

  it("reports a default slice for a repo that has never been searched", () => {
    const state = s().get("/never");
    expect(state.query).toBe("");
    expect(state.mode).toBe("highlight");
    expect(state.hits).toEqual([]);
  });
});

describe("hit navigation", () => {
  it("steps forward from nothing to the first hit, and backward to the last", () => {
    s().finish(REPO, "x", results(3));
    expect(s().step(REPO, 1)).toBe(0);

    s().setCursor(REPO, -1);
    expect(s().step(REPO, -1)).toBe(2);
  });

  it("wraps in both directions", () => {
    s().finish(REPO, "x", results(3));
    s().setCursor(REPO, 2);
    expect(s().step(REPO, 1)).toBe(0);
    expect(s().step(REPO, -1)).toBe(2);
  });

  it("reports -1 and moves nothing when there are no hits", () => {
    s().finish(REPO, "x", results(0));
    expect(s().step(REPO, 1)).toBe(-1);
    expect(s().get(REPO).cursor).toBe(-1);
  });
});

describe("modifiers and mode", () => {
  it("merges one modifier without resetting the others", () => {
    s().setModifiers(REPO, { matchCase: true });
    s().setModifiers(REPO, { matchRegex: true });
    expect(s().get(REPO).modifiers).toEqual({
      matchCase: true,
      matchAll: false,
      matchRegex: true,
      matchWholeWord: false,
    });
  });

  it("defaults to highlight, which is the mode that preserves topology", () => {
    expect(s().get(REPO).mode).toBe("highlight");
    s().setMode(REPO, "filter");
    expect(s().get(REPO).mode).toBe("filter");
  });
});

describe("recent and pinned queries", () => {
  it("remembers most-recent-first, de-duplicated and trimmed", () => {
    s().remember(REPO, "a");
    s().remember(REPO, " b ");
    s().remember(REPO, "a");
    expect(s().get(REPO).recent).toEqual(["a", "b"]);
  });

  it("ignores a blank query", () => {
    s().remember(REPO, "   ");
    expect(s().get(REPO).recent).toEqual([]);
  });

  it("caps recent at twelve", () => {
    for (let i = 0; i < 20; i++) s().remember(REPO, `q${i}`);
    expect(s().get(REPO).recent).toHaveLength(12);
    expect(s().get(REPO).recent[0]).toBe("q19");
  });

  it("pins under a name, replacing a pin of the same name", () => {
    s().pin(REPO, "mine", "author:@me");
    s().pin(REPO, "mine", "author:@me type:merge");
    expect(s().get(REPO).pinned).toEqual([{ name: "mine", query: "author:@me type:merge" }]);
    s().unpin(REPO, "mine");
    expect(s().get(REPO).pinned).toEqual([]);
  });

  it("persists both per repo path", () => {
    s().remember(REPO, "a");
    s().pin(REPO, "mine", "author:@me");
    expect(JSON.parse(localStorage.getItem(`mtgit.search.recent.${REPO}`)!)).toEqual(["a"]);
    expect(JSON.parse(localStorage.getItem(`mtgit.search.pinned.${REPO}`)!)).toEqual([
      { name: "mine", query: "author:@me" },
    ]);
    expect(localStorage.getItem(`mtgit.search.recent.${OTHER}`)).toBeNull();
  });
});

describe("seedSearch", () => {
  it("adds a term to an existing query, which is what makes author:X file:Y two clicks", () => {
    s().setQuery(REPO, "author:ada");
    seedSearch(REPO, "file:src/main.rs");
    expect(s().get(REPO).query).toBe("author:ada file:src/main.rs");
  });

  it("is the whole query when the field is empty or when asked to replace", () => {
    seedSearch(REPO, "author:ada");
    expect(s().get(REPO).query).toBe("author:ada");
    seedSearch(REPO, "ref:main", true);
    expect(s().get(REPO).query).toBe("ref:main");
  });

  it("asks the search field to take focus", () => {
    const listener = vi.fn();
    window.addEventListener("mtgit:focus-search", listener);
    seedSearch(REPO, "author:ada");
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ repoPath: REPO });
    window.removeEventListener("mtgit:focus-search", listener);
  });
});
