/** What a fresh install is missing before it can run a turn, and the exact command that
 * fixes each one. Nothing here runs a model or spends anything. */

import { createRequire } from "node:module";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { loadProviders } from "./provider-config.ts";

/** One thing that is wrong, and what to type to fix it. */
export interface Problem {
  /** `blocked` means no turn can run at all; `degraded` means a feature is missing. */
  severity: "blocked" | "degraded";
  title: string;
  fix: string;
}

/** Where the CLI keeps its credentials. `CLAUDE_CONFIG_DIR` moves the whole directory. */
function credentialsFile(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), ".credentials.json");
}

/**
 * Whether a turn could authenticate. Checked from the file rather than by running the
 * binary: a spawn costs a process to learn the same thing, and neither can tell an expired
 * token from a valid one without spending a request.
 */
export function signedIn(env: NodeJS.ProcessEnv = process.env, home = homedir()): boolean {
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return true;
  return existsSync(credentialsFile(env, home));
}

/**
 * The copy agentide ships, when it ships one.
 *
 * Installed, the sidecar runs from `<resources>/sidecar/main.mjs` and the tools sit beside
 * it; in the repository it is `src-tauri/tools`. Checked because the app prefers a bundled
 * rust-analyzer and git over nothing, and a readiness check that ignored them would tell a
 * working install it was broken.
 */
export function bundled(name: string): string | null {
  const relative: Record<string, string> = {
    "rust-analyzer": "rust-analyzer/rust-analyzer.exe",
    git: "git/cmd/git.exe",
  };
  const leaf = relative[name];
  if (!leaf) return null;
  const here = fileURLToPath(new URL(".", import.meta.url));
  for (const root of [join(here, "..", "tools"), join(here, "..", "..", "src-tauri", "tools")]) {
    const candidate = join(root, leaf);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Is `name` on PATH? One stat per entry, which is cheaper than spawning it to find out. */
export function onPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      try {
        accessSync(join(dir, name + ext), constants.X_OK);
        return true;
      } catch {
        /* next */
      }
    }
  }
  return false;
}

/**
 * The `claude` executable shipped beside us, which is what `/login` runs.
 *
 * Resolved through the platform package the SDK itself resolves, so the binary a login
 * writes credentials for is the same one a turn will use. Null when the package is not
 * there, which is a broken install rather than a missing prerequisite.
 */
export function claudeBinary(): string | null {
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  try {
    const path = createRequire(import.meta.url).resolve(`${pkg}/package.json`);
    const candidate = join(path, "..", exe);
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Everything wrong with this machine, worst first.
 *
 * A configured local backend counts as signed in: it needs no Anthropic credential, and
 * telling someone running Qwen on their own GPU to go and log in is simply wrong.
 */
export function checkup(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  hasProviders = Object.keys(loadProviders()).length > 0,
  findBundled: (name: string) => string | null = bundled,
): Problem[] {
  const problems: Problem[] = [];

  if (!signedIn(env, home) && !hasProviders) {
    problems.push({
      severity: "blocked",
      title: "Not signed in, so no turn can run",
      fix: "Run /login here, or set ANTHROPIC_API_KEY in your environment",
    });
  }
  if (!claudeBinary()) {
    problems.push({
      severity: "blocked",
      title: "The bundled Claude Code binary is missing",
      fix: "Reinstall agentide; the installer ships it and something removed it",
    });
  }
  if (!onPath("git", env) && !findBundled("git")) {
    problems.push({
      severity: "degraded",
      title: "No git, so no turn can be undone",
      fix: "Reinstall agentide, which ships one, or put Git for Windows on PATH",
    });
  }
  if (!onPath("rust-analyzer", env) && !findBundled("rust-analyzer")) {
    problems.push({
      severity: "degraded",
      title: "No rust-analyzer, so the Rust code tools will not answer",
      fix: "Reinstall agentide, which ships one, or put rust-analyzer on PATH",
    });
  }
  return problems;
}

/** True when a turn can actually run. Degraded problems do not stop one. */
export function ready(problems: readonly Problem[]): boolean {
  return !problems.some((problem) => problem.severity === "blocked");
}
