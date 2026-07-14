// A pragmatic subset of `git check-ref-format` rules, enough to catch the
// mistakes a user makes when typing a branch or tag name into a dialog.

/** Return an error message if `name` is not a valid branch/tag name, else null. */
export function validateRefName(name: string): string | null {
  const n = name.trim();
  if (!n) return "Name cannot be empty.";
  if (/\s/.test(n)) return "Name cannot contain spaces.";
  if (/[~^:?*[\\]/.test(n)) return "Name cannot contain ~ ^ : ? * [ or \\.";
  if (n.includes("..")) return "Name cannot contain '..'.";
  if (n.includes("@{")) return "Name cannot contain '@{'.";
  if (n === "@") return "Name cannot be '@'.";
  if (/[\x00-\x1f\x7f]/.test(n)) return "Name cannot contain control characters.";
  if (n.startsWith("/") || n.endsWith("/")) return "Name cannot start or end with '/'.";
  if (n.startsWith(".") || n.endsWith(".")) return "Name cannot start or end with '.'.";
  if (n.endsWith(".lock")) return "Name cannot end with '.lock'.";
  if (n.split("/").some((seg) => seg === "" || seg.startsWith("."))) {
    return "No empty or dot-leading path segments.";
  }
  return null;
}
