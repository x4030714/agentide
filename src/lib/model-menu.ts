/**
 * What goes in the model picker, and in which group.
 *
 * The picker used to show one of two entirely different lists depending on whether a turn
 * had run yet, and the switch was the confusing part rather than either list. Before the
 * first turn it showed version-pinned ids; after it, the SDK's catalogue replaced them
 * wholesale -- alias-based, so "Opus 5" and "Opus 4.8" both became "Opus", and the
 * catalogue's own "Default (recommended)" row appeared next to the empty option that
 * already meant the same thing. Two defaults, and no way to pin a version.
 *
 * So the two lists are merged instead of alternating. The catalogue is authoritative
 * about what this installation offers; the pinned ids are ours, kept because an alias
 * moves when a new model ships and a regression has to be held against a fixed one.
 *
 * Pure, and here rather than in the component, because the grouping is the part with
 * rules in it -- see the tests.
 */

import type { ModelInfo, ProviderInfo } from "./protocol";

/**
 * Version-pinned ids, offered before the catalogue exists and kept afterwards.
 *
 * Every id is one the installed SDK's own model union carries. A fabricated id would be
 * worse than an empty list: it fails at the start of a turn rather than at the click, so
 * nothing here may be guessed.
 */
export const PINNED_MODELS: ModelInfo[] = [
  { value: "claude-opus-5", displayName: "Opus 5", description: "" },
  { value: "claude-opus-4-8", displayName: "Opus 4.8", description: "" },
  { value: "claude-sonnet-5", displayName: "Sonnet 5", description: "" },
  { value: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "" },
];

/**
 * How a provider's model is spelled in the menu, so one `<select>` can carry both halves
 * of the choice.
 *
 * A model id has no meaning without the backend that serves it -- two providers can both
 * offer `qwen3-coder-30b` and mean different files -- so the value has to name both. `::`
 * because neither a provider key nor a model id may contain it.
 */
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

/**
 * Split a menu value back into the two things a prompt needs.
 *
 * An Anthropic model has no provider, which is what `undefined` means here -- and is
 * exactly what `PromptOptions.provider` being absent means, so it travels unchanged.
 */
export function decodeModel(value: string | null): { provider?: string; model?: string } {
  if (!value) return {};
  const cut = value.indexOf(SEPARATOR);
  if (cut < 0) return { model: value };
  return { provider: value.slice(0, cut), model: value.slice(cut + SEPARATOR.length) };
}

/**
 * The catalogue's way of spelling "whatever this installation would pick".
 *
 * Dropped, because the picker's empty option already means that and is the one the rest
 * of the app reads as unset. Keeping both drew two defaults in one menu.
 */
function isDefaultRow(entry: ModelInfo): boolean {
  return entry.value === "" || entry.value === "default";
}

export function modelMenu(models: ModelInfo[], providers: ProviderInfo[] = []): ModelMenu {
  /**
   * A backend's models, as menu rows.
   *
   * `supportsEffort` is carried through as the provider declared it -- almost always
   * false, because effort is an Anthropic concept. `RunControls` reads that same field to
   * decide whether to draw the effort control at all, so a local model simply does not
   * offer one rather than offering one that is ignored.
   */
  const groups: ModelGroup[] = providers.map((provider) => ({
    // The key alone. A native `<optgroup>` label does not wrap, so a sentence here stretches
    // the menu to the width of the sentence and draws as a grey band with the text lost in
    // it -- which is what putting the provider's note in the label did.
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
    // Nothing to contrast the pinned ids against yet, so they are the whole Anthropic
    // half. The configured backends are not provisional, though -- they came from a file
    // that was read, so they are as true now as they will ever be.
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

/**
 * How one row reads.
 *
 * An alias says what it resolves to, because "Opus" alone does not answer the only
 * question worth asking of it -- which Opus -- and losing that answer is exactly what
 * made the catalogue worse than the list it replaced.
 */
export function modelLabel(entry: ModelInfo): string {
  const resolved =
    entry.resolvedModel && entry.resolvedModel !== entry.value ? ` — ${entry.resolvedModel}` : "";
  return `${entry.displayName}${resolved}`;
}
