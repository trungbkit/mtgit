import type { MenuItem } from "../components/ContextMenu";
import type { MergeRelation } from "../ipc/types";

/**
 * The menu a ref-onto-ref drop opens (STATUS C5 and C6).
 *
 * Two things were wrong with the old pair of implementations. The sidebar
 * raised a *modal* while the graph raised a menu at the cursor, so the same
 * gesture behaved differently depending on where you dropped; and both offered
 * "Fast-forward" unconditionally, so on a diverged pair the user picked it and
 * git refused. Building the items here from a computed [`MergeRelation`] gives
 * one answer to both.
 *
 * `upToDate` still returns items rather than an empty menu: an empty menu on a
 * completed drag reads as a bug. A disabled row that says why does not.
 */
export type DropAction = "merge" | "rebase" | "ff";

export function dropMenuItems(
  target: string,
  source: string,
  relation: MergeRelation | null,
  run: (action: DropAction) => void,
): MenuItem[] {
  if (relation?.upToDate) {
    return [
      { label: `${target} already contains ${source}`, disabled: true },
      { separator: true },
      { label: `Rebase ${target} onto ${source}`, onClick: () => run("rebase") },
    ];
  }

  const items: MenuItem[] = [
    { label: `Merge ${source} into ${target}`, onClick: () => run("merge") },
    { label: `Rebase ${target} onto ${source}`, onClick: () => run("rebase") },
  ];

  // A null relation means the lookup failed. Offering the fast-forward then is
  // the lesser evil: hiding a legal option because we could not ask is worse
  // than offering one git will refuse with a clear message.
  if (relation === null || relation.canFastForward) {
    items.push({
      label: `Fast-forward ${target} to ${source}`,
      onClick: () => run("ff"),
    });
  } else {
    items.push({ label: `Fast-forward ${target} to ${source}`, disabled: true });
  }
  return items;
}
