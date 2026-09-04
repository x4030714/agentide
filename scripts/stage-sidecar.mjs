/**
 * Stage everything the packaged app needs that `cargo` does not build.
 *
 * Three pieces travel with the binary:
 *
 * - `sidecar/dist/main.mjs`, the agent host, shipped as a Tauri resource.
 * - The production dependency closure it needs at runtime. The bundle deliberately leaves
 *   `@anthropic-ai/claude-agent-sdk` and `zod` external -- the SDK resolves a native
 *   `claude` binary from disk, and the MCP server compares `zod` schema instances, so a
 *   second bundled copy breaks tool registration. Externals only work if the packages are
 *   actually there, which is what this stages.
 * - A Node runtime to run it, shipped as a Tauri `externalBin`.
 *
 * The runtime is copied from whichever Node is running this script, which is the same one
 * the sidecar was built and tested against. Requiring the user's system Node instead would
 * make the app work on this machine and fail on a machine without Node, or -- worse --
 * against a version that behaves differently. PRODUCT.md accepts the ~80MB for exactly
 * this reason.
 *
 * Run by `npm run build:release`, which `tauri build` invokes as its beforeBuildCommand.
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The Rust host triple, which is the suffix Tauri requires on an `externalBin`.
 *
 * Asked of rustc rather than derived from `process.platform`: the two can disagree (a
 * `gnu` toolchain on Windows, an x64 Node on an arm64 host), and a wrong suffix fails at
 * bundle time with a message that does not say why.
 */
function hostTriple() {
  const output = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const host = /^host:\s*(\S+)$/m.exec(output)?.[1];
  if (!host) throw new Error("could not read the host triple from `rustc -vV`");
  return host;
}

function mb(path) {
  return `${(statSync(path).size / 1024 / 1024).toFixed(1)} MB`;
}

const bundle = join(root, "sidecar", "dist", "main.mjs");
if (!existsSync(bundle)) {
  throw new Error(`the agent host bundle is missing at ${bundle}; run \`npm run build:sidecar\``);
}

/**
 * Copy the production dependency closure next to the bundle.
 *
 * Read from `package-lock.json` rather than asked of `npm ls`. The lockfile already
 * records npm's own resolution, including which packages are dev-only, so this is the
 * same answer without a subprocess -- and shelling out to npm on Windows means either
 * `npm.cmd` (which Node refuses to spawn without a shell) or `shell: true` (which
 * concatenates arguments without escaping them). Neither is worth it to read a file.
 *
 * Deriving the list from the lockfile also keeps it correct when a dependency gains one
 * of its own. A hand-maintained list would be wrong the first time that happened, and
 * would fail at runtime in the installed app -- the worst place to find out.
 */
function stageDependencies() {
  const sidecar = join(root, "sidecar");
  const staged = join(sidecar, "dist", "node_modules");
  const lock = JSON.parse(readFileSync(join(sidecar, "package-lock.json"), "utf8"));
  if (!lock.packages) {
    throw new Error("package-lock.json has no `packages` map; it is too old a lockfile");
  }

  const wanted = Object.entries(lock.packages)
    // The root package is keyed by "" and is the thing being packaged, not a dependency.
    .filter(([path, entry]) => path.startsWith("node_modules/") && !entry.dev)
    .map(([path]) => path);
  if (wanted.length === 0) throw new Error("the lockfile lists no production dependencies");

  rmSync(staged, { recursive: true, force: true });
  let bytes = 0;
  let copied = 0;
  for (const relPath of wanted) {
    const source = join(sidecar, relPath);
    if (!existsSync(source)) continue; // An optional dependency for another platform.
    // `dereference` so a linked package ships its contents, not a dangling link.
    cpSync(source, join(sidecar, "dist", relPath), {
      recursive: true,
      dereference: true,
      force: true,
    });
    bytes += du(source);
    copied += 1;
  }
  return { count: copied, staged, bytes };
}

function du(path) {
  const entry = statSync(path);
  if (!entry.isDirectory()) return entry.size;
  let total = 0;
  for (const child of readdirSync(path)) {
    try {
      total += du(join(path, child));
    } catch {
      /* a link that goes nowhere is not worth failing a build over */
    }
  }
  return total;
}

const triple = hostTriple();
const binaries = join(root, "src-tauri", "binaries");
mkdirSync(binaries, { recursive: true });

// Tauri looks for `<name>-<triple><exe suffix>` and ships it as `<name><exe suffix>`.
const suffix = process.platform === "win32" ? ".exe" : "";
const target = join(binaries, `node-${triple}${suffix}`);
// Skipped when already current: Tauri needs this present for a dev build too, and
// copying ~80MB on every `tauri dev` would be a noticeable tax for nothing.
const current =
  existsSync(target) && statSync(target).size === statSync(process.execPath).size;
if (!current) copyFileSync(process.execPath, target);

const deps = stageDependencies();
console.log(`sidecar bundle  ${bundle} (${mb(bundle)})`);
console.log(
  `dependencies    ${deps.count} packages, ${(deps.bytes / 1024 / 1024).toFixed(0)} MB`,
);
console.log(`node runtime    ${target} (${mb(target)})${current ? " — already current" : ""}`);
console.log(`                from ${process.execPath}, ${process.version}`);
