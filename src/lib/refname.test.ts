import { describe, expect, it } from "vitest";
import { validateRefName } from "./refname";

/**
 * `validateRefName` is the only thing between a user-typed branch name and
 * `git branch`, so the cases that matter are the ones git would reject with a
 * message the dialog cannot show.
 */
describe("validateRefName", () => {
  it("accepts the names people actually type", () => {
    for (const name of ["main", "feature/login", "release-1.2", "fix/JIRA-42_retry", "v2.0"]) {
      expect(validateRefName(name), name).toBeNull();
    }
  });

  it("trims before judging, so a pasted name with spaces around it is valid", () => {
    expect(validateRefName("  main  ")).toBeNull();
  });

  it("rejects the empty name and whitespace-only input", () => {
    expect(validateRefName("")).toMatch(/empty/i);
    expect(validateRefName("   ")).toMatch(/empty/i);
  });

  it("rejects git's reserved punctuation", () => {
    for (const name of ["a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b"]) {
      expect(validateRefName(name), name).toMatch(/cannot contain/i);
    }
  });

  it("rejects the sequences that collide with revision syntax", () => {
    expect(validateRefName("a..b")).toMatch(/\.\./);
    expect(validateRefName("a@{1}")).toMatch(/@\{/);
    expect(validateRefName("@")).toMatch(/'@'/);
  });

  it("rejects names git's ref storage cannot hold", () => {
    expect(validateRefName("feature.lock")).toMatch(/\.lock/);
    expect(validateRefName("/leading")).toMatch(/'\/'/);
    expect(validateRefName("trailing/")).toMatch(/'\/'/);
    expect(validateRefName(".hidden")).toMatch(/'\.'/);
    expect(validateRefName("trailing.")).toMatch(/'\.'/);
    expect(validateRefName("feature//x")).toMatch(/segment/i);
    expect(validateRefName("feature/.hidden")).toMatch(/segment/i);
  });

  it("rejects control characters, which paste in invisibly", () => {
    expect(validateRefName("ma\u0007in")).toMatch(/control/i);
  });
});
