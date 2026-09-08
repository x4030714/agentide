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

/**
 * How the answer is written, for a reader with autism or ADHD.
 *
 * Shape only. Every rule here is about the report and none is about the work: the model
 * reads the same code, runs the same tools and thinks as hard as it would have. That line
 * is the whole design -- `CLAUDE.md` forbids buying anything by making the model dumber,
 * and an output mode that quietly capped effort or skipped checks would be exactly that.
 *
 * Short on purpose. A long instruction about being brief is self-refuting, and every line
 * of it is re-read on every turn -- compute rather than money on a local backend, where
 * the whole prefix is reprocessed.
 *
 * A constant rather than a file, unlike `system.md`. This is not a fact about the machine
 * that someone tunes; it is the definition of the mode, and a mode whose meaning depends
 * on a file that may not exist would sometimes silently do nothing.
 */
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
/**
 * The whole system-prompt addition for a mode.
 *
 * The layering is the point: Autism is Tuned *plus* the shape rules, not instead of them.
 * The machine facts -- no `rust-src`, `ide_run` rather than `Bash` -- are as true in one
 * mode as the other, and a mode that dropped them to change tone would trade correctness
 * for formatting, which is the trade this project does not make.
 */
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
