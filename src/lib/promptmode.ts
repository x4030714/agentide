import { homeDir } from "@tauri-apps/api/path";

import { readFile } from "./bridge";
import type { WirePath } from "./protocol";

/**
 * Which system prompt a turn runs on.
 *
 * Neither option replaces Claude Code's preset. `default` sends the preset alone;
 * `tuned` appends system.md to it. Replacing the preset outright is possible
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
  tuned: "Claude Code's prompt plus ~/.agentide/system.md and the workspace's.",
};

export function isPromptMode(value: unknown): value is PromptMode {
  return value === "default" || value === "tuned";
}

/** Where the tuned addition lives. A file, because it is content, not configuration. */
export const SYSTEM_PROMPT_FILE = ".agentide/system.md";

/**
 * Read the tuned addition, or `null` when there is none.
 *
 * Two files, both optional: `~/.agentide/system.md` and `<workspace>/.agentide/system.md`,
 * joined in that order.
 *
 * The user-level one is why this reads two. Almost everything worth telling the model here
 * is a fact about the machine and the person -- that there is no `rust-src` so `std` will
 * not resolve, that `Bash` is removed and `ide_run` is the shell, which loops actually
 * work -- and none of that stops being true when you open a different folder. Scoping it
 * to the workspace meant Tuned did nothing at all in every directory except the one that
 * happened to contain the file, which is the opposite of what it is for.
 *
 * The project file is appended rather than substituted, so a codebase adds to what the
 * machine already said instead of replacing it. A project with nothing to add needs no
 * file, and most do not: repository-specific instruction belongs in `CLAUDE.md`, which
 * the SDK already loads on its own.
 *
 * Read per turn rather than cached, so editing either takes effect on the next prompt with
 * no restart — they are meant to be iterated on, and a stale cached prompt would make that
 * iteration silently useless.
 */
export async function readTunedPrompt(root: WirePath | null): Promise<string | null> {
  const home = await homeDir().catch(() => null);
  const roots = [home, root].filter((dir): dir is string => Boolean(dir));

  const parts: string[] = [];
  const seen = new Set<string>();
  for (const dir of roots) {
    const path = `${dir.replace(/[\\/]$/, "").split("\\").join("/")}/${SYSTEM_PROMPT_FILE}`;
    if (seen.has(path.toLowerCase())) continue;
    seen.add(path.toLowerCase());
    try {
      const file = await readFile(path as WirePath);
      const text = file.text.trim();
      // Deduplicated by content, not only by path. The same prose twice doubles the
      // tokens and reads to the model as deliberate repetition, and the two files are
      // easy to end up holding the same thing: a workspace that is the home directory, or
      // a project keeping a copy of the machine's file from before this read both.
      if (text.length > 0 && !parts.includes(text)) parts.push(text);
    } catch {
      /* A missing file is the normal case for at least one of the two. */
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}
