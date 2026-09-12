import type { RefBadge } from "../ipc/types";

/**
 * What a graph row's refs column shows (overview §1.2).
 *
 * Two collapses happen here, and they are different things:
 *
 * - **A local branch absorbs its remote twin.** `main` and `origin/main` at
 *   the same commit are one pointer as far as the eye is concerned; the local
 *   pill grows a cloud icon instead of a second pill. They split apart on
 *   their own as soon as they diverge, because then they are on different rows.
 * - **Everything past `inlineCount` collapses into a `+N` chip.** The refs
 *   column has a fixed width, so a release commit carrying nine tags would
 *   otherwise push the graph off-screen. GitLens inlines one; the count is a
 *   setting here because the right number is a property of the repository.
 *
 * The HEAD pill is never the one hidden, and it sorts first. It is the single
 * most useful label on the screen — "where am I" — and a `+1` chip is a poor
 * place to keep the answer. (The refs column is right-aligned and clips from
 * the left, so `graph.css` gives every pill `min-width: 0` to shrink into an
 * ellipsis rather than let the first one vanish.)
 */
export interface PillPlan {
  /** Pills to render inline, HEAD first. */
  shown: RefBadge[];
  /** Pills behind the `+N` chip. Empty when nothing overflowed. */
  hidden: RefBadge[];
  /**
   * Local branch names whose remote twin was absorbed — the pills that earn a
   * cloud icon.
   */
  collapsed: Set<string>;
}

export function planRefPills(
  refs: RefBadge[],
  hiddenRefs: string[],
  inlineCount: number,
  expanded: boolean,
): PillPlan {
  const localNames = new Set(refs.filter((ref) => ref.kind === "localBranch").map((ref) => ref.name));
  const shortOf = (name: string) => name.split("/").slice(1).join("/");
  const collapsed = new Set(
    refs
      .filter((ref) => ref.kind === "remoteBranch")
      .map((ref) => shortOf(ref.name))
      .filter((name) => localNames.has(name)),
  );

  const visible = refs.filter(
    (ref) =>
      !hiddenRefs.includes(ref.name) &&
      (ref.kind !== "remoteBranch" || !collapsed.has(shortOf(ref.name))),
  );
  // A stable sort with only the HEAD pill promoted: any broader reordering
  // would move pills around as refs come and go, and the column is read by
  // position as much as by name.
  const ordered = [...visible].sort((a, b) => Number(b.isHead) - Number(a.isHead));

  const limit = Math.max(1, inlineCount);
  if (expanded || ordered.length <= limit) {
    return { shown: ordered, hidden: [], collapsed };
  }
  // One over the limit is not worth a chip: "+1" is wider than most refs and
  // costs a click to read.
  if (ordered.length === limit + 1) {
    return { shown: ordered, hidden: [], collapsed };
  }
  return { shown: ordered.slice(0, limit), hidden: ordered.slice(limit), collapsed };
}

/**
 * Does this pill point at the remote the push just moved?
 *
 * Both shapes count. `origin/main` is the obvious one; `main` counts too when
 * its remote twin was folded into it above, because then the local pill *is*
 * the remote pill on screen and flashing nothing would look like the push
 * changed nothing.
 */
export function justPushed(ref: RefBadge, pushedBranch: string | null): boolean {
  if (!pushedBranch) return false;
  if (ref.kind === "remoteBranch") return ref.name.split("/").slice(1).join("/") === pushedBranch;
  return ref.kind === "localBranch" && ref.name === pushedBranch;
}
