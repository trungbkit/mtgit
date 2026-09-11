import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Kept separate from `vite.config.ts` rather than folded into it: that file is
// what `tauri dev` drives, and its `server.strictPort` would make a stray dev
// server on 1420 fail the test run for a reason that has nothing to do with
// the tests.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/test/**"],
    },
  },
});
