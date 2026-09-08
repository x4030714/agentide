/** The parts of reading `~/.agentide/*.json` that both `mcp.json` and `providers.json` need.
 * One copy because one rule is about secrets: a second `${VAR}` expander could log a token. */

import { readFileSync } from "node:fs";
import { Socket } from "node:net";

import type { z } from "zod";

/** `${VAR}` from this process's environment. Not left to the SDK, which may not expand values
 * passed as options: the header would ship a literal `${GITHUB_TOKEN}` and the 401 reads as a bad token. */
export function expandVars<T>(value: T): { value: T } | { missing: string[] } {
  const missing = new Set<string>();
  const walk = (inner: unknown): unknown => {
    if (typeof inner === "string") {
      return inner.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
        const found = process.env[name];
        if (found === undefined) {
          missing.add(`\${${name}}`);
          return whole;
        }
        return found;
      });
    }
    if (Array.isArray(inner)) return inner.map(walk);
    if (inner && typeof inner === "object") {
      return Object.fromEntries(
        Object.entries(inner as Record<string, unknown>).map(([key, nested]) => [key, walk(nested)]),
      );
    }
    return inner;
  };
  const resolved = walk(value) as T;
  return missing.size > 0 ? { missing: [...missing] } : { value: resolved };
}

/** A TCP connect, not a process lookup: listing processes on Windows costs a good fraction of
 * a second on the way to the first token, every turn. A timeout counts as closed. */
export function listening(port: number, host: string, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const settle = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
    socket.connect(port, host);
  });
}

/** Read and parse one config file; `null` means nothing usable here. A missing file is silent,
 * a permission error is not -- unreported it looks exactly like the file not existing. */
export function readJson(path: string, what: string): unknown | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (!isMissing(error)) warn(`could not read ${path}: ${describe(error)}`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    warn(`${path} is not valid JSON (${describe(error)}); its ${what} were skipped`);
    return null;
  }
}

/** Deliberately loose: anything with `disabled: true` counts. An off switch that first has to
 * be a valid entry is not an off switch. */
export function isOff(value: unknown): boolean {
  return (value as { disabled?: unknown } | null)?.disabled === true;
}

/** A zod failure as one line: `field: reason`, joined. */
export function issues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    )
    .join("; ");
}

export function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
// ENOTDIR is the same answer as ENOENT: `.agentide` exists as a file, so there is no config.
  return code === "ENOENT" || code === "ENOTDIR";
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function warn(text: string): void {
  process.stderr.write(`[agent-host] ${text}\n`);
}
