/**
 * Bundle the sidecar to `dist/main.mjs`.
 *
 * Not a single-file executable. The agent SDK ships a native `claude` binary in a
 * platform package and resolves it from disk at runtime, so a `--compile`-style build
 * would produce something that still needs `node_modules` beside it. Two externals keep
 * that resolution working and keep one copy of `zod` in the process -- the MCP server
 * compares schema instances, and a second bundled copy breaks tool registration.
 *
 * Development runs `node sidecar/dist/main.mjs`. Release ships this file, a Node runtime,
 * and the production dependency closure those two externals need; see
 * `scripts/stage-sidecar.mjs` and `resolve_command` in `src-tauri/src/agent.rs`.
 */

import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  // `.mjs`, not `.js`: the packaged copy sits beside the executable with no
  // `package.json` next to it, so `"type": "module"` does not reach it and Node reads a
  // `.js` ESM bundle as CommonJS and dies on the first `import`. The extension carries
  // the format wherever the file ends up.
  outfile: "dist/main.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external: ["@anthropic-ai/claude-agent-sdk", "zod"],
  logLevel: "info",
});
