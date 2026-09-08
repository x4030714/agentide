/** Bundles the sidecar and the `agentide` command. `zod` stays external -- the MCP server
 * compares schema instances, and a second copy breaks tool registration. */

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

// `.mjs`, not `.js`: the packaged copy has no `package.json` beside it, so Node reads a
// `.js` ESM bundle as CommonJS and dies on the first `import`.
await build({ ...shared, entryPoints: ["src/main.ts"], outfile: "dist/main.mjs" });

/** The `agentide` command. Shebang because this is a `bin` entry -- npm's POSIX shim execs
 * the file directly. */
await build({
  ...shared,
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.mjs",
  banner: { js: "#!/usr/bin/env node" },
});
