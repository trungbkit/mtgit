import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach } from "vitest";
import { cleanup } from "@testing-library/react";

// The stores are module-level singletons, so state leaks across tests in the
// same file unless something puts it back. `resetStores` (./stores) is that
// something; this file only guarantees the environment it starts from is
// clean, because three of the four stores read `localStorage` at construction.
beforeEach(() => {
  localStorage.clear();
});

// jsdom implements no layout, so it ships no `ResizeObserver` — and a
// component that observes its own scroll container (the graph does, to resize
// the lane canvas) throws on mount rather than failing an assertion. A stub
// that never fires is correct here: nothing in jsdom would ever resize.
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});
