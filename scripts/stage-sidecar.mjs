/**
 * Stage what `cargo` does not build, for `npm run build:release`: the agent host bundle, the
 * deps it leaves external (a second copy of `zod` breaks MCP tools), and a Node to run it.
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
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The Rust host triple, the suffix Tauri requires on an `externalBin`. Asked of rustc,
 * which `process.platform` can disagree with; a wrong suffix fails without saying why.
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
 * Copy the production dependency closure next to the bundle. Derived from the lockfile,
 * which already knows what is dev-only and stays right when a dependency gains its own.
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

  /**
   * A receipt, written last, naming what this tree was built from. Its absence is what
   * tells the next run the directory is rubble rather than a tree.
   */
  const receipt = join(sidecar, "dist", ".staged.json");
  const lockStamp = statSync(join(sidecar, "package-lock.json")).mtimeMs;
  const want = { lockStamp, count: wanted.length };

  if (existsSync(receipt)) {
    try {
      const have = JSON.parse(readFileSync(receipt, "utf8"));
      // The tree is counted, not just trusted: a receipt outlives a tree deleted by
      // something that never read it -- a disk cleanup, a quarantine, a hand.
      const present = existsSync(staged) ? readdirSync(staged).length : 0;
      if (have.lockStamp === want.lockStamp && have.count === want.count && present === have.top) {
        return { count: have.copied, staged, bytes: have.bytes, reused: true };
      }
    } catch {
      /* A receipt that will not parse is no receipt; fall through and stage again. */
    }
  }

  /**
   * Copied into place rather than staged beside and renamed: Windows refuses the rename
   * with EPERM while a scanner holds the fresh 238 MB. The receipt catches a half-tree.
   */
  rmSync(receipt, { force: true });
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

  const top = readdirSync(staged).length;
  writeFileSync(receipt, JSON.stringify({ ...want, copied, bytes, top }, null, 2));
  return { count: copied, staged, bytes, reused: false };
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
  `dependencies    ${deps.count} packages, ${(deps.bytes / 1024 / 1024).toFixed(0)} MB` +
    (deps.reused ? " — already current" : ""),
);
console.log(`node runtime    ${target} (${mb(target)})${current ? " — already current" : ""}`);
console.log(`                from ${process.execPath}, ${process.version}`);
