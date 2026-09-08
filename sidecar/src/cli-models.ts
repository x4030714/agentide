/**
 * Choosing a model from the terminal.
 *
 * `/model` lists what this installation offers; `/model 3` takes the third; `/model opus`
 * takes it by name. The list is the same one the app's picker draws -- `supportedModels()`
 * on a live query, which the warm-up already asks for -- so the terminal and the window
 * offer the same thing rather than two lists that drift.
 *
 * ## A name that is not a model is refused here
 *
 * The reason this file exists rather than a line in `cli.ts`. `/model opus-5` used to be
 * accepted in silence and fail on the *next* turn, from inside the SDK, with
 * `Model "opus-5" is not a recognized model id` -- a turn spent, and an error that reads as
 * the agent breaking rather than as a typo two prompts ago. Checking the name against the
 * list at the moment it is typed costs nothing and moves the error to where the mistake is.
 *
 * The suggestion matters as much as the refusal. `opus-5` and `opus` differ by two
 * characters and the second is right, so a refusal that does not say so leaves someone
 * guessing at a list they have not been shown.
 */

import { pad, theme as plainTheme, width } from "./cli-theme.ts";
import type { Theme } from "./cli-theme.ts";
import type { ModelInfo } from "./protocol.ts";

/**
 * What `/model <text>` means.
 *
 * `chosen` is a model to switch to. `suggestion` is the nearest thing to what was typed,
 * for a refusal that helps. Both absent means the text resembled nothing at all.
 */
export interface ModelPick {
  chosen?: ModelInfo;
  suggestion?: ModelInfo;
}

/** Every spelling that names this model. */
function names(model: ModelInfo): string[] {
  return [model.value, model.resolvedModel, model.displayName].filter(
    (name): name is string => typeof name === "string" && name.length > 0,
  );
}

/**
 * The model a typed name refers to, or the nearest one to it.
 *
 * Exact before near, and case-insensitively, because `Opus` and `opus` are the same
 * request. An alias resolves through `resolvedModel` so `sonnet` finds the model whose
 * canonical id nobody memorises.
 */
export function pickModel(typed: string, models: readonly ModelInfo[]): ModelPick {
  const wanted = typed.trim().toLowerCase();
  if (!wanted) return {};

  const exact = models.find((model) =>
    names(model).some((name) => name.toLowerCase() === wanted),
  );
  if (exact) return { chosen: exact };

  // Near, in the order that makes the suggestion useful: something that starts with what
  // was typed beats something that merely contains it, and `opus-5` -> `opus` is the
  // first of those two rules doing the work in reverse.
  const near =
    models.find((model) => names(model).some((name) => name.toLowerCase().startsWith(wanted))) ??
    models.find((model) => names(model).some((name) => wanted.startsWith(name.toLowerCase()))) ??
    models.find((model) => names(model).some((name) => name.toLowerCase().includes(wanted)));
  return near ? { suggestion: near } : {};
}

/** Whether this row is the model the next turn would run on. */
function current(model: ModelInfo, running: string | undefined): boolean {
  if (!running) return false;
  return names(model).some((name) => name.toLowerCase() === running.toLowerCase());
}

/**
 * The numbered list, one model per row.
 *
 * The running one carries a marker rather than being sorted to the top: the numbers are
 * what gets typed next, so the order has to be the same every time it is printed.
 */
export function modelRows(
  models: readonly ModelInfo[],
  running?: string,
  paint: Theme = plainTheme({ isTTY: false }),
  terminal = 100,
): string[] {
  const number = String(models.length).length;
  const label = models.reduce((widest, model) => Math.max(widest, model.displayName.length), 0);
  const room = Math.max(20, terminal - number - label - 8);
  return models.map((model, index) => {
    const here = current(model, running);
    // The marker is a column of its own, so a name is at the same indent whether or not it
    // is the one running -- a list that shifts by two characters is harder to read down.
    const mark = here ? paint.accent("›") : " ";
    const shown = here ? paint.accent(pad(model.displayName, label)) : pad(model.displayName, label);
    const note = trim(model.description, room);
    return `  ${mark} ${paint.dim(String(index + 1).padStart(number))}  ${shown}  ${paint.dim(note)}`;
  });
}

/** A description that fits on the row it is on. */
function trim(text: string, room: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return width(flat) <= room ? flat : `${flat.slice(0, room - 1).trimEnd()}…`;
}
