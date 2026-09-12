import { describe, expect, it } from "vitest";
import { justPushed, planRefPills } from "./refPills";
import type { RefBadge } from "../ipc/types";

const local = (name: string, isHead = false): RefBadge => ({ name, kind: "localBranch", isHead });
const remote = (name: string): RefBadge => ({ name, kind: "remoteBranch", isHead: false });
const tag = (name: string): RefBadge => ({ name, kind: "tag", isHead: false });

describe("graph ref pills", () => {
  it("folds a remote branch into the local branch of the same name", () => {
    const plan = planRefPills([local("main"), remote("origin/main")], [], 5, false);
    expect(plan.shown.map((r) => r.name)).toEqual(["main"]);
    expect(plan.collapsed.has("main")).toBe(true);
  });

  it("keeps a remote branch that has no local twin", () => {
    const plan = planRefPills([local("main"), remote("origin/topic")], [], 5, false);
    expect(plan.shown.map((r) => r.name)).toEqual(["main", "origin/topic"]);
  });

  it("collapses the overflow into a chip and never hides HEAD", () => {
    // HEAD arrives last, which is exactly the case a plain slice gets wrong:
    // the one pill that answers "where am I" would be the one behind the chip.
    const plan = planRefPills([tag("v1"), tag("v2"), tag("v3"), local("main", true)], [], 2, false);
    expect(plan.shown.map((r) => r.name)).toEqual(["main", "v1"]);
    expect(plan.hidden.map((r) => r.name)).toEqual(["v2", "v3"]);
  });

  it("does not raise a chip to hide a single pill", () => {
    // "+1" is wider than most refs and costs a click to read, so a row one
    // over the limit shows all of them.
    const plan = planRefPills([tag("v1"), tag("v2"), tag("v3")], [], 2, false);
    expect(plan.shown).toHaveLength(3);
    expect(plan.hidden).toHaveLength(0);
  });

  it("shows everything once expanded", () => {
    const refs = [tag("v1"), tag("v2"), tag("v3"), tag("v4")];
    expect(planRefPills(refs, [], 1, true).shown).toHaveLength(4);
    expect(planRefPills(refs, [], 1, true).hidden).toHaveLength(0);
  });

  it("drops refs the sidebar's eye toggle hid, before counting the overflow", () => {
    const plan = planRefPills([tag("v1"), tag("v2"), tag("v3"), tag("v4")], ["v1"], 1, false);
    expect(plan.shown.map((r) => r.name)).toEqual(["v2"]);
    expect(plan.hidden.map((r) => r.name)).toEqual(["v3", "v4"]);
  });

  it("treats an inline count of zero as one", () => {
    // The clamp lives in the settings file too, but a stale store value must
    // not turn every row's refs column into a bare chip.
    const plan = planRefPills([tag("v1"), tag("v2"), tag("v3"), tag("v4")], [], 0, false);
    expect(plan.shown.map((r) => r.name)).toEqual(["v1"]);
    expect(plan.hidden).toHaveLength(3);
  });
});

describe("the push flash", () => {
  it("marks the remote pill and the local pill that absorbed it", () => {
    expect(justPushed(remote("origin/main"), "main")).toBe(true);
    expect(justPushed(local("main"), "main")).toBe(true);
  });

  it("does not mark a different branch, or a tag of the same name", () => {
    expect(justPushed(remote("origin/topic"), "main")).toBe(false);
    expect(justPushed(tag("main"), "main")).toBe(false);
    expect(justPushed(local("main"), null)).toBe(false);
  });

  it("matches a remote branch with slashes in its name", () => {
    // `upstream/feat/login` is `feat/login` on the remote, not `feat`.
    expect(justPushed(remote("upstream/feat/login"), "feat/login")).toBe(true);
    expect(justPushed(remote("upstream/feat/login"), "feat")).toBe(false);
  });
});
