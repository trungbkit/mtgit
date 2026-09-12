import type { RefList } from "../ipc/types";

export type FoundRefKind = "local" | "remote" | "tag";

export interface FoundRef {
  name: string;
  oid: string;
  kind: FoundRefKind;
  /** True for the checked-out branch, which the finder marks. */
  isHead: boolean;
}

/**
 * Rank refs for the `/` branch finder (`02-checkout.md` §2).
 *
 * Unlike the command palette this never checks anything out — it scrolls to
 * and selects a branch tip — so the ranking optimises for "the one I meant"
 * rather than "the one it is safe to act on". Three rules, in order:
 *
 * 1. **Where the query matched.** An exact name beats a prefix, a prefix beats
 *    a substring, and a substring beats a scattered subsequence. Typing `main`
 *    must not offer `remainder` above `main`. A remote branch is matched from
 *    after the remote, so `main` prefix-matches `origin/main`.
 * 2. **Kind.** Local branches, then remote ones, then tags. A tag-heavy
 *    repository would otherwise bury the branch you are on.
 * 3. **Length, then name.** The shorter of two equally-good matches is the one
 *    with less of it you did not type.
 */
export function findRefs(refs: RefList | undefined, query: string, limit = 10): FoundRef[] {
  if (!refs) return [];
  const all: FoundRef[] = [
    ...refs.local.map((b) => ({ name: b.name, oid: b.oid, kind: "local" as const, isHead: b.isHead })),
    ...refs.remote.map((b) => ({ name: b.name, oid: b.oid, kind: "remote" as const, isHead: false })),
    ...refs.tags.map((b) => ({ name: b.name, oid: b.oid, kind: "tag" as const, isHead: false })),
  ];
  const needle = query.trim().toLowerCase();
  const kindRank = { local: 0, remote: 1, tag: 2 };

  const scored = all
    .map((ref) => ({ ref, score: score(ref.name.toLowerCase(), needle) }))
    .filter((entry) => entry.score >= 0)
    .sort(
      (a, b) =>
        a.score - b.score ||
        kindRank[a.ref.kind] - kindRank[b.ref.kind] ||
        a.ref.name.length - b.ref.name.length ||
        a.ref.name.localeCompare(b.ref.name),
    );
  return scored.slice(0, limit).map((entry) => entry.ref);
}

/** Lower is better; -1 means no match. An empty query matches everything. */
function score(name: string, needle: string): number {
  if (!needle) return 2;
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  // A remote branch's own name starts after the remote, and it is a prefix
  // match of the same strength: typing `main` means `origin/main` before
  // `main-release`, which is what rule 2 (kind) then decides.
  const afterSlash = name.slice(name.indexOf("/") + 1);
  if (name.includes("/") && afterSlash.startsWith(needle)) return 1;
  if (name.includes(needle)) return 2;
  return isSubsequence(name, needle) ? 3 : -1;
}

function isSubsequence(name: string, needle: string): boolean {
  let at = 0;
  for (const char of name) {
    if (char === needle[at]) at += 1;
    if (at === needle.length) return true;
  }
  return false;
}
