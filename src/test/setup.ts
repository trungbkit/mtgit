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

afterEach(() => {
  cleanup();
  localStorage.clear();
});
