import { homeDir } from "@tauri-apps/api/path";

import { readFile } from "./bridge";
import type { WirePath } from "./protocol";

/** Which system prompt a turn runs on. Neither option replaces Claude Code's preset — `tuned`
 * appends to it — because replacing it would discard the preset's tool-use discipline. */
export type PromptMode = "default" | "tuned" | "autism";

export const PROMPT_MODES: PromptMode[] = ["default", "tuned", "autism"];

export const PROMPT_LABEL: Record<PromptMode, string> = {
  default: "Stock",
  tuned: "Tuned",
  autism: "Autism",
};

export const PROMPT_HELP: Record<PromptMode, string> = {
  default: "Claude Code's own prompt, untouched.",
  tuned: "Claude Code's prompt plus ~/.agentide/system.md and the workspace's.",
  autism: "Tuned, plus rules for short, literal, scannable answers.",
};

export function isPromptMode(value: unknown): value is PromptMode {
  return value === "default" || value === "tuned" || value === "autism";
}

/** How the answer is written, for a reader with autism or ADHD. Shape only: nothing here caps
 * effort or skips checks. Short on purpose, and a constant not a file — it is the mode's definition. */
export const AUTISM_PROMPT = `## How to write the answer

The reader has ADHD and autism. Change how you report, never how you work: read the same
code, run the same checks, think exactly as hard.

- Lead with the answer or the result. No preamble, no restating the question.
- Short by default. Three sentences is a fine answer.
- One idea per line. Break long paragraphs into lines or a list.
- Literal language. No metaphor, no idiom, no sarcasm, no figures of speech.
- Plain words: "use" not "leverage", "start" not "kick off", "so" not "hence".
- Be concrete. Name the file, the number, the command. Avoid "some", "several", "various".
- Say what you know plainly. Do not hedge with "might" or "perhaps" when you are sure.
- When unsure, say "I don't know" or "I did not check" in those words.
- One question at a time. If you offer options, say which one you recommend.
- Put the next thing to do on its own line at the end, when there is one.
- No filler: no "Great question", no "Hope this helps", no closing summary of what you
  just said.
- Bold at most one thing per answer. Emphasis everywhere is emphasis nowhere.
- No emoji unless asked.
- Tables only for real rows and columns, never for decoration.
- If the answer must be long, put a short summary first so it can be stopped early, and
  say roughly how long the rest is.

Quote code, file paths, commands and error text exactly. Never simplify or paraphrase
those, however long they are.`;

/** Where the tuned addition lives. A file, because it is content, not configuration. */
export const SYSTEM_PROMPT_FILE = ".agentide/system.md";

/** The whole system-prompt addition for a mode. Tuned joins `~/.agentide/system.md` then the
 * workspace's, read per turn; Autism is Tuned *plus* the shape rules, never instead of them. */
export async function readPromptAppend(
  mode: PromptMode,
  root: WirePath | null,
): Promise<string | null> {
  if (mode === "default") return null;
  const tuned = await readTunedPrompt(root);
  if (mode !== "autism") return tuned;
  // Shape last, so it is the most recent instruction about how to answer. The tuned file
  // is content; this is form, and form read first is form forgotten by the end.
  return tuned ? `${tuned}\n\n${AUTISM_PROMPT}` : AUTISM_PROMPT;
}

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
      // Deduplicated by content, not path: the two files easily hold the same prose — a workspace
      // that is the home directory, or a project keeping a copy — and that doubles the tokens.
      if (text.length > 0 && !parts.includes(text)) parts.push(text);
    } catch {
      /* A missing file is the normal case for at least one of the two. */
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}
