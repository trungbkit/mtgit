import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStores } from "../../test/stores";
import { useSettings } from "../../stores/settings";
import { listen } from "@tauri-apps/api/event";
import { gitAvailable } from "../../ipc/commands";
import { StatusBar } from "./StatusBar";

vi.mock("../../ipc/commands", () => ({
  cancelGitNetwork: vi.fn(),
  cancelSearch: vi.fn(),
  getStatus: vi.fn(),
  gitAvailable: vi.fn(),
  listRefs: vi.fn(),
  saveSettings: vi.fn(),
  getSettings: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

beforeEach(() => {
  resetStores();
  // `restoreMocks` clears every implementation before each test, so they are
  // given here rather than in the hoisted factory, which runs once. `listen`
  // in particular must resolve: the component unsubscribes through the promise
  // it returns, so an undefined one throws during unmount rather than during
  // the test.
  vi.mocked(listen).mockResolvedValue(() => {});
  vi.mocked(gitAvailable).mockResolvedValue(true);
});

function renderBar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <StatusBar />
    </QueryClientProvider>,
  );
}

/**
 * The readout was the literal string `100%`, so it said the same thing on a
 * session at 20px and one at 10px — the one place in the app that reports the
 * interface scale was the one place guaranteed to be wrong. This is the same
 * defect class `CLAUDE.md` records for `--row-height` and the inert Density
 * control, with the direction reversed: the setting worked, the readout lied.
 */
describe("the zoom readout", () => {
  it("follows the font-size setting", () => {
    const { container } = renderBar();
    expect(container.querySelector(".sb-zoom-value")).toHaveTextContent("100%");

    act(() => useSettings.getState().set({ fontSize: 16 }));
    expect(container.querySelector(".sb-zoom-value")).toHaveTextContent("123%");
  });

  it("changes the setting rather than a copy of its own", async () => {
    renderBar();
    await userEvent.click(screen.getByRole("button", { name: "Larger interface" }));
    expect(useSettings.getState().settings.fontSize).toBe(14);

    await userEvent.click(screen.getByRole("button", { name: "Smaller interface" }));
    expect(useSettings.getState().settings.fontSize).toBe(13);
  });

  it("resets to the default size when the readout itself is pressed", async () => {
    act(() => useSettings.getState().set({ fontSize: 19 }));
    renderBar();

    await userEvent.click(screen.getByRole("button", { name: /^Reset interface size/ }));
    expect(useSettings.getState().settings.fontSize).toBe(13);
  });

  it("stops at the ends of the range the backend clamps to", async () => {
    act(() => useSettings.getState().set({ fontSize: 20 }));
    renderBar();
    expect(screen.getByRole("button", { name: "Larger interface" })).toBeDisabled();

    act(() => useSettings.getState().set({ fontSize: 10 }));
    expect(screen.getByRole("button", { name: "Smaller interface" })).toBeDisabled();
  });
});
