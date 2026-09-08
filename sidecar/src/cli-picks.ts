/**
 * Choosing a model or a backend from the terminal.
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
 *
 * `/provider` has the same two failures and gets the same treatment, which is why the
 * matching lives in `pickNamed` rather than in either command. A backend that is not in
 * `providers.json` fails later and further away than a bad model does: the turn reaches
 * `session.ts`, which refuses it rather than quietly running on the cloud, and the person
 * finds out after pressing enter on a prompt they meant to send somewhere else.
 */

import { pad, theme as plainTheme, width } from "./cli-theme.ts";
import type { Theme } from "./cli-theme.ts";
import type { ModelInfo, ProviderInfo } from "./protocol.ts";

/**
 * The backend that is not a backend: Anthropic's own API, which is what runs when no
 * provider is set. It is a row in the list because leaving it out makes going back the
 * one thing the picker cannot do -- and `/provider` with no argument lists rather than
 * clears, so there would be no way to say it at all.
 */
export const CLOUD = "anthropic";

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

export interface Pick<T> {
  chosen?: T;
  suggestion?: T;
}

/**
 * The item a typed name refers to, or the nearest one to it.
 *
 * Exact before near, and case-insensitively, because `Opus` and `opus` are the same
 * request. Shared by both pickers: the rules that make a suggestion useful do not depend
 * on whether the thing being named is a model or a backend.
 */
export function pickNamed<T>(
  typed: string,
  items: readonly T[],
  names: (item: T) => string[],
): Pick<T> {
  const wanted = typed.trim().toLowerCase();
  if (!wanted) return {};
  const spellings = (item: T) =>
    names(item).filter((name) => typeof name === "string" && name.length > 0);

  const exact = items.find((item) =>
    spellings(item).some((name) => name.toLowerCase() === wanted),
  );
  if (exact) return { chosen: exact };

  // Near, in the order that makes the suggestion useful: something that starts with what
  // was typed beats something that merely contains it, and `opus-5` -> `opus` is the
  // second of these rules doing the work in reverse.
  const near =
    items.find((item) => spellings(item).some((name) => name.toLowerCase().startsWith(wanted))) ??
    items.find((item) => spellings(item).some((name) => wanted.startsWith(name.toLowerCase()))) ??
    items.find((item) => spellings(item).some((name) => name.toLowerCase().includes(wanted)));
  return near ? { suggestion: near } : {};
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
  return pickNamed(typed, models, names);
}

/** The same, for a backend. `anthropic` names the cloud and is not in the file. */
export function pickProvider(
  typed: string,
  providers: readonly ProviderInfo[],
): Pick<ProviderInfo | typeof CLOUD> {
  return pickNamed<ProviderInfo | typeof CLOUD>(
    typed,
    [CLOUD, ...providers],
    (item) => (item === CLOUD ? [CLOUD, "cloud", "none", "off"] : [item.key]),
  );
}

/**
 * The numbered list of backends, the cloud first.
 *
 * `host:port` rather than the base URL, because the port is the thing that is either
 * listening or not -- which is the whole of whether a turn will work -- and the URL is
 * the half of the entry that never crosses into a picker anyway.
 */
export function providerRows(
  providers: readonly ProviderInfo[],
  running: string | undefined,
  paint: Theme = plainTheme({ isTTY: false }),
  terminal = 100,
): string[] {
  const rows: { key: string; where: string; note: string }[] = [
    { key: CLOUD, where: "api.anthropic.com", note: "the cloud, and the default" },
    ...providers.map((provider) => ({
      key: provider.key,
      where: `${provider.host}:${provider.port}`,
      note:
        provider.note ??
        `${provider.models.length} model${provider.models.length === 1 ? "" : "s"}${provider.start ? ", started by agentide" : ""}`,
    })),
  ];
  const here = running ?? CLOUD;
  const number = String(rows.length).length;
  const key = rows.reduce((widest, row) => Math.max(widest, row.key.length), 0);
  const where = rows.reduce((widest, row) => Math.max(widest, row.where.length), 0);
  const room = Math.max(16, terminal - number - key - where - 10);
  return rows.map((row, index) => {
    const chosen = row.key.toLowerCase() === here.toLowerCase();
    const mark = chosen ? paint.accent("›") : " ";
    const name = chosen ? paint.accent(pad(row.key, key)) : pad(row.key, key);
    return `  ${mark} ${paint.dim(String(index + 1).padStart(number))}  ${name}  ${paint.dim(pad(row.where, where))}  ${paint.dim(trim(row.note, room))}`;
  });
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
