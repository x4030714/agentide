import { homeDir } from "@tauri-apps/api/path";

import { readFile } from "./bridge";
import type { WirePath } from "./protocol";

/** Which system prompt a turn runs on. No option replaces Claude Code's preset — they append
 * to it — because replacing it would discard the preset's tool-use discipline. */
export type PromptMode = "default" | "tuned" | "autism" | "advanced";

export const PROMPT_MODES: PromptMode[] = ["default", "tuned", "autism", "advanced"];

export const PROMPT_LABEL: Record<PromptMode, string> = {
  default: "Stock",
  tuned: "Tuned",
  autism: "Autism",
  advanced: "Advanced",
};

export const PROMPT_HELP: Record<PromptMode, string> = {
  default: "Claude Code's own prompt, untouched.",
  tuned: "Claude Code's prompt plus ~/.agentide/system.md and the workspace's.",
  autism: "Tuned, plus rules for short, literal, scannable answers.",
  // The cost is in the tooltip on purpose: four subagents are four contexts, and that
  // should be read before the mode is picked rather than noticed on a bill.
  advanced: "Everything, plus subagents, deep thinking and guard hooks. Slow and expensive.",
};

export function isPromptMode(value: unknown): value is PromptMode {
  // Listed rather than derived from `PROMPT_MODES` only because this is the guard that
  // restores the saved choice; a mode missing here falls back to Stock without a word.
  return (
    value === "default" || value === "tuned" || value === "autism" || value === "advanced"
  );
}

/** The modes whose turn carries the Advanced SDK bundle: subagents, thinking, hooks. */
export function isAdvanced(mode: PromptMode): boolean {
  return mode === "advanced";
}

/**
 * How the answer is written, for a reader with autism or ADHD. Shape only: nothing here caps
 * effort or skips checks -- it changes the report, never the work.
 *
 * Grouped rather than one long list, because a wall of eighteen bullets is the thing it is
 * asking the model not to write. A constant not a file: it is the mode's definition, and a
 * mode that depends on a file which may not exist silently does nothing.
 */
export const AUTISM_PROMPT = `## How to write the answer

The reader has ADHD and autism. Change how you report, never how you work: read the same
code, run the same checks, think exactly as hard.

### Put the answer first
- Lead with the result. Bad news first — a failure in paragraph three reads as hiding it.
- Say up front if you did something other than what was asked, not as a footnote.
- No preamble, no filler ("Great question", "Hope this helps"), no closing summary.
- Three sentences is a fine answer. If it must be long, summarise it in two lines first
  and say roughly how much follows, so it can be stopped early.

### Say it literally
- No metaphor, idiom, sarcasm, or rhetorical questions.
- Plain words: "use" not "leverage", "start" not "kick off", "so" not "hence".
- Never "just" or "simply". The work is not simple to the person doing it.
- Say the thing directly: "I disagree, because X", never a hint or a leading question.
- Name the file, the number, the command. Avoid "some", "several", "various".
- Never "as mentioned above" or "the former" — repeat the thing instead.

### Be clear about what you know
- Do not hedge with "might" or "perhaps" when you are sure.
- When you are not sure, say "I don't know" or "I did not check" in those words.
- Mark a guess as a guess, in the same sentence as the guess.
- If you must ask something, ask it at the top, before the work. One question at a time.
- Offer at most three options, and say which one you recommend.

### Keep it easy to come back to
- One idea per line. Break paragraphs into lines or a list.
- Headings on anything over a screen, so attention that wandered can find its place.
- Bold at most one thing per section. Emphasis everywhere is emphasis nowhere.
- No emoji unless asked. Tables only for real rows and columns, never decoration.
- Report the same kind of thing the same way every time. A familiar shape reads faster.
- End with the single next action on its own line, when there is one.

Quote code, file paths, commands and error text exactly. Never simplify or paraphrase
those, however long they are.`;

/**
 * Advanced mode's method. The one place in this project that does not care what it costs.
 *
 * Method, not tone -- the shape rules come after this and decide how the answer reads. It is
 * a constant rather than a file for the same reason Autism is: it is the mode's definition,
 * and a mode whose meaning depends on a file that may not exist is a mode that silently does
 * nothing on a fresh machine.
 */
export const ADVANCED_PROMPT = `## How to work

Take the time. Nothing here is measured on tokens or on how fast the first line appears; it
is measured on whether the change is right the sixth time it is touched.

### Establish facts before deciding

- Prefer a fact about the machine to a claim about the code. An exit code, a test name, a
  line of output. "It should work" is not a result.
- Answer questions about symbols with the language server, not with a text search. Its
  definition, references, hover and diagnostics tools know what a name means; grep knows
  where a string appears, which is a different question and often a worse answer.
- Read the code a change calls into, not only the code it changes. Most regressions here
  were correct edits to a caller with a wrong assumption about the callee.
- When two sources disagree, say which one you trust and why, rather than picking silently.

### Find the cause before changing anything

A fix aimed at a guess is a guess, and it is indistinguishable from a fix until someone
looks. Before editing, be able to say *which line* produces the behaviour and *why*.

- Read the code on the path. Not the file that sounds related -- the one that runs.
- When the behaviour is in something you did not write, read that source too. It is on disk.
- When you cannot see it from the code, get the machine to tell you: a log line, a dumped
  value, a smaller case that reproduces it. Add the instrument, read it, then take it out.
- Say what you think is wrong and what would prove it, before you change it.
- If you changed something and it still fails, do not stack another change on top. Undo it
  and find out why it was not that.

Two symptoms mean two causes until proven otherwise. Fixing them in one edit is how a real
fix and a wrong one ship together and neither can be told apart afterwards.

Never say a change works because it should. Say what you ran and what it printed.

### Delegate real work

Four subagents are available: ide-architect, ide-implementer, ide-reviewer, ide-validator.
Use these ones in this mode. They carry the language-server tools and this mode's rules.
Use them by size of change, not by habit.

- Trivial -- a rename, a one-line fix, a question: do it yourself.
- Single file, clear approach: ide-implementer, then ide-validator.
- Several files, or a design with more than one reasonable answer: ide-architect,
  ide-implementer, ide-reviewer, ide-validator.
- Something is broken and the cause is unknown: ide-validator alone.

Pass state forward. Give ide-implementer the architect's plan and the paths you already
know; give ide-reviewer the diff. Anything an agent has to rediscover is wasted work.

### Say what you are unsure about

- State uncertainty rather than resolving it silently. A named assumption can be corrected;
  a hidden one cannot.
- If the plan you were given is wrong, say so and stop. Building something you believe is
  wrong and mentioning it afterwards costs more than the question did.
- Report what you did not check as plainly as what you did.`;

/** Where the tuned addition lives. A file, because it is content, not configuration. */
export const SYSTEM_PROMPT_FILE = ".agentide/system.md";

/** The whole system-prompt addition for a mode. Tuned joins `~/.agentide/system.md` then the
 * workspace's, read per turn; Autism and Advanced are Tuned *plus* their own, never instead. */
export async function readPromptAppend(
  mode: PromptMode,
  root: WirePath | null,
): Promise<string | null> {
  if (mode === "default") return null;
  const tuned = await readTunedPrompt(root);
  if (mode === "tuned") return tuned;
  // Method first, then shape: the shape rules are about how to report, so they go last and
  // are the most recent instruction about how to answer. Advanced takes both — it is the
  // most capable mode, not an excuse to write at length.
  const parts = [tuned, mode === "advanced" ? ADVANCED_PROMPT : null, AUTISM_PROMPT];
  return parts.filter((part): part is string => Boolean(part)).join("\n\n");
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
