/**
 * "Show me this commit in the graph."
 *
 * An event rather than a store field, because it is an *action*, not state:
 * clicking the same sha in the terminal twice must scroll to it twice, and a
 * store holding "the oid to reveal" would make the second click a no-op.
 * `GraphView` is the only listener — it owns the row list, the virtualizer
 * and the pagination that a not-yet-loaded commit needs.
 */
export const REVEAL_COMMIT_EVENT = "mtgit:reveal-commit";

export function revealCommit(oid: string) {
  window.dispatchEvent(new CustomEvent(REVEAL_COMMIT_EVENT, { detail: oid }));
}
