/** A backend written to `providers.json` that the sidecar has not re-read yet, so the Model
 * menu can show it before the next turn. Holds the key and models, never the URL or token. */

import { useSyncExternalStore } from "react";

import type { ProviderInfo } from "./protocol";

let pending: ProviderInfo[] = [];
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) listener();
}

/** Remember a provider just written to `providers.json`. Replaces any entry under the same
 * key: pressing the button twice for one model must not put it in the menu twice. */
export function publishPendingProvider(provider: ProviderInfo): void {
  pending = [...pending.filter((entry) => entry.key !== provider.key), provider];
  announce();
}

/** The sidecar's list plus anything written since it last looked. The sidecar wins on a
 * collision, and an arrived entry is dropped, so this empties itself over the first turn. */
export function mergeProviders(
  known: ProviderInfo[],
  waiting: ProviderInfo[],
): ProviderInfo[] {
  if (waiting.length === 0) return known;
  const seen = new Set(known.map((entry) => entry.key));
  const unseen = waiting.filter((entry) => !seen.has(entry.key));
  return unseen.length > 0 ? [...known, ...unseen] : known;
}

/** Forget the entries the sidecar has since read for itself. Called when a real list arrives,
 * not during the merge: a merge that mutated the store is a render React may run twice. */
export function settleProviders(known: ProviderInfo[]): void {
  if (pending.length === 0) return;
  const seen = new Set(known.map((entry) => entry.key));
  const unseen = pending.filter((entry) => !seen.has(entry.key));
  if (unseen.length === pending.length) return;
  pending = unseen;
  announce();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The held object, not a fresh one: `useSyncExternalStore` compares by identity. */
function snapshot(): ProviderInfo[] {
  return pending;
}

/** Re-renders the picker when a provider is written, so it appears without a restart. */
export function usePendingProviders(): ProviderInfo[] {
  return useSyncExternalStore(subscribe, snapshot);
}

/** Only for the tests. `subscribe` is the hook's own, so the notification is the real one. */
export const __testing = {
  reset(): void {
    pending = [];
    listeners.clear();
  },
  subscribe,
  pending(): ProviderInfo[] {
    return pending;
  },
};
