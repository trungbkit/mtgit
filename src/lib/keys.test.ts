import { beforeEach, describe, expect, it } from "vitest";
import { resetStores } from "../test/stores";
import { useSettings } from "../stores/settings";
import {
  ACTIONS,
  bindings,
  chordFor,
  chordFromEvent,
  formatChord,
  isTypingTarget,
  matches,
  validateChord,
} from "./keys";

function key(init: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

beforeEach(() => {
  resetStores();
  useSettings.setState({ settings: { ...useSettings.getState().settings, keybindings: {} } });
});

describe("chordFromEvent", () => {
  it("writes modifiers in a fixed order so two spellings cannot disagree", () => {
    expect(chordFromEvent(key({ key: "z", metaKey: true, shiftKey: true, altKey: true }))).toBe(
      "Mod+Alt+Shift+Z",
    );
  });

  it("reads Ctrl and Meta as the same Mod", () => {
    expect(chordFromEvent(key({ key: "k", metaKey: true }))).toBe("Mod+K");
    expect(chordFromEvent(key({ key: "k", ctrlKey: true }))).toBe("Mod+K");
  });

  it("upper-cases letters so caps lock does not change the binding", () => {
    expect(chordFromEvent(key({ key: "K", metaKey: true }))).toBe("Mod+K");
  });

  it("keeps named keys as they are", () => {
    expect(chordFromEvent(key({ key: "Enter", metaKey: true }))).toBe("Mod+Enter");
    expect(chordFromEvent(key({ key: "F3" }))).toBe("F3");
    expect(chordFromEvent(key({ key: "F3", shiftKey: true }))).toBe("Shift+F3");
  });

  it("drops Shift where it already changed the character", () => {
    // On a US layout Shift+/ *is* '?'. A chord of "Shift+?" could never match
    // anything a user is able to type.
    expect(chordFromEvent(key({ key: "?", shiftKey: true }))).toBe("?");
    expect(chordFromEvent(key({ key: "~", shiftKey: true }))).toBe("~");
    // For a letter the shift is a genuine modifier, so it stays.
    expect(chordFromEvent(key({ key: "Z", metaKey: true, shiftKey: true }))).toBe("Mod+Shift+Z");
  });

  it("ignores a bare modifier press", () => {
    for (const k of ["Shift", "Control", "Meta", "Alt"]) {
      expect(chordFromEvent(key({ key: k })), k).toBeNull();
    }
  });
});

describe("matches", () => {
  it("fires for an action's own chord", () => {
    expect(matches(key({ key: "k", metaKey: true }), "palette.open")).toBe(true);
    expect(matches(key({ key: "k" }), "palette.open")).toBe(false);
  });

  it("fires for a fixed alternate, which is how F3 and ⌘G both mean next", () => {
    expect(matches(key({ key: "F3" }), "search.next")).toBe(true);
    expect(matches(key({ key: "g", metaKey: true }), "search.next")).toBe(true);
    expect(matches(key({ key: "F3", shiftKey: true }), "search.prev")).toBe(true);
    expect(matches(key({ key: "F3", shiftKey: true }), "search.next")).toBe(false);
  });

  it("follows a rebinding, and the old chord stops working", () => {
    useSettings.getState().set({ keybindings: { "palette.open": "Mod+Alt+P" } });
    expect(matches(key({ key: "p", metaKey: true, altKey: true }), "palette.open")).toBe(true);
    expect(matches(key({ key: "k", metaKey: true }), "palette.open")).toBe(false);
  });

  it("does not confuse an action with its shifted neighbour", () => {
    // Mod+Z / Mod+Shift+Z and Mod+P / Mod+Shift+P are the pairs most likely to
    // bleed into each other, and both are destructive in one direction.
    expect(matches(key({ key: "z", metaKey: true }), "undo")).toBe(true);
    expect(matches(key({ key: "z", metaKey: true }), "redo")).toBe(false);
    expect(matches(key({ key: "Z", metaKey: true, shiftKey: true }), "redo")).toBe(true);
    expect(matches(key({ key: "Z", metaKey: true, shiftKey: true }), "undo")).toBe(false);
    expect(matches(key({ key: "p", metaKey: true }), "push")).toBe(true);
    expect(matches(key({ key: "P", metaKey: true, shiftKey: true }), "push")).toBe(false);
    expect(matches(key({ key: "P", metaKey: true, shiftKey: true }), "pull")).toBe(true);
  });
});

describe("the default map", () => {
  it("binds every action exactly once, with no chord claimed twice", () => {
    const seen = new Map<string, string>();
    for (const action of ACTIONS) {
      for (const chord of [action.chord, ...(action.also ?? [])]) {
        expect(seen.has(chord), `${chord} is claimed by ${seen.get(chord)} and ${action.id}`).toBe(
          false,
        );
        seen.set(chord, action.id);
      }
    }
    expect(Object.keys(bindings())).toHaveLength(ACTIONS.length);
  });

  it("reports an override through chordFor and leaves the rest alone", () => {
    useSettings.getState().set({ keybindings: { undo: "Mod+Alt+U" } });
    expect(chordFor("undo")).toBe("Mod+Alt+U");
    expect(chordFor("redo")).toBe("Mod+Shift+Z");
  });

  it("ignores an override for an action that no longer exists", () => {
    useSettings.getState().set({ keybindings: { "removed.action": "Mod+Q" } });
    expect(Object.keys(bindings())).toHaveLength(ACTIONS.length);
  });
});

describe("validateChord", () => {
  it("accepts a modified chord and a function key", () => {
    expect(validateChord("Mod+Alt+Y", "undo")).toBeNull();
    expect(validateChord("F7", "undo")).toBeNull();
  });

  it("refuses a bare key, which would break the app outside a text field", () => {
    expect(validateChord("Y", "undo")).toMatch(/Ctrl/);
    expect(validateChord("Shift+Y", "undo")).toMatch(/Ctrl/);
    expect(validateChord("", "undo")).toMatch(/Press a key/);
  });

  it("refuses a chord another action already owns, naming it", () => {
    expect(validateChord("Mod+K", "undo")).toMatch(/Command palette/);
    // Including an action's fixed alternates, which are just as taken.
    expect(validateChord("Mod+G", "undo")).toMatch(/Next match/);
  });

  it("lets an action keep the chord it already has", () => {
    expect(validateChord("Mod+Z", "undo")).toBeNull();
  });

  it("frees a chord once its owner has moved off it", () => {
    useSettings.getState().set({ keybindings: { "palette.open": "Mod+Alt+P" } });
    expect(validateChord("Mod+K", "undo")).toBeNull();
  });
});

describe("presentation", () => {
  it("renders a chord with platform glyphs", () => {
    // The suite runs under jsdom, which is not a Mac, so this is the Ctrl form.
    expect(formatChord("Mod+Shift+Z")).toBe("Ctrl+Shift+Z");
    expect(formatChord("Mod+Enter")).toBe("Ctrl+↵");
    expect(formatChord("F3")).toBe("F3");
  });
});

describe("isTypingTarget", () => {
  it("recognises the places a keystroke belongs to the user, not the app", () => {
    for (const tag of ["input", "textarea", "select"]) {
      const el = document.createElement(tag);
      expect(isTypingTarget({ target: el } as unknown as KeyboardEvent), tag).toBe(true);
    }
    // jsdom does not implement `isContentEditable`, so it is defined here
    // rather than set through `contentEditable`.
    const editable = document.createElement("div");
    Object.defineProperty(editable, "isContentEditable", { value: true });
    expect(isTypingTarget({ target: editable } as unknown as KeyboardEvent)).toBe(true);
  });

  it("leaves ordinary elements alone", () => {
    expect(isTypingTarget({ target: document.createElement("div") } as unknown as KeyboardEvent)).toBe(
      false,
    );
    expect(isTypingTarget({ target: null } as unknown as KeyboardEvent)).toBe(false);
  });
});
