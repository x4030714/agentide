/**
 * A backend that exists on disk but that the sidecar has not read yet.
 *
 * `providers.json` is read by the sidecar at startup and again at the start of every turn,
 * which is right for a file meant to be edited by hand -- an edit lands on the next prompt
 * rather than the next restart. It is wrong for the one case where agentide writes the file
 * itself: pressing "Use local model" told you to pick the model from the Model menu, and
 * the menu could not show it, because nothing had asked the sidecar to look again.
 *
 * Rather than add a message asking it to, the frontend remembers what it just wrote. It
 * already knows the half the picker needs -- the key and the models -- and deliberately not
 * the half it must never hold, the base URL and the token. So this store carries exactly
 * what `publicProviders` would have sent, and the merge drops an entry as soon as the real
 * list contains it.
 *
 * A subscription rather than a prop for the same reason `cursor.ts` is one: the writer is
 * in Settings and the reader is above the composer, and threading it between them would
 * mean lifting state through the whole app to bridge one gap that closes on its own.
 */

import { useSyncExternalStore } from "react";

import type { ProviderInfo } from "./protocol";

let pending: ProviderInfo[] = [];
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) listener();
}

/**
 * Remember a provider that has just been written to `providers.json`.
 *
 * Replaces any entry under the same key: pressing the button twice for one model must not
 * put it in the menu twice.
 */
export function publishPendingProvider(provider: ProviderInfo): void {
  pending = [...pending.filter((entry) => entry.key !== provider.key), provider];
  announce();
}

/**
 * Everything the sidecar has told us, plus anything written since it last looked.
 *
 * The sidecar's list wins on a collision -- it read the file, this only remembers what was
 * meant to be in it -- and an entry that has arrived there is dropped from the pending set,
 * so this empties itself over the first turn rather than growing for the session.
 */
export function mergeProviders(
  known: ProviderInfo[],
  waiting: ProviderInfo[],
): ProviderInfo[] {
  if (waiting.length === 0) return known;
  const seen = new Set(known.map((entry) => entry.key));
  const unseen = waiting.filter((entry) => !seen.has(entry.key));
  return unseen.length > 0 ? [...known, ...unseen] : known;
}

/**
 * Forget the entries the sidecar has since read for itself.
 *
 * Called when a real list arrives rather than during the merge: a merge that mutated the
 * store would be a render reading and writing the same state, which React is entitled to
 * do twice.
 */
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
