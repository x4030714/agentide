/**
 * Where a conversation gets compacted, as a setting.
 *
 * Written straight to `~/.agentide/context.json`, which `sidecar/src/context-config.ts`
 * re-reads on every turn -- so a change lands on the next prompt with no restart and no new
 * wire message. The same arrangement `mcp.json` and `providers.json` already use: the file
 * is the interface, and this is a second editor for it rather than a second source of truth.
 */

import { homeDir } from "@tauri-apps/api/path";

import { readFile, writeFile } from "./bridge";
import type { WirePath } from "./protocol";

/** Kept in step with `DEFAULT_COMPACT_WINDOW` in the sidecar. */
export const DEFAULT_COMPACT_WINDOW = 200_000;

/** `null` is the model's whole window -- 1M on Opus 5, which is what caused the trouble. */
export type CompactWindow = number | null;

export interface CompactChoice {
  label: string;
  value: CompactWindow;
  note: string;
}

/**
 * Four, not a number box.
 *
 * The floor is the CLI's own (`--autocompact` ignores anything under 100k), and the ceiling
 * is the whole window. Between them the only thing that matters is roughly how much history
 * a turn carries, so a slider would be false precision.
 */
export const COMPACT_CHOICES: CompactChoice[] = [
  { label: "100k", value: 100_000, note: "Compacts often. The cheapest turns, the shortest memory." },
  {
    label: "200k",
    value: DEFAULT_COMPACT_WINDOW,
    note: "The default, and what every non-1M model compacts at anyway.",
  },
  { label: "500k", value: 500_000, note: "Long conversations carried whole. Turns cost more." },
  {
    label: "Full",
    value: null,
    note: "The model's entire window — 1M on Opus 5. Every request re-sends all of it.",
  },
];

const CONFIG_PATH = ".agentide/context.json";

async function configPath(): Promise<WirePath> {
  const home = (await homeDir()).replace(/[\\/]$/, "").split("\\").join("/");
  return `${home}/${CONFIG_PATH}` as WirePath;
}

/** Which choice is in effect. A missing or unreadable file is the default, same as the sidecar. */
export async function readCompactWindow(): Promise<CompactWindow> {
  try {
    const file = await readFile(await configPath());
    const parsed = JSON.parse(file.text) as { compactWindow?: unknown };
    // `null` is a decision -- the whole window, deliberately. An absent key is not.
    if (parsed.compactWindow === null) return null;
    if (typeof parsed.compactWindow === "number") return parsed.compactWindow;
    return DEFAULT_COMPACT_WINDOW;
  } catch {
    // No file is the ordinary case on a fresh install.
    return DEFAULT_COMPACT_WINDOW;
  }
}

/**
 * Write the choice.
 *
 * Read-modify-write, so a key someone added by hand survives being edited from here. The
 * file is theirs; this pane is one way in, not the owner.
 */
export async function writeCompactWindow(value: CompactWindow): Promise<void> {
  const path = await configPath();
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse((await readFile(path)).text) as Record<string, unknown>;
  } catch {
    /* A new file. */
  }
  const next = { ...existing, compactWindow: value };
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
}

/** What the label says for a value, for the note under the control. */
export function compactChoiceFor(value: CompactWindow): CompactChoice {
  return (
    COMPACT_CHOICES.find((choice) => choice.value === value) ??
    COMPACT_CHOICES.find((choice) => choice.value === DEFAULT_COMPACT_WINDOW)!
  );
}
