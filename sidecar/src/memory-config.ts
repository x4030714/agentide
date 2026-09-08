/** Where the SDK's auto-memory writes: a folder of markdown, which is also an Obsidian vault.
 * User level only, and never under `.agentide/` -- `ALWAYS_IGNORED` in `fs.rs` hides that. */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

/** Read per turn, so an edit lands on the next prompt rather than the next restart. */
const CONFIG_PATH = join(".agentide", "memory.json");

/** The default, and the one the docs and Settings name. */
const DEFAULT_VAULT = "agentide-vault";

const FileSchema = z.object({
  /** Absolute, or `~/`-prefixed. Relative would be ambiguous: relative to what? */
  vault: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

export interface MemoryConfig {
  /** Absolute, forward-slashed. Empty only when memory is off. */
  vault: string;
  enabled: boolean;
}

/** The vault for this turn. `home` is a parameter only so tests can point at a temp tree. */
export function loadMemoryConfig(home: string = homedir()): MemoryConfig {
  const base = slashes(home);
  let file: z.infer<typeof FileSchema> = {};

  try {
    const parsed: unknown = JSON.parse(readFileSync(join(home, CONFIG_PATH), "utf8"));
    const result = FileSchema.safeParse(parsed);
    if (result.success) {
      file = result.data;
    } else {
// A hand-edited file with a stray comma must not cost the turn; the default still stands.
      warn(`${CONFIG_PATH} is not a memory config; using the default vault`);
    }
  } catch (error) {
    if (!isMissing(error)) warn(`could not read ${CONFIG_PATH}: ${describe(error)}`);
  }

  return {
    vault: expand(file.vault ?? `${base}/${DEFAULT_VAULT}`, base),
    // On unless the file says otherwise: memory that has to be discovered and switched on
    // is memory nobody has.
    enabled: file.enabled ?? true,
  };
}

/** What the SDK is told, or `null` when memory is off. The `ask` rules are the whole approval
 * story: in Review mode (`acceptEdits`) a memory write never reaches `canUseTool` otherwise. */
export function memorySettings(config: MemoryConfig): Record<string, unknown> | null {
  if (!config.enabled) return { autoMemoryEnabled: false };
  return {
    autoMemoryEnabled: true,
    autoMemoryDirectory: config.vault,
    permissions: {
      ask: [`Write(${config.vault}/**)`, `Edit(${config.vault}/**)`],
    },
  };
}

/** `~/thing` against a known home, since the SDK is not the only reader of this path. */
function expand(raw: string, home: string): string {
  const path = slashes(raw);
  return path === "~" || path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}

function slashes(path: string): string {
  return path.split("\\").join("/").replace(/\/$/, "");
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  // ENOTDIR is the same answer here: `.agentide` exists as a file, so there is no config.
  return code === "ENOENT" || code === "ENOTDIR";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warn(text: string): void {
  process.stderr.write(`[agent-host] ${text}\n`);
}
