import type { AutolinkPattern } from "../ipc/types";

/**
 * Turning `#123` or `PROJ-4` in a commit message into a link (G20).
 *
 * The split is a pure function over text and patterns so it can be tested
 * without a DOM, and so the *only* thing the React side does is choose an
 * element per segment. Two rules it enforces, both of which are easy to get
 * wrong by reaching for a single regex:
 *
 * 1. **The longest match at a position wins.** With both `#` and `#SUB-`
 *    configured, `#SUB-12` must not be linked as issue `SUB` — a link to the
 *    wrong ticket is worse than no link.
 * 2. **A reference must not start mid-word.** `abc#12` is a fragment or a
 *    hash, not issue 12; the character before the prefix has to be a
 *    boundary.
 */

export interface AutolinkSegment {
  text: string;
  /** Absent for plain text. */
  href?: string;
  /** The pattern that produced the link, for the title attribute. */
  prefix?: string;
}

/** URL-escape the matched reference: it lands in a path segment. */
function expand(pattern: AutolinkPattern, ref: string): string {
  return pattern.url.split("<num>").join(encodeURIComponent(ref));
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\w/]/.test(ch);
}

/** How many characters of a reference body follow `at`, or 0 for no match. */
function refLength(text: string, at: number, alphanumeric: boolean): number {
  const re = alphanumeric ? /[0-9A-Za-z]/ : /[0-9]/;
  let n = 0;
  while (at + n < text.length && re.test(text[at + n])) n++;
  return n;
}

export function splitAutolinks(text: string, patterns: AutolinkPattern[]): AutolinkSegment[] {
  if (!patterns.length || !text) return [{ text }];

  const out: AutolinkSegment[] = [];
  let plain = "";
  let i = 0;

  while (i < text.length) {
    let best: { pattern: AutolinkPattern; ref: string } | null = null;

    for (const pattern of patterns) {
      if (!pattern.prefix || !text.startsWith(pattern.prefix, i)) continue;
      // A prefix that begins with a word character (`PROJ-`) must sit on a
      // word boundary; one that begins with punctuation (`#`) already is one,
      // but must still not follow a word character.
      if (isWordChar(text[i - 1])) continue;
      const len = refLength(text, i + pattern.prefix.length, pattern.alphanumeric);
      if (!len) continue;
      const ref = text.slice(i + pattern.prefix.length, i + pattern.prefix.length + len);
      if (!best || pattern.prefix.length + ref.length > best.pattern.prefix.length + best.ref.length) {
        best = { pattern, ref };
      }
    }

    if (!best) {
      plain += text[i];
      i += 1;
      continue;
    }

    if (plain) {
      out.push({ text: plain });
      plain = "";
    }
    const matched = best.pattern.prefix + best.ref;
    out.push({ text: matched, href: expand(best.pattern, best.ref), prefix: best.pattern.prefix });
    i += matched.length;
  }

  if (plain) out.push({ text: plain });
  return out;
}
