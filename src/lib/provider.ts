/** Bringing a model backend up, in a terminal the person can watch. Started through
 * `startBackground` so the long load, the wrong path and the OOM are all visible in a tab. */

import { listBackground, startBackground, stopBackground } from "./agent-shell";
import type { ProviderInfo, WirePath } from "./protocol";

/** What happened when a backend was asked for. */
export type ProviderStart =
  /** Already running, or nothing to start. Nothing was launched. */
  | { started: false }
  /** A process was launched; it may still be loading. */
  | { started: true; id: string }
  | { started: false; error: string };

/** The backends this app has launched, by provider key. The command is held as well as the
 * id: settings can change under a running server, and the old one answers on the old port. */
interface Launched {
  id: string;
  command: string;
}

const launched = new Map<string, Launched>();

/** The running process this app started for `key`, if there is one. */
function current(key: string): Launched | null {
  const entry = launched.get(key);
  if (!entry) return null;
  const process = listBackground().find((item) => item.id === entry.id);
  if (process?.running) return entry;
  launched.delete(key);
  return null;
}

/** Start `provider`'s backend if it is not already up. Returns as soon as the process exists;
 * waiting for the model to load belongs to the sidecar's gate, which does it anyway. */
export async function ensureProvider(
  provider: ProviderInfo,
  cwd: WirePath | null,
): Promise<ProviderStart> {
  // Nothing to launch: a gateway or a hosted endpoint the person runs themselves. The
  // sidecar's gate reports it being down, better than a guess from here could.
  if (!provider.start) return { started: false };

  const running = current(provider.key);
  if (running) {
    // The same command: it is already up, and starting a second one on that port would
    // fail in a way that looks like the first one broke.
    if (running.command === provider.start) return { started: false };
    // A different command: the settings changed under it. Left alone it would go on
    // answering on the old port with the old context while the gate waits on the new one.
    await stopBackground(running.id);
    launched.delete(provider.key);
  }

  try {
    const process = await startBackground(provider.start, cwd);
    launched.set(provider.key, { id: process.id, command: provider.start });
    return { started: true, id: process.id };
  } catch (error) {
    // Reported, not thrown: something else may already be listening on that port — the
    // person's own llama.cpp — and refusing the prompt over that would be wrong.
    return { started: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Only for the tests: what this module believes it has running. */
export const __testing = {
  reset(): void {
    launched.clear();
  },
  launched(): Map<string, Launched> {
    return launched;
  },
};
