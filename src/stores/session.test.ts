import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStores } from "../test/stores";
import { useSession } from "./session";
import type { RepoInfo } from "../ipc/types";

function repo(path: string, branch = "main"): RepoInfo {
  return {
    path,
    name: path.split("/").pop() ?? path,
    head: { branch, oid: "0".repeat(40), detached: false, unborn: false },
  } as RepoInfo;
}

const s = () => useSession.getState();

beforeEach(() => {
  localStorage.clear();
  resetStores();
  // The store read `localStorage` when it was constructed, which was before
  // this suite's `localStorage.clear()`. Put the list back to empty explicitly.
  useSession.setState({ recentRepos: [] });
});

describe("tabs", () => {
  it("boots on the start screen with no repo", () => {
    expect(s().activeStart).toBe(true);
    expect(s().repo).toBeNull();
    expect(s().tabs).toEqual([]);
  });

  it("opening a repo adds a tab, activates it and leaves the start screen", () => {
    s().setRepo(repo("/a"));
    expect(s().repo?.path).toBe("/a");
    expect(s().activeStart).toBe(false);
    expect(s().tabs.map((t) => t.path)).toEqual(["/a"]);
    // The start tab stays in the strip; it is only deactivated.
    expect(s().startTab).toBe(true);
  });

  it("opening the same repo twice does not duplicate its tab", () => {
    s().setRepo(repo("/a"));
    s().setRepo(repo("/a", "develop"));
    expect(s().tabs.map((t) => t.path)).toEqual(["/a"]);
    expect(s().repo?.head.branch).toBe("develop");
  });

  it("restores each tab's own selection when switching back", () => {
    s().setRepo(repo("/a"));
    s().selectOid("aaa");
    s().selectFile("a.txt");
    s().setRepo(repo("/b"));
    expect(s().selectedOid).toBeNull();

    s().selectOid("bbb");
    s().switchTab("/a");
    expect(s().selectedOid).toBe("aaa");
    expect(s().selectedFile).toBe("a.txt");

    s().switchTab("/b");
    expect(s().selectedOid).toBe("bbb");
  });

  it("re-setting the active repo keeps its selection — it is also the watcher's HEAD-moved path", () => {
    s().setRepo(repo("/a"));
    s().selectOid("aaa");
    s().setRepo(repo("/a", "feature"));
    expect(s().selectedOid).toBe("aaa");
    expect(s().repo?.head.branch).toBe("feature");
  });

  it("does not close the clone form when the active repo is merely refreshed", () => {
    s().setRepo(repo("/a"));
    s().setCloneOpen(true);
    s().setRepo(repo("/a", "feature"));
    expect(s().cloneOpen).toBe(true);
    // A genuine switch does close it.
    s().setRepo(repo("/b"));
    expect(s().cloneOpen).toBe(false);
  });

  it("closing the active tab hands focus to its right-hand neighbour", () => {
    for (const p of ["/a", "/b", "/c"]) s().setRepo(repo(p));
    s().switchTab("/b");
    s().closeTab("/b");
    expect(s().repo?.path).toBe("/c");
  });

  it("closing the last tab falls back to the left-hand neighbour", () => {
    for (const p of ["/a", "/b"]) s().setRepo(repo(p));
    s().closeTab("/b");
    expect(s().repo?.path).toBe("/a");
  });

  it("closing an inactive tab does not move the selection", () => {
    for (const p of ["/a", "/b"]) s().setRepo(repo(p));
    s().selectOid("bbb");
    s().closeTab("/a");
    expect(s().repo?.path).toBe("/b");
    expect(s().selectedOid).toBe("bbb");
  });

  it("closing the only tab returns to the start screen with no repo", () => {
    s().setRepo(repo("/a"));
    s().closeTab("/a");
    expect(s().repo).toBeNull();
    expect(s().activeStart).toBe(true);
    expect(s().startTab).toBe(true);
    expect(s().selectedOid).toBeNull();
  });

  it("forgets a closed tab's view rather than restoring it on reopen", () => {
    s().setRepo(repo("/a"));
    s().selectOid("aaa");
    s().setRepo(repo("/b"));
    s().closeTab("/a");
    s().setRepo(repo("/a"));
    expect(s().selectedOid).toBeNull();
  });

  it("reorders tabs and ignores out-of-range moves", () => {
    for (const p of ["/a", "/b", "/c"]) s().setRepo(repo(p));
    s().moveTab(0, 2);
    expect(s().tabs.map((t) => t.path)).toEqual(["/b", "/c", "/a"]);
    s().moveTab(1, 1);
    s().moveTab(-1, 0);
    s().moveTab(0, 9);
    expect(s().tabs.map((t) => t.path)).toEqual(["/b", "/c", "/a"]);
  });
});

describe("the start tab is the app's floor", () => {
  it("cannot be closed when nothing else is open", () => {
    s().closeStart();
    expect(s().startTab).toBe(true);
    expect(s().activeStart).toBe(true);
  });

  it("closes to the last repo tab when one exists", () => {
    s().setRepo(repo("/a"));
    s().openStart();
    expect(s().repo).toBeNull();
    s().closeStart();
    expect(s().startTab).toBe(false);
    expect(s().repo?.path).toBe("/a");
    expect(s().activeStart).toBe(false);
  });

  it("closing it while a repo is active only removes it from the strip", () => {
    s().setRepo(repo("/a"));
    s().closeStart();
    expect(s().startTab).toBe(false);
    expect(s().repo?.path).toBe("/a");
  });

  it("opening it remembers the selection of the tab it left", () => {
    s().setRepo(repo("/a"));
    s().selectOid("aaa");
    s().openStart();
    expect(s().repo).toBeNull();
    expect(s().selectedOid).toBeNull();
    s().switchTab("/a");
    expect(s().selectedOid).toBe("aaa");
  });
});

describe("recent repos", () => {
  it("records most-recent-first, without duplicates", () => {
    s().setRepo(repo("/a"));
    s().setRepo(repo("/b"));
    s().setRepo(repo("/a"));
    expect(s().recentRepos.map((r) => r.path)).toEqual(["/a", "/b"]);
  });

  it("caps the list at twelve", () => {
    for (let i = 0; i < 20; i++) s().setRepo(repo(`/r${i}`));
    expect(s().recentRepos).toHaveLength(12);
    expect(s().recentRepos[0].path).toBe("/r19");
  });

  it("persists enough to draw a row without opening the repository", () => {
    s().setRepo(repo("/x/y/proj", "develop"));
    const stored = JSON.parse(localStorage.getItem("mtgit.recentRepos") ?? "[]");
    expect(stored[0]).toMatchObject({ path: "/x/y/proj", name: "proj", branch: "develop" });
    expect(stored[0].lastOpened).toBeGreaterThan(0);
  });

  it("forgets one entry without touching the others", () => {
    s().setRepo(repo("/a"));
    s().setRepo(repo("/b"));
    s().forgetRecent("/a");
    expect(s().recentRepos.map((r) => r.path)).toEqual(["/b"]);
    expect(JSON.parse(localStorage.getItem("mtgit.recentRepos") ?? "[]")).toHaveLength(1);
  });
});

/**
 * `loadRecent` runs once, when the module is constructed, so these reach it by
 * seeding storage and re-importing. The migration matters because the recent
 * list is the only repo memory the app has: getting it wrong on upgrade loses
 * every repo the user has ever opened.
 */
describe("recent-repo storage is read once, at construction", () => {
  async function freshStore(raw: string | null) {
    if (raw === null) localStorage.removeItem("mtgit.recentRepos");
    else localStorage.setItem("mtgit.recentRepos", raw);
    vi.resetModules();
    return (await import("./session")).useSession.getState();
  }

  it("migrates the old bare string[] into full records", async () => {
    const store = await freshStore(JSON.stringify(["/x/y/alpha", "/x/y/beta"]));
    expect(store.recentRepos).toEqual([
      { path: "/x/y/alpha", name: "alpha", lastOpened: 0, branch: null },
      { path: "/x/y/beta", name: "beta", lastOpened: 0, branch: null },
    ]);
  });

  it("keeps records written by the current version as they are", async () => {
    const record = { path: "/a", name: "a", lastOpened: 123, branch: "main" };
    const store = await freshStore(JSON.stringify([record]));
    expect(store.recentRepos).toEqual([record]);
  });

  it("starts empty rather than throwing on absent, corrupt or wrong-shaped storage", async () => {
    expect((await freshStore(null)).recentRepos).toEqual([]);
    expect((await freshStore("{not json")).recentRepos).toEqual([]);
    expect((await freshStore('{"not":"an array"}')).recentRepos).toEqual([]);
  });

  it("drops entries with no path instead of rendering a row that cannot open", async () => {
    const store = await freshStore(JSON.stringify([null, { name: "no path" }, "/a"]));
    expect(store.recentRepos.map((r) => r.path)).toEqual(["/a"]);
  });
});

describe("view state", () => {
  it("selecting a commit clears the selected file", () => {
    s().selectFile("a.txt");
    s().selectOid("aaa");
    expect(s().selectedFile).toBeNull();
  });

  it("hides and re-shows a ref per repo", () => {
    s().toggleHiddenRef("/a", "origin/main");
    s().toggleHiddenRef("/b", "origin/main");
    expect(s().hiddenRefs["/a"]).toEqual(["origin/main"]);
    s().toggleHiddenRef("/a", "origin/main");
    expect(s().hiddenRefs["/a"]).toEqual([]);
    expect(s().hiddenRefs["/b"]).toEqual(["origin/main"]);
  });
});
