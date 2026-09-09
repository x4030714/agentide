/** What goes in the model picker, and in which group. Catalogue and pinned ids are merged, not
 * alternating: an alias moves when a new model ships, so a regression needs a fixed version. */

import type { ModelInfo, ProviderInfo } from "./protocol";

/** Version-pinned ids, offered before the catalogue exists and kept afterwards. Every one is in
 * the installed SDK's model union — a fabricated id fails at the start of a turn, not at the click. */
export const PINNED_MODELS: ModelInfo[] = [
  { value: "claude-opus-5", displayName: "Opus 5", description: "" },
  { value: "claude-opus-4-8", displayName: "Opus 4.8", description: "" },
  { value: "claude-sonnet-5", displayName: "Sonnet 5", description: "" },
  { value: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "" },
];

/** How a provider's model is spelled in the menu, so one `<select>` carries both halves — two
 * providers can offer `qwen3-coder-30b` and mean different files. `::` because neither contains it. */
const SEPARATOR = "::";

/** One group of the menu, in the order it is drawn. */
export interface ModelGroup {
  label: string;
  items: ModelInfo[];
}

export interface ModelMenu {
  /** False until a turn has run and the SDK has published its catalogue. */
  known: boolean;
  /** The installation's own entries, minus its default row. */
  catalogue: ModelInfo[];
  /** The pinned ids the catalogue does not already offer. */
  pinned: ModelInfo[];
  /** One group per configured backend, drawn under the Anthropic ones. */
  providers: ModelGroup[];
  /** Everything selectable, for resolving whichever id is currently chosen. */
  all: ModelInfo[];
}

/** The menu value that names a provider's model. */
export function providerValue(providerKey: string, modelId: string): string {
  return `${providerKey}${SEPARATOR}${modelId}`;
}

/** Split a menu value back into the two things a prompt needs. An Anthropic model has no provider,
 * which is what `undefined` means — the same as `PromptOptions.provider` being absent. */
export function decodeModel(value: string | null): { provider?: string; model?: string } {
  if (!value) return {};
  const cut = value.indexOf(SEPARATOR);
  if (cut < 0) return { model: value };
  return { provider: value.slice(0, cut), model: value.slice(cut + SEPARATOR.length) };
}

/** The catalogue's spelling of "whatever this installation would pick". Dropped: the picker's
 * empty option already means that, and keeping both drew two defaults in one menu. */
function isDefaultRow(entry: ModelInfo): boolean {
  return entry.value === "" || entry.value === "default";
}

export function modelMenu(models: ModelInfo[], providers: ProviderInfo[] = []): ModelMenu {
  /** A backend's models, as menu rows. `supportsEffort` is carried through as declared — almost
   * always false — and `RunControls` reads it to decide whether to draw the effort control. */
  const groups: ModelGroup[] = providers.map((provider) => ({
    // The key alone. A native `<optgroup>` label does not wrap, so a sentence stretches the menu to
    // its width and draws as a grey band with the text lost in it.
    label: provider.key,
    items: provider.models.map((model) => ({
      value: providerValue(provider.key, model.id),
      displayName: model.name,
      // The note belongs here, where it becomes the option's tooltip rather than a heading.
      description: provider.note
        ? `${provider.note} · ${provider.host}:${provider.port}`
        : `${provider.key} · ${provider.host}:${provider.port}`,
      supportsEffort: model.supportsEffort,
    })),
  }));
  const fromProviders = groups.flatMap((group) => group.items);

  const known = models.length > 0;
  if (!known) {
    // Nothing to contrast the pinned ids against yet. The configured backends are not provisional
    // though — they came from a file that was read.
    return {
      known,
      catalogue: [],
      pinned: PINNED_MODELS,
      providers: groups,
      all: [...PINNED_MODELS, ...fromProviders],
    };
  }

  const catalogue = models.filter((entry) => !isDefaultRow(entry));
  const pinned = PINNED_MODELS.filter(
    (entry) => !catalogue.some((offered) => offered.value === entry.value),
  );
  return {
    known,
    catalogue,
    pinned,
    providers: groups,
    all: [...catalogue, ...pinned, ...fromProviders],
  };
}

/** How one row reads. An alias says what it resolves to: "Opus" alone does not answer which Opus,
 * which is what made the catalogue worse than the list it replaced. */
export function modelLabel(entry: ModelInfo): string {
  const resolved =
    entry.resolvedModel && entry.resolvedModel !== entry.value ? ` — ${entry.resolvedModel}` : "";
  return `${entry.displayName}${resolved}`;
}
