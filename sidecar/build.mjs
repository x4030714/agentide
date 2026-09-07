/**
 * Bundle the sidecar to `dist/main.mjs`, and the `agentide` command to `dist/cli.mjs`.
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

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external: ["@anthropic-ai/claude-agent-sdk", "zod"],
  logLevel: "info",
};

// `.mjs`, not `.js`: the packaged copy sits beside the executable with no `package.json`
// next to it, so `"type": "module"` does not reach it and Node reads a `.js` ESM bundle as
// CommonJS and dies on the first `import`. The extension carries the format wherever the
// file ends up.
await build({ ...shared, entryPoints: ["src/main.ts"], outfile: "dist/main.mjs" });

/**
 * The `agentide` command.
 *
 * A shebang because this is a `bin` entry: npm writes a launcher that execs the file, and
 * without one the POSIX shim has nothing to hand it to. Windows uses its own `.cmd` shim
 * and ignores the line, so it costs nothing there.
 */
await build({
  ...shared,
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.mjs",
  banner: { js: "#!/usr/bin/env node" },
});
