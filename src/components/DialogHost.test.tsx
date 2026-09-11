import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { resetStores } from "../test/stores";
import { choiceDialog, confirmDialog, promptDialog, useDialog } from "../stores/dialog";
import { DialogHost } from "./DialogHost";

beforeEach(() => {
  resetStores();
});

/**
 * The promise-based dialogs replace the browser's `confirm()` / `prompt()`,
 * which a Tauri WebView renders inconsistently and which block the event loop.
 * What matters here is that every exit path settles the promise exactly once:
 * a dialog that closes without resolving hangs whatever awaited it — a merge,
 * a checkout, a delete — with no error anywhere.
 */
describe("confirm", () => {
  it("resolves true on the confirm button and closes", async () => {
    render(<DialogHost />);
    const answer = confirmDialog({ title: "Delete branch", confirmLabel: "Delete" });
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await expect(answer).resolves.toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("resolves false on Cancel, on Escape, and on a click outside", async () => {
    render(<DialogHost />);

    const byButton = confirmDialog({ title: "One" });
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await expect(byButton).resolves.toBe(false);

    const byEscape = confirmDialog({ title: "Two" });
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    await expect(byEscape).resolves.toBe(false);

    const byOutside = confirmDialog({ title: "Three" });
    await screen.findByRole("dialog");
    await userEvent.click(document.querySelector(".dialog-overlay")!);
    await expect(byOutside).resolves.toBe(false);
  });

  it("shows the message and marks a dangerous action", async () => {
    render(<DialogHost />);
    confirmDialog({ title: "Hard reset", message: "This discards changes.", danger: true });
    expect(await screen.findByText("This discards changes.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveClass("danger");
  });
});

describe("prompt", () => {
  it("resolves the trimmed value", async () => {
    render(<DialogHost />);
    const answer = promptDialog({ title: "Branch name" });
    await userEvent.type(await screen.findByRole("textbox"), "  feature/x  ");
    await userEvent.click(screen.getByRole("button", { name: "OK" }));
    await expect(answer).resolves.toBe("feature/x");
  });

  it("prefills and submits on Enter", async () => {
    render(<DialogHost />);
    const answer = promptDialog({ title: "Rename", defaultValue: "old-name" });
    expect(await screen.findByRole("textbox")).toHaveValue("old-name");
    await userEvent.keyboard("{Enter}");
    await expect(answer).resolves.toBe("old-name");
  });

  it("resolves null on cancel, so a caller can tell it apart from an empty answer", async () => {
    render(<DialogHost />);
    const answer = promptDialog({ title: "Branch name" });
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await expect(answer).resolves.toBeNull();
  });

  it("blocks submission while validate objects, and clears the error as it is fixed", async () => {
    // This is the path every branch and tag name takes: `validateRefName`
    // reaches the user through here or not at all.
    render(<DialogHost />);
    const answer = promptDialog({
      title: "Branch name",
      validate: (v) => (v.includes(" ") ? "Name cannot contain spaces." : null),
    });
    const input = await screen.findByRole("textbox");

    await userEvent.type(input, "bad name");
    await userEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.getByText("Name cannot contain spaces.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await userEvent.clear(input);
    await userEvent.type(input, "good-name");
    expect(screen.queryByText("Name cannot contain spaces.")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "OK" }));
    await expect(answer).resolves.toBe("good-name");
  });

  it("validates the trimmed value, not the raw one", async () => {
    render(<DialogHost />);
    const answer = promptDialog({
      title: "Branch name",
      validate: (v) => (v === "main" ? "That branch already exists." : null),
    });
    await userEvent.type(await screen.findByRole("textbox"), "  main  ");
    await userEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.getByText("That branch already exists.")).toBeInTheDocument();
    await userEvent.clear(screen.getByRole("textbox"));
    await userEvent.type(screen.getByRole("textbox"), "other");
    await userEvent.keyboard("{Enter}");
    await expect(answer).resolves.toBe("other");
  });
});

describe("choice", () => {
  it("resolves the chosen value", async () => {
    render(<DialogHost />);
    const answer = choiceDialog({
      title: "Cannot check out main",
      choices: [
        { label: "Stash changes and continue", value: "stash" },
        { label: "Discard changes", value: "discard", danger: true },
      ],
    });
    await userEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
    await expect(answer).resolves.toBe("discard");
  });

  it("resolves null on cancel and ignores Enter, which has no default choice", async () => {
    render(<DialogHost />);
    const answer = choiceDialog({
      title: "Pick",
      choices: [{ label: "A", value: "a" }],
      cancelLabel: "Not now",
    });
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Not now" }));
    await expect(answer).resolves.toBeNull();
  });
});

it("renders nothing when no dialog is open", () => {
  render(<DialogHost />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(useDialog.getState().current).toBeNull();
});
