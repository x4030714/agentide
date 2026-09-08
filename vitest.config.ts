import { defineConfig } from "vitest/config";

/**
 * Scoped to `src/`. The sidecar has its own runner (`npm --prefix sidecar test`); collecting
 * it here would make one suite report the other's results.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["sidecar/**", "node_modules/**", "dist/**", ".review-tmp/**"],
  },
});
