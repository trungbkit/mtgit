import { describe, expect, it } from "vitest";
import { splitAutolinks } from "./autolinks";
import type { AutolinkPattern } from "../ipc/types";

const hash: AutolinkPattern = {
  prefix: "#",
  url: "https://example.com/issues/<num>",
  alphanumeric: false,
  source: "builtin",
};
const jira: AutolinkPattern = {
  prefix: "PROJ-",
  url: "https://example.com/browse/PROJ-<num>",
  alphanumeric: true,
  source: "config",
};

describe("splitAutolinks", () => {
  it("leaves text alone when no pattern is configured", () => {
    expect(splitAutolinks("fixes #12", [])).toEqual([{ text: "fixes #12" }]);
  });

  it("links a reference and keeps the surrounding text as plain segments", () => {
    expect(splitAutolinks("fixes #12 today", [hash])).toEqual([
      { text: "fixes " },
      { text: "#12", href: "https://example.com/issues/12", prefix: "#" },
      { text: " today" },
    ]);
  });

  it("does not link a reference that starts mid-word", () => {
    // A colour, a URL fragment and a path — none of them issue 12.
    expect(splitAutolinks("#ff0012", [hash])).toEqual([{ text: "#ff0012" }]);
    expect(splitAutolinks("see a#12", [hash])).toEqual([{ text: "see a#12" }]);
    expect(splitAutolinks("docs/#12", [hash])).toEqual([{ text: "docs/#12" }]);
  });

  it("takes the longest match when two patterns start at the same place", () => {
    const sub: AutolinkPattern = { ...hash, prefix: "#SUB-", alphanumeric: true, source: "config" };
    const segments = splitAutolinks("#SUB-12", [hash, sub]);
    expect(segments).toHaveLength(1);
    expect(segments[0].prefix).toBe("#SUB-");
  });

  it("respects the alphanumeric flag", () => {
    expect(splitAutolinks("PROJ-4a done", [jira])[0]).toEqual({
      text: "PROJ-4a",
      href: "https://example.com/browse/PROJ-4a",
      prefix: "PROJ-",
    });
    // Digits only: the letters stop the reference rather than joining it.
    expect(splitAutolinks("#4a", [hash])[0]).toEqual({
      text: "#4",
      href: "https://example.com/issues/4",
      prefix: "#",
    });
  });

  it("escapes the reference into the URL", () => {
    const odd: AutolinkPattern = { ...jira, prefix: "X/" };
    expect(splitAutolinks("X/1a", [odd])[0].href).toBe("https://example.com/browse/PROJ-1a");
  });

  it("links every occurrence, not just the first", () => {
    const segments = splitAutolinks("#1 and #2", [hash]);
    expect(segments.filter((s) => s.href)).toHaveLength(2);
  });

  it("ignores a bare prefix with no reference after it", () => {
    expect(splitAutolinks("a # b", [hash])).toEqual([{ text: "a # b" }]);
  });
});
