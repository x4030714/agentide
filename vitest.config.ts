import { defineConfig } from "vitest/config";

/**
 * Scoped to `src/`. The sidecar is a separate project with its own runner (`node:test`,
 * run by `npm --prefix sidecar test`); letting Vitest collect those files makes one
 * suite report the other's results and hides whichever it did not run.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["sidecar/**", "node_modules/**", "dist/**", ".review-tmp/**"],
  },
});
