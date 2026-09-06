/**
 * Where the agent's memory lives, and whether it is on.
 *
 * The memory itself is the SDK's. It has an auto-memory system already -- a recall
 * supervisor that surfaces relevant notes into a turn, and a writer the model drives with
 * ordinary `Write` calls -- and `Settings.autoMemoryDirectory` says where those notes go.
 * All this module does is choose the directory and say who may write to it.
 *
 * ## Why a folder of markdown
 *
 * The SDK's notes are markdown with YAML frontmatter and `[[wikilinks]]`, which is exactly
 * what Obsidian reads. Pointing it at a folder makes that folder a vault: openable, graph
 * and all, with no conversion and no plugin. Obsidian does not have to be installed for
 * any of this to work -- it is a folder of text either way.
 *
 * ## Why user level only
 *
 * There is deliberately no per-workspace override. What the agent learns about this machine,
 * these languages and this person does not stop being true in a different folder, and a
 * per-project vault would make memory something you lose by opening the wrong directory.
 * This is the same argument that moved `system.md` up a level.
 *
 * ## Why not under `<workspace>/.agentide/`
 *
 * `ALWAYS_IGNORED` in `src-tauri/src/fs.rs` hides that directory from the file listing, the
 * tree, quick open and the watcher, and excludes it from checkpoints. Memory kept there
 * would be invisible to every tool the agent has for finding things.
 */

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

/**
 * The vault to use for this turn.
 *
 * `home` is a parameter only so tests can point at a temporary tree; production never
 * passes it.
 */
export function loadMemoryConfig(home: string = homedir()): MemoryConfig {
  const base = slashes(home);
  let file: z.infer<typeof FileSchema> = {};

  try {
    const parsed: unknown = JSON.parse(readFileSync(join(home, CONFIG_PATH), "utf8"));
    const result = FileSchema.safeParse(parsed);
    if (result.success) {
      file = result.data;
    } else {
      // The override is lost, the default still stands. A hand-edited file with a stray
      // comma must not cost the turn the person is in the middle of.
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

/**
 * What the SDK is told, or `null` when memory is off.
 *
 * `permissions.ask` is the whole of the approval story. Memory writes are ordinary `Write`
 * and `Edit` calls, and in Review mode -- `acceptEdits` -- an edit lands without ever
 * reaching `canUseTool`, so nothing would prompt. An ask rule forces those calls back
 * through the permission flow the app already renders and answers.
 *
 * It does not survive `bypassPermissions`, which is what Auto mode selects. Nothing does;
 * that is what Auto means.
 */
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
