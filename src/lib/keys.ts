/**
 * The keyboard map (G13).
 *
 * Before this, every shortcut was an inline `event.metaKey && event.key === …`
 * inside the component that happened to own the action. That is why there was
 * no cheat sheet and no rebinding: nothing in the app knew the full set, and
 * two handlers could claim the same chord without anything noticing.
 *
 * Handlers now ask `matches(event, "palette.open")` instead of reading the
 * event themselves. The chord lives here, the *override* lives in settings,
 * and the cheat sheet is a render of this list rather than a second copy of it.
 *
 * Chord grammar: modifiers in the fixed order `Mod`, `Alt`, `Shift`, then the
 * key, joined by `+`. `Mod` is ⌘ on macOS and Ctrl elsewhere — and, when
 * *reading* an event, either one, because a user on an external PC keyboard
 * reaching for Ctrl is not making a mistake worth refusing.
 */

import { useSettings } from "../stores/settings";

export type ActionId =
  | "palette.open"
  | "terminal.toggle"
  | "sidebar.filter"
  | "settings.open"
  | "help.shortcuts"
  | "undo"
  | "redo"
  | "push"
  | "pull"
  | "search.focus"
  | "search.next"
  | "search.prev"
  | "commit.focus"
  | "commit.submit";

export interface Action {
  id: ActionId;
  label: string;
  group: string;
  /** The default chord; an entry in `settings.keybindings` replaces it. */
  chord: string;
  /**
   * Fixed alternates, not rebindable. These exist where two chords are both
   * idiomatic — F3 is the platform convention for "find next" and ⌘G is the
   * Mac one, and picking a winner would be wrong on one platform.
   */
  also?: string[];
  note?: string;
}

export const ACTIONS: Action[] = [
  { id: "palette.open", label: "Command palette", group: "Application", chord: "Mod+K" },
  { id: "settings.open", label: "Settings", group: "Application", chord: "Mod+," },
  { id: "help.shortcuts", label: "Keyboard shortcuts", group: "Application", chord: "?" },
  { id: "terminal.toggle", label: "Toggle terminal", group: "Application", chord: "Mod+`" },
  { id: "sidebar.filter", label: "Filter refs in sidebar", group: "Application", chord: "Mod+F" },

  { id: "undo", label: "Undo", group: "Repository", chord: "Mod+Z" },
  { id: "redo", label: "Redo", group: "Repository", chord: "Mod+Shift+Z" },
  { id: "push", label: "Push", group: "Repository", chord: "Mod+P" },
  { id: "pull", label: "Pull", group: "Repository", chord: "Mod+Shift+P" },

  {
    id: "search.focus",
    label: "Search commits",
    group: "Graph",
    chord: "Mod+Shift+F",
    note: "Mod+F also focuses search while the graph has focus",
  },
  { id: "search.next", label: "Next match", group: "Graph", chord: "F3", also: ["Mod+G"] },
  {
    id: "search.prev",
    label: "Previous match",
    group: "Graph",
    chord: "Shift+F3",
    also: ["Mod+Shift+G"],
  },

  { id: "commit.focus", label: "Focus commit message", group: "Commit", chord: "Mod+Shift+C" },
  { id: "commit.submit", label: "Commit", group: "Commit", chord: "Mod+Enter" },
];

const BY_ID = new Map(ACTIONS.map((action) => [action.id, action]));

export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/**
 * The chord an event represents, in this module's grammar, or null for a bare
 * modifier press.
 *
 * Shift is recorded only for keys whose identity it does not already change:
 * on a US layout `Shift+/` produces `?`, and a chord of `Shift+?` would never
 * match anything a user could type.
 */
export function chordFromEvent(event: KeyboardEvent): string | null {
  const key = event.key;
  if (!key || key === "Shift" || key === "Control" || key === "Meta" || key === "Alt") return null;

  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push("Mod");
  if (event.altKey) parts.push("Alt");

  const printable = key.length === 1;
  const alphanumeric = printable && /[a-z0-9]/i.test(key);
  if (event.shiftKey && (!printable || alphanumeric)) parts.push("Shift");

  parts.push(printable ? key.toUpperCase() : key);
  return parts.join("+");
}

/** Every binding in force: the defaults, with the user's overrides applied. */
export function bindings(): Record<ActionId, string> {
  const overrides = useSettings.getState().settings.keybindings;
  const out = {} as Record<ActionId, string>;
  for (const action of ACTIONS) out[action.id] = overrides[action.id] || action.chord;
  return out;
}

/** The chord bound to one action right now. */
export function chordFor(id: ActionId): string {
  const action = BY_ID.get(id);
  if (!action) return "";
  return useSettings.getState().settings.keybindings[id] || action.chord;
}

/** Does this event trigger `id`? */
export function matches(event: KeyboardEvent, id: ActionId): boolean {
  const chord = chordFromEvent(event);
  if (!chord) return false;
  if (chord === chordFor(id)) return true;
  return BY_ID.get(id)?.also?.includes(chord) ?? false;
}

/**
 * Is the user typing into something?
 *
 * A single-character chord like `?` must not fire while a commit message is
 * being written, and neither must anything else that would swallow the
 * keystroke. Chords carrying a modifier are exempt: `Mod+Enter` inside the
 * commit box is exactly where it is meant to work.
 */
export function isTypingTarget(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!target.isContentEditable;
}

const GLYPHS: Record<string, string> = {
  Mod: IS_MAC ? "⌘" : "Ctrl",
  Alt: IS_MAC ? "⌥" : "Alt",
  Shift: IS_MAC ? "⇧" : "Shift",
  Enter: "↵",
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/** A chord as the cheat sheet shows it. */
export function formatChord(chord: string): string {
  const parts = chord.split("+").map((part) => GLYPHS[part] ?? part);
  // On macOS the glyphs read as one token; elsewhere they need separators.
  return IS_MAC ? parts.join("") : parts.join("+");
}

/**
 * Why `chord` cannot be bound to `id`, or null if it can.
 *
 * A chord with no modifier is refused unless it is a function key: binding a
 * bare letter makes the app unusable the moment focus leaves a text field, and
 * it is not obvious in the rebinding UI that that is what you have done.
 */
export function validateChord(chord: string, id: ActionId): string | null {
  if (!chord) return "Press a key combination.";
  const parts = chord.split("+");
  const key = parts[parts.length - 1];
  const hasModifier = parts.length > 1 && parts.some((p) => p === "Mod" || p === "Alt");
  const isFunctionKey = /^F\d{1,2}$/.test(key);
  if (!hasModifier && !isFunctionKey) {
    return "Use a combination with Ctrl/⌘ or Alt, or a function key.";
  }

  const current = bindings();
  for (const action of ACTIONS) {
    if (action.id === id) continue;
    if (current[action.id] === chord || action.also?.includes(chord)) {
      return `Already bound to “${action.label}”.`;
    }
  }
  return null;
}
