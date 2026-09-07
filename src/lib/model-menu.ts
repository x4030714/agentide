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

import type { ModelInfo } from "./protocol";

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

export interface ModelMenu {
  /** False until a turn has run and the SDK has published its catalogue. */
  known: boolean;
  /** The installation's own entries, minus its default row. */
  catalogue: ModelInfo[];
  /** The pinned ids the catalogue does not already offer. */
  pinned: ModelInfo[];
  /** Everything selectable, for resolving whichever id is currently chosen. */
  all: ModelInfo[];
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

export function modelMenu(models: ModelInfo[]): ModelMenu {
  const known = models.length > 0;
  if (!known) {
    // Nothing to contrast the pinned ids against yet, so they are the whole menu. The
    // control says beside itself that the list is provisional until the first turn.
    return { known, catalogue: [], pinned: PINNED_MODELS, all: PINNED_MODELS };
  }

  const catalogue = models.filter((entry) => !isDefaultRow(entry));
  const pinned = PINNED_MODELS.filter(
    (entry) => !catalogue.some((offered) => offered.value === entry.value),
  );
  return { known, catalogue, pinned, all: [...catalogue, ...pinned] };
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
