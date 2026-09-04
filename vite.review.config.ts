/** Serves review.html with the Tauri boundary aliased to local mocks. See .review-tmp/. */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@tauri-apps/api/core": here("./.review-tmp/mock-core.ts"),
      "@tauri-apps/plugin-dialog": here("./.review-tmp/mock-dialog.ts"),
    },
  },
  server: { port: 5199, strictPort: true },
});
