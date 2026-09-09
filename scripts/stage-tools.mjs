/**
 * Fetch the two programs agentide needs and cannot assume: rust-analyzer, and a git.
 * Pinned, cached, and extracted into `src-tauri/tools` for the bundler to ship.
 *
 *   node scripts/stage-tools.mjs          # fetch what is missing
 *   node scripts/stage-tools.mjs --force  # fetch again even if it is there
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tools = join(root, "src-tauri", "tools");
const cache = join(root, "node_modules", ".cache", "agentide-tools");
const FORCE = process.argv.includes("--force");

/**
 * Pinned, not `latest`. A build that fetches whatever shipped this morning is a build
 * nobody can reproduce, and a language server that changes under you turns an unrelated
 * bug report into an afternoon. Bump these deliberately.
 */
const PINS = {
  rustAnalyzer: {
    version: "2026-09-07",
    url: (v) =>
      `https://github.com/rust-lang/rust-analyzer/releases/download/${v}/rust-analyzer-x86_64-pc-windows-msvc.zip`,
    into: "rust-analyzer",
    // The zip holds one executable under a name that is not the one we want to run.
    produces: "rust-analyzer/rust-analyzer.exe",
  },
  git: {
    version: "2.55.0.5",
    // MinGit is Git for Windows' own embedding build: no shell, no docs, no installer,
    // and every plumbing command `checkpoints.rs` shells out to.
    url: (v) =>
      `https://github.com/git-for-windows/git/releases/download/v${v.replace(/\.(\d+)$/, ".windows.$1")}/MinGit-${v}-64-bit.zip`,
    into: "git",
    produces: "git/cmd/git.exe",
  },
};

/** What is already staged, so an unchanged pin costs nothing. */
const receiptFile = join(tools, ".tools.json");
const receipt = existsSync(receiptFile)
  ? JSON.parse(readFileSync(receiptFile, "utf8"))
  : {};

/** The extractor to use. bsdtar ships with Windows 10 1803 and later. */
function unzipper() {
  if (process.platform !== "win32") return "tar";
  const system = join(process.env.SystemRoot ?? "C:\Windows", "System32", "tar.exe");
  return existsSync(system) ? system : "tar";
}

function megabytes(path) {
  return `${(statSync(path).size / 1e6).toFixed(1)} MB`;
}

function fetchAndExtract(name, pin) {
  const target = join(tools, pin.produces);
  if (!FORCE && receipt[name] === pin.version && existsSync(target)) {
    console.log(`${name.padEnd(14)} ${pin.version} — already staged`);
    return;
  }

  mkdirSync(cache, { recursive: true });
  const zip = join(cache, `${name}-${pin.version}.zip`);
  if (!existsSync(zip)) {
    console.log(`${name.padEnd(14)} downloading ${pin.version}…`);
    // curl rather than fetch: it resumes, it follows the redirect to the CDN, and it is
    // on every Windows 10 since 1803.
    execFileSync("curl", ["-fL", "--retry", "3", "-o", zip, pin.url(pin.version)], {
      stdio: "inherit",
    });
  }

  const dir = join(tools, pin.into);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Windows' own bsdtar by full path, not whatever `tar` resolves to: with Git Bash on
  // PATH that is GNU tar, which reads `C:\...` as a remote host and fails with
  // "Cannot connect to C". Node has no unzip of its own.
  execFileSync(unzipper(), ["-xf", zip, "-C", dir], { stdio: "inherit" });

  if (!existsSync(target)) {
    throw new Error(`${name}: expected ${pin.produces} after extracting, and it is not there`);
  }
  receipt[name] = pin.version;
  console.log(`${name.padEnd(14)} ${pin.version} — staged, ${megabytes(target)}`);
}

mkdirSync(tools, { recursive: true });
for (const [name, pin] of Object.entries(PINS)) fetchAndExtract(name, pin);
writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`tools staged into ${tools}`);
