import { readFile } from "./bridge";
import type { WirePath } from "./protocol";

/**
 * Which system prompt a turn runs on.
 *
 * Neither option replaces Claude Code's preset. `default` sends the preset alone;
 * `tuned` appends `.agentide/system.md` to it. Replacing the preset outright is possible
 * — the SDK takes a bare string — but it would discard the tool-use discipline the preset
 * carries and make us responsible for keeping that current per model release, which is a
 * bad trade for the ability to change tone.
 */
export type PromptMode = "default" | "tuned";

export const PROMPT_MODES: PromptMode[] = ["default", "tuned"];

export const PROMPT_LABEL: Record<PromptMode, string> = {
  default: "Stock",
  tuned: "Tuned",
};

export const PROMPT_HELP: Record<PromptMode, string> = {
  default: "Claude Code's own prompt, untouched.",
  tuned: "Claude Code's prompt plus .agentide/system.md.",
};

export function isPromptMode(value: unknown): value is PromptMode {
  return value === "default" || value === "tuned";
}

/** Where the tuned addition lives. A file, because it is content, not configuration. */
export const SYSTEM_PROMPT_FILE = ".agentide/system.md";

/**
 * Read the tuned addition, or `null` when there is none.
 *
 * Read per turn rather than cached, so editing the file takes effect on the next prompt
 * with no restart — the file is meant to be iterated on, and a stale cached prompt would
 * make that iteration silently useless.
 *
 * A missing file is not an error: Tuned with no file is just the preset, which is what
 * `default` sends anyway.
 */
export async function readTunedPrompt(root: WirePath | null): Promise<string | null> {
  if (!root) return null;
  try {
    const file = await readFile(`${root.replace(/\/$/, "")}/${SYSTEM_PROMPT_FILE}` as WirePath);
    const text = file.text.trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}
