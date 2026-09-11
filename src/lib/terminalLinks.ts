/**
 * Finding the refs, shas and ranges in a line of terminal output (G19).
 *
 * Only *candidate* extraction lives here. Whether a candidate is real is
 * decided by `resolve_terminal_tokens` against the repository, because that
 * is the only way "main" in a branch listing and "main" in a sentence can be
 * told apart — and because deciding it here would mean the frontend knowing
 * what a ref is, which `CLAUDE.md` invariant 5 puts on the git side.
 *
 * The cost of a candidate is one entry in a batched IPC call per hovered
 * line, so this errs slightly generous. The cost of a *miss* is a token the
 * user can see and cannot click, so it does not err much.
 */

export interface Candidate {
  text: string;
  /** 0-based column of the first character in the line. */
  start: number;
  /** 0-based column one past the last character. */
  end: number;
}

/** Object ids, ranges, and the revision syntax git prints in its own messages. */
const SHA = /\b[0-9a-f]{7,40}\b/g;
const RANGE = /(?:[\w./@{}~^-]+)?\.{2,3}(?:[\w./@{}~^-]+)?/g;
// The tail is `(?!\w)` rather than `\b`: `HEAD^` ends on a non-word character,
// so `\b` fails there and the match falls back to a bare `HEAD` — a candidate
// that resolves, to the wrong commit. `(?!\w)` still keeps `HEADER` out.
const REVISION = /\bHEAD(?:[~^]\d*)*(?!\w)/g;

/** Escape a ref name for inclusion in a RegExp source. */
function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every plausible token on `line`, de-duplicated by position.
 *
 * `refNames` are this repository's actual branch and tag names. They are
 * matched literally rather than guessed at with a word pattern: `feature/x`
 * and `release-1.2` contain characters a word pattern either splits on or
 * over-matches, and the exact set is already in hand from `listRefs`.
 */
export function findCandidates(line: string, refNames: string[]): Candidate[] {
  const found: Candidate[] = [];
  const add = (text: string, start: number) => {
    if (!text) return;
    found.push({ text, start, end: start + text.length });
  };

  for (const pattern of [SHA, RANGE, REVISION]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      // A zero-length match would spin `exec` forever.
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      add(match[0], match.index);
    }
  }

  // Longest names first, so `origin/main` wins over the `main` inside it.
  const byLength = [...new Set(refNames)].filter(Boolean).sort((a, b) => b.length - a.length);
  if (byLength.length) {
    const refs = new RegExp(`(?<![\\w/.-])(?:${byLength.map(escape).join("|")})(?![\\w/-])`, "g");
    let match: RegExpExecArray | null;
    while ((match = refs.exec(line)) !== null) {
      add(match[0], match.index);
    }
  }

  // Drop anything contained inside a longer candidate: the sha inside a
  // range, and the branch inside `origin/branch`, are already covered by the
  // wider match, and two overlapping links make an unclickable mess.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Candidate[] = [];
  for (const candidate of found) {
    const last = kept[kept.length - 1];
    if (last && candidate.start < last.end) continue;
    kept.push(candidate);
  }
  return kept;
}
