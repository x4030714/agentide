/**
 * The parts of reading an `~/.agentide/*.json` file that more than one config needs.
 *
 * Two files now follow the same rules -- `mcp.json` and `providers.json` -- and one of
 * those rules is about secrets, so it may not exist in two copies that can drift. A second
 * `${VAR}` expander that forgot to keep the value out of the warning would put a token in
 * the log the person pastes into a bug report, and nothing would fail until it did.
 *
 * Everything here was `mcp-config.ts`'s, moved rather than rewritten; its tests are what
 * say the move was faithful.
 */

import { readFileSync } from "node:fs";
import { Socket } from "node:net";

import type { z } from "zod";

/**
 * `${VAR}` in any string of a value, replaced from this process's environment.
 *
 * Done here rather than left to the SDK, because whether the SDK expands it for values
 * passed as options -- as opposed to ones it reads from a file itself -- could not be
 * established from its types or its binary. The failure mode if it does not is the worst
 * kind: the header goes out with a literal `${GITHUB_TOKEN}`, the server answers 401, and
 * the person reads that as a bad token and reissues it.
 *
 * Returns the names it could not resolve rather than a partly-expanded value. A config
 * that half worked is the one that produces that 401.
 */
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

/**
 * Whether something is accepting connections there.
 *
 * A TCP connect rather than a process lookup. Asking Windows for the process list means
 * spawning a program and reading its output, which is a good fraction of a second on the
 * path to the first token, on every turn, to answer a question a refused connection
 * answers in under a millisecond.
 *
 * The timeout is short and counts as closed. A port that neither accepts nor refuses is
 * being dropped by a firewall, and a backend that would hang on connect is not one to hand
 * to the turn.
 */
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

/**
 * Read and parse one config file. `null` means there is nothing usable here, said once.
 *
 * A file that is not there is the normal case and worth no output. Anything else is,
 * because a permission error on a file the person wrote looks identical to it not
 * existing, and the difference is the whole reason the feature seems not to work.
 */
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

/**
 * An entry that says only that it is off.
 *
 * Deliberately loose: anything with `disabled: true` counts, whatever else it carries or
 * fails to carry. An off switch that first has to be a valid entry is not an off switch.
 */
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
  // ENOTDIR is the same answer as ENOENT here: `.agentide` exists as a file, so there is
  // no config, and saying so every turn would be noise.
  return code === "ENOENT" || code === "ENOTDIR";
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function warn(text: string): void {
  process.stderr.write(`[agent-host] ${text}\n`);
}
