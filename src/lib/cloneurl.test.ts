import { describe, expect, it } from "vitest";
import { joinPath, parseProgress, repoNameFromUrl, validateCloneUrl } from "./cloneurl";

describe("validateCloneUrl", () => {
  it("accepts every shape a provider's copy button produces", () => {
    for (const url of [
      "https://github.com/gitkraken/vscode-gitlens.git",
      "http://internal.example/repo",
      "git@github.com:org/repo.git",
      "ssh://git@host:2222/org/repo.git",
      "git://host/repo.git",
      "/Users/me/src/repo",
      "~/src/repo",
      "C:\\src\\repo",
    ]) {
      expect(validateCloneUrl(url), url).toBeNull();
    }
  });

  it("rejects a URL beginning with '-', which is an argument and not a URL", () => {
    // The frontend copy of `core/remote.rs::check_url` — it exists to say so
    // while the user is still typing, not to be the only guard.
    expect(validateCloneUrl("--upload-pack=touch /tmp/pwned")).toMatch(/cannot start with '-'/);
    expect(validateCloneUrl("-x")).toMatch(/cannot start with '-'/);
  });

  it("rejects the empty field and anything with no scheme, host or path shape", () => {
    expect(validateCloneUrl("")).toMatch(/Enter a repository URL/);
    expect(validateCloneUrl("   ")).toMatch(/Enter a repository URL/);
    expect(validateCloneUrl("not a url")).toMatch(/cannot contain spaces/);
    expect(validateCloneUrl("github.com/org/repo")).toMatch(/Enter a git URL/);
  });

  it("does not mistake a scp-like prefix for a scheme", () => {
    // `git@host://weird` has a colon-slash-slash after the user@host, which a
    // naive scheme test reads as a scheme and lets through unexamined.
    expect(validateCloneUrl("git@github.com:org/repo.git")).toBeNull();
  });
});

describe("repoNameFromUrl", () => {
  it("derives the folder git clone would create", () => {
    expect(repoNameFromUrl("https://github.com/org/repo.git")).toBe("repo");
    expect(repoNameFromUrl("https://github.com/org/repo")).toBe("repo");
    expect(repoNameFromUrl("git@github.com:org/repo.git")).toBe("repo");
    expect(repoNameFromUrl("ssh://git@host:2222/org/deep/repo.git")).toBe("repo");
    expect(repoNameFromUrl("/Users/me/src/repo")).toBe("repo");
    expect(repoNameFromUrl("C:\\src\\repo")).toBe("repo");
  });

  it("ignores a trailing slash, a query and a fragment", () => {
    expect(repoNameFromUrl("https://github.com/org/repo.git/")).toBe("repo");
    expect(repoNameFromUrl("https://host/org/repo.git?ref=main")).toBe("repo");
    expect(repoNameFromUrl("https://host/org/repo.git#readme")).toBe("repo");
  });

  it("strips .git case-insensitively but keeps a dot inside the name", () => {
    expect(repoNameFromUrl("https://host/org/repo.GIT")).toBe("repo");
    expect(repoNameFromUrl("https://host/org/my.repo.git")).toBe("my.repo");
  });

  it("returns empty rather than inventing a name it cannot derive", () => {
    expect(repoNameFromUrl("")).toBe("");
    expect(repoNameFromUrl("   ")).toBe("");
  });
});

describe("joinPath", () => {
  it("joins without doubling the separator", () => {
    expect(joinPath("/Users/me/src", "repo")).toBe("/Users/me/src/repo");
    expect(joinPath("/Users/me/src/", "repo")).toBe("/Users/me/src/repo");
  });

  it("uses a backslash only for a path that is unambiguously Windows-shaped", () => {
    expect(joinPath("C:\\src", "repo")).toBe("C:\\src\\repo");
    // A mixed path still gets a forward slash: Windows accepts it, and
    // guessing the other way turns a POSIX path into a broken one.
    expect(joinPath("C:/src", "repo")).toBe("C:/src/repo");
  });

  it("degrades to whichever half it was given", () => {
    expect(joinPath("", "repo")).toBe("repo");
    expect(joinPath("/Users/me", "")).toBe("/Users/me");
  });
});

describe("parseProgress", () => {
  it("reads the phase and percentage out of a git --progress line", () => {
    expect(parseProgress("Receiving objects:  42% (420/1000)")).toEqual({
      phase: "Receiving objects",
      percent: 42,
    });
  });

  it("takes the last chunk, because git rewrites the line in place with \\r", () => {
    const line = "Receiving objects:   1% (1/1000)\rReceiving objects:  99% (990/1000)\r";
    expect(parseProgress(line)).toEqual({ phase: "Receiving objects", percent: 99 });
  });

  it("returns null for the lines that carry no percentage", () => {
    expect(parseProgress("Cloning into 'repo'...")).toBeNull();
    expect(parseProgress("remote: Enumerating objects")).toBeNull();
    expect(parseProgress("")).toBeNull();
  });

  it("clamps, so a malformed percentage cannot drive the bar past full", () => {
    expect(parseProgress("Resolving deltas: 120% (1/1)")?.percent).toBe(100);
  });
});
