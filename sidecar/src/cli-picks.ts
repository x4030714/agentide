/** Choosing a model or a backend from the terminal. A name that is not one is refused here,
 * with a suggestion: unchecked, `/model opus-5` costs a turn and then fails inside the SDK. */

import { pad, theme as plainTheme, width } from "./cli-theme.ts";
import type { Theme } from "./cli-theme.ts";
import type { ModelInfo, ProviderInfo } from "./protocol.ts";

/** Anthropic's own API, which is what runs when no provider is set. A row in the list because
 * `/provider` with no argument lists rather than clears, so nothing else could go back. */
export const CLOUD = "anthropic";

/** What `/model <text>` means. `suggestion` is the nearest thing to what was typed, for a
 * refusal that helps; both absent means it resembled nothing at all. */
export interface ModelPick {
  chosen?: ModelInfo;
  suggestion?: ModelInfo;
}

export interface Pick<T> {
  chosen?: T;
  suggestion?: T;
}

/** The item a typed name refers to, or the nearest one. Exact before near, case-insensitively.
 * Shared by both pickers: what makes a suggestion useful does not depend on what is named. */
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

// Starts-with beats merely contains, and the same rule run in reverse is what turns `opus-5`
// into a suggestion of `opus`.
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

/** The model a typed name refers to, or the nearest one. An alias resolves through
 * `resolvedModel`, so `sonnet` finds the model whose canonical id nobody memorises. */
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

/** The numbered list of backends, the cloud first. `host:port` rather than the base URL: the
 * port is the thing that is either listening or not, which is the whole of whether a turn works. */
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

/** The numbered list, one model per row. The running one carries a marker rather than sorting
 * to the top: the numbers are what gets typed, so the order must not move between printings. */
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
    // The marker is a column of its own, so a name sits at the same indent either way.
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
