import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStores } from "../../test/stores";
import { useSession } from "../../stores/session";
import { OPEN_SETTINGS_EVENT } from "../../stores/settings";
import type { RepoInfo } from "../../ipc/types";
import { TabBar } from "./TabBar";

beforeEach(() => {
  resetStores();
});

function makeRepo(name: string, path: string): RepoInfo {
  return {
    name,
    path,
    head: { branch: "main", oid: "a".repeat(40), detached: false, unborn: false },
    isBare: false,
    worktree: null,
  };
}

const repo = makeRepo("fixture", "/repo");

function withOneTab() {
  useSession.setState({ repo, tabs: [repo], startTab: true, activeStart: false });
}

/**
 * The strip is the window's titlebar on macOS, which makes two things true that
 * were not true of an ordinary row: the whole row drags the window, and the
 * controls at its end sit outside the scroller.
 *
 * Both fail silently. A control left inside the drag region stops responding to
 * clicks with no error; one left inside the scroller simply rides off the right
 * edge once enough repositories are open. Neither is visible from the file that
 * would break them, so both are pinned here.
 */
describe("titlebar", () => {
  // Asserted against the stylesheet source, read from disk. vitest neither
  // applies an imported stylesheet nor serves it through `?raw`, so both
  // `toHaveStyle` and a raw import would see nothing here and pass whatever
  // the file actually said — which is the opposite of a guard.
  const css = readFileSync("src/features/tabs/tabs.css", "utf8");

  it("lets every control in the strip escape the window drag region", () => {
    expect(css).toMatch(/\.tab-bar\s*\{[^}]*-webkit-app-region:\s*drag/);

    for (const selector of [".tab", ".tab-close", ".tab-add", ".tab-bar-icon"]) {
      const rule = new RegExp(`\\${selector}\\s*\\{[^}]*-webkit-app-region:\\s*no-drag`);
      expect(css, `${selector} would be undraggable`).toMatch(rule);
    }
  });

  it("reserves the traffic-light gutter on macOS only", () => {
    // Windows and Linux still draw their own titlebar, so the gutter there is
    // padding in front of nothing. `main.tsx` writes the attribute.
    expect(css).toMatch(/:root\[data-platform="macos"\]\s*\.tab-bar\s*\{[^}]*padding-left/);
    expect(css).not.toMatch(/^\.tab-bar\s*\{[^}]*padding-left/m);
  });

  it("keeps the window controls outside the scrolling strip", () => {
    withOneTab();
    const { container } = render(<TabBar />);

    expect(container.querySelector(".tab-strip .tab-bar-icon")).toBeNull();
    expect(container.querySelector(".tab-bar-right .tab-bar-icon")).not.toBeNull();
    expect(container.querySelector(".tab-strip .tab")).not.toBeNull();
  });

  it("opens settings from the window controls", async () => {
    withOneTab();
    const opened = vi.fn();
    window.addEventListener(OPEN_SETTINGS_EVENT, opened);
    try {
      render(<TabBar />);
      await userEvent.click(screen.getByRole("button", { name: "Settings" }));
      expect(opened).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(OPEN_SETTINGS_EVENT, opened);
    }
  });
});

describe("tabs", () => {
  it("marks only the active repository's tab as selected", () => {
    useSession.setState({
      repo,
      tabs: [repo, makeRepo("other", "/other")],
      startTab: false,
      activeStart: false,
    });
    render(<TabBar />);

    const selected = screen
      .getAllByRole("tab")
      .filter((tab) => tab.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveTextContent("fixture");
  });

  it("switches to a tab that is clicked", async () => {
    const other = makeRepo("other", "/other");
    useSession.setState({ repo, tabs: [repo, other], startTab: false, activeStart: false });
    render(<TabBar />);

    await userEvent.click(screen.getByRole("tab", { name: /other/ }));
    expect(useSession.getState().repo?.path).toBe("/other");
  });
});
