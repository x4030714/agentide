/**
 * Bringing a model backend up, in a terminal the person can watch.
 *
 * A `.gguf` is only weights; llama.cpp is what runs them. agentide starts it rather than
 * expecting it to already be up, and starts it through `startBackground` -- the same
 * machinery the agent's own background processes use, which means a tab, scrollback, an
 * exit code, and a process the reaper takes down with the app.
 *
 * That visibility is the whole reason it is not spawned quietly from the sidecar.
 * PRODUCT.md's third principle is that nothing the agent does is hidden, and a 30B model
 * loading for forty seconds with no sign of it is exactly the silence that reads as a
 * hang. It is also where the failures live: a wrong model path, a missing engine and an
 * out-of-memory abort are all one line in that tab and invisible anywhere else.
 *
 * The sidecar still holds the gate. This starts the process; `waitForProvider` there
 * decides whether the turn may go ahead, because it is the side that knows the base URL
 * and would be the one to fail against it.
 */

import { listBackground, startBackground, stopBackground } from "./agent-shell";
import type { ProviderInfo, WirePath } from "./protocol";

/** What happened when a backend was asked for. */
export type ProviderStart =
  /** Already running, or nothing to start. Nothing was launched. */
  | { started: false }
  /** A process was launched; it may still be loading. */
  | { started: true; id: string }
  | { started: false; error: string };

/**
 * The backends this app has launched, by provider key: which process, and what command.
 *
 * Kept so a second prompt does not start a second llama.cpp on the same port -- which
 * fails, noisily, in a way that looks like the first one broke. Cleared when the process
 * exits, so a backend that crashed can be started again by sending another prompt.
 *
 * The command is held as well as the id, and that is the part learned the hard way. A
 * provider's settings can change under a running server -- the port it listens on, the
 * context it loads with -- and the process started from the old ones is still alive and
 * still answering, just on the wrong port. Tracking only "did I start something for this
 * key" then means nothing new is started, the gate waits on a port nobody is listening to,
 * and the turn fails while a perfectly healthy model sits in a terminal tab.
 */
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

/**
 * Start `provider`'s backend if it is not already up.
 *
 * Returns as soon as the process exists rather than waiting for the model to load. The
 * wait belongs to the sidecar, which has to do it anyway before the turn, and doing it
 * twice would only delay the tab appearing -- which is the thing worth seeing while a
 * model loads.
 */
export async function ensureProvider(
  provider: ProviderInfo,
  cwd: WirePath | null,
): Promise<ProviderStart> {
  // Nothing to launch: a gateway or a hosted endpoint the person runs themselves. The
  // sidecar's gate is what reports it being down, and it can say so better than a guess
  // from here.
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
    // Reported, not thrown: the turn is still worth attempting. Something else may be
    // listening on that port already -- the person's own llama.cpp, started before
    // agentide -- and refusing the prompt because we could not start a second one would
    // be wrong.
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
