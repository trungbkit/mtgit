import type { StoreApi, UseBoundStore } from "zustand";
import { useConflict } from "../stores/conflict";
import { useDetailStack } from "../stores/detailStack";
import { useDialog } from "../stores/dialog";
import { useSearch } from "../stores/search";
import { useSession } from "../stores/session";
import { useSettings } from "../stores/settings";
import { useToasts } from "../stores/toasts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyStore = UseBoundStore<StoreApi<any>>;

const STORES: AnyStore[] = [
  useConflict,
  useDetailStack,
  useDialog,
  useSearch,
  useSession,
  useSettings,
  useToasts,
];

// Snapshotted at import time, which is before any test has run: the value is
// each store's initial state *including* its actions, so a replacing
// `setState` puts the whole object back rather than merging over a mutated one.
const INITIAL = new Map<AnyStore, unknown>(STORES.map((store) => [store, store.getState()]));

/**
 * Put every store back to the state it was created in.
 *
 * Call it in `beforeEach` of any suite that touches a store. It is not in the
 * global setup file on purpose: a suite that imports none of them should not
 * pay for constructing them all, and `useSession` reads `localStorage` when it
 * is constructed.
 */
export function resetStores(): void {
  for (const store of STORES) {
    store.setState(INITIAL.get(store) as never, true);
  }
}
