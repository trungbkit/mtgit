// Clone-URL handling for the start screen (G1). Two jobs: reject what `git
// clone` will reject anyway *before* spawning it, and guess the folder name so
// the user does not have to type it.

/** scp-style, the form GitHub's "SSH" button copies: `git@host:org/repo.git`. */
const SCP_LIKE = /^[A-Za-z0-9_.+-]+@[A-Za-z0-9_.-]+:(?!\/\/)/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * Return an error message for a URL `git clone` cannot use, else null.
 *
 * This is deliberately permissive about *reachability* — only git can answer
 * that, and guessing produces false refusals for internal hosts and helper
 * protocols. It is strict about shape, and strict about a leading `-`: the
 * value reaches a real `git` command line, where `--upload-pack=…` is an
 * arbitrary command rather than a URL. The backend rejects it too
 * (`core/remote.rs::check_url`); this is the copy that can say so while the
 * user is still typing.
 */
export function validateCloneUrl(url: string): string | null {
  const value = url.trim();
  if (!value) return "Enter a repository URL.";
  if (value.startsWith("-")) return "A URL cannot start with '-'.";
  if (/\s/.test(value)) return "A URL cannot contain spaces.";
  if (SCHEME.test(value) || SCP_LIKE.test(value)) return null;
  // A local path is a legitimate clone source, and the one case with no
  // scheme and no host.
  if (value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:[/\\]/.test(value)) return null;
  return "Enter a git URL (https://…, git@host:org/repo.git) or a local path.";
}

/**
 * The folder `git clone` would create for this URL — the same rule git uses:
 * the last path segment, with a trailing `/` and a `.git` suffix removed.
 * Returns "" when nothing sensible can be derived, so the caller can leave the
 * field empty rather than inventing a name.
 */
export function repoNameFromUrl(url: string): string {
  let value = url.trim().replace(/[/\\]+$/, "");
  if (!value) return "";
  // Strip the scp-like `user@host:` prefix so the colon does not split a path.
  const scp = SCP_LIKE.exec(value);
  if (scp) value = value.slice(scp[0].length);
  else if (SCHEME.test(value)) value = value.replace(SCHEME, "");
  // Drop a query or fragment before taking the last segment.
  value = value.split(/[?#]/)[0].replace(/[/\\]+$/, "");
  const last = value.split(/[/\\]/).pop() ?? "";
  return last.replace(/\.git$/i, "");
}

/** Join a parent directory and a folder name without doubling the separator. */
export function joinPath(parent: string, name: string): string {
  if (!parent) return name;
  if (!name) return parent;
  const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  return `${parent.replace(/[/\\]+$/, "")}${sep}${name}`;
}

/**
 * What a `git clone --progress` line is saying, as a phase and a percentage.
 *
 * git writes one line per phase and rewrites it in place with `\r`, so the
 * last carriage-return-separated chunk is the current state. Returns null for
 * lines with no percentage ("Cloning into 'x'…", remote messages), which the
 * caller shows as text rather than as bar movement.
 */
export function parseProgress(line: string): { phase: string; percent: number } | null {
  const chunk = line.split("\r").filter((part) => part.trim()).pop() ?? "";
  const match = /^(.*?):\s+(\d{1,3})%/.exec(chunk.trim());
  if (!match) return null;
  return { phase: match[1].trim(), percent: Math.min(100, Number(match[2])) };
}
