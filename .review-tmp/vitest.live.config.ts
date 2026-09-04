import { defineConfig } from "vitest/config";

// Opt-in runner for the live language-server test. Kept out of vitest.config.ts because
// it needs a toolchain installed and takes a minute of real indexing.
export default defineConfig({
  root: ".",
  test: { include: [".review-tmp/**/*.test.ts"], exclude: ["node_modules/**"] },
});
