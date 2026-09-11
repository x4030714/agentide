/**
 * How big a conversation is allowed to get before the SDK compacts it.
 *
 * Opus 5 has a million-token window, and Claude Code compacts only near the window's edge.
 * So a long conversation on it is carried whole: the one that prompted this file had grown
 * to 925,000 tokens, and every request -- every tool call inside every turn -- re-read all
 * of it. A turn with ten tool calls was nine million cached tokens. Two prompts consumed a
 * Pro subscription's entire session allowance, twice in one evening.
 *
 * Nothing in the window said so. The cost was invisible until the limit was hit, which is
 * exactly the failure `CLAUDE.md` says this project keeps paying for.
 *
 * This is a trade, and it is written down as one. `CLAUDE.md` forbids "summarising history
 * the SDK would otherwise carry intact" -- but the SDK does not carry it intact; it compacts
 * at the window's edge regardless. The only question is *where*, and a ceiling the person
 * can afford beats one they discover on a bill. Anyone who wants the full million can set it.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { issues, readJson, warn } from "./config-file.ts";

/** Beside the other `~/.agentide` files. */
const CONFIG_PATH = join(".agentide", "context.json");

/**
 * 200k, which is the boundary Claude Code itself names for million-window models.
 *
 * Large enough that a real working session rarely reaches it; small enough that the request
 * behind every tool call stays a fifth of what it was. And the same figure a non-1M model
 * would have compacted at anyway, so switching models does not change the shape of a
 * conversation.
 */
export const DEFAULT_COMPACT_WINDOW = 200_000;

/** The CLI's own bounds for `--autocompact`. Outside them it is ignored, silently. */
const MIN = 100_000;
const MAX = 1_000_000;

const ConfigSchema = z.strictObject({
  /** Tokens. `null` means the model's whole window, which is the SDK's default. */
  compactWindow: z.number().int().min(MIN).max(MAX).nullable().optional(),
});

/** The compaction window to run with, or null to let the SDK decide. */
export function loadCompactWindow(home: string = homedir()): number | null {
  const parsed = readJson(join(home, CONFIG_PATH), "context");
  if (parsed === null) return DEFAULT_COMPACT_WINDOW;

  const config = ConfigSchema.safeParse(parsed);
  if (!config.success) {
    warn(`${CONFIG_PATH}: ${issues(config.error)}; using the default window`);
    return DEFAULT_COMPACT_WINDOW;
  }
  // An explicit `null` is a decision -- the whole window, on purpose. An absent key is not.
  if (config.data.compactWindow === null) return null;
  return config.data.compactWindow ?? DEFAULT_COMPACT_WINDOW;
}

/** The inline settings that carry it, merged over the memory settings in `session.ts`. */
export function contextSettings(window: number | null): Record<string, unknown> {
  return window === null ? {} : { autoCompactWindow: window };
}
