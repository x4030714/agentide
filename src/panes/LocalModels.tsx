import { useCallback, useEffect, useState } from "react";

import { memoryVault, readFile, writeFile } from "../lib/bridge";
import {
  hasEngine,
  isComplete,
  pauseDownload,
  progressAll,
  startDownload,
} from "../lib/downloads";
import type { Progress } from "../lib/downloads";
import {
  contextFor,
  fitLabel,
  fitsIn,
  LOCAL_MODELS,
  runsAgentide,
  portFor,
  providerEntry,
  startCommandFor,
} from "../lib/local-models";
import type { LocalModel } from "../lib/local-models";
import { publishPendingProvider } from "../lib/pending-providers";
import { errorMessage, isIpcError, parentOf } from "../lib/protocol";
import type { WirePath } from "../lib/protocol";

/**
 * Running a model on this machine, from nothing to a working entry in the Model menu.
 *
 * One button per model. Pressing it downloads llama.cpp if it is not here, downloads the
 * weights, and writes the `providers.json` entry -- after which the model is in the picker
 * and starts on the next prompt that selects it.
 *
 * ## Why the list is fixed
 *
 * agentide is unusable on a model that cannot call tools: the `ide_*` calls are how it
 * reads, edits and runs anything, so a model that fumbles them does not read as weaker, it
 * reads as a broken IDE. A search over Hugging Face mostly offers exactly those. The list
 * is short, every size and filename on it was read from the API rather than remembered,
 * and everything is offered whether or not it fits -- with the fit said plainly, because a
 * machine that cannot run the best one today is a reason to know that, not to hide it.
 *
 * ## The port
 *
 * One per model, derived from its id by `portFor`, so two models can be installed and
 * neither has to be uninstalled to try the other.
 */

/** How often a running download refreshes its bar. Cheap: one directory listing. */
const POLL_MS = 1000;

interface LocalModelsProps {
  /** Where the agent's terminals run, so the download tab opens in the workspace. */
  root: WirePath | null;
  /**
   * Whether this machine has an NVIDIA card, and how much memory it has.
   *
   * `null` means none was found, which is not an error: llama.cpp runs on the CPU, and the
   * fit labels say what that costs rather than refusing.
   */
  vramGb: number | null;
}

export function LocalModels({ root, vramGb }: LocalModelsProps) {
  const [home, setHome] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [engine, setEngine] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // The home directory, via the one path the core already hands out. A dedicated command
  // for it would be a second way to ask the same question.
  useEffect(() => {
    let cancelled = false;
    void memoryVault()
      .then((vault) => {
        if (!cancelled) setHome(parentOf(vault.vault));
      })
      .catch(() => {
        /* The section says "…" until this lands; nothing here is urgent. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // One listing answers for every model at once, so this polls rather than subscribing.
  useEffect(() => {
    if (!home) return;
    let cancelled = false;
    const tick = async () => {
      const next = await progressAll(home, LOCAL_MODELS);
      const installed = await hasEngine(home);
      if (cancelled) return;
      setProgress(next);
      setEngine(installed);
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [home]);

  /**
   * Write the provider entry, then start the download.
   *
   * In that order deliberately. The entry is gated on its port, so it appears in the menu
   * immediately and reports as not answering until the model is here -- which is the truth,
   * and better than a menu that stays empty while seventeen gigabytes arrive.
   */
  const install = useCallback(
    async (model: LocalModel) => {
      if (!home) return;
      setBusy(model.id);
      setError(null);
      try {
        const path = `${home}/.agentide/providers.json` as WirePath;
        /**
         * Read what is there before adding to it, and refuse rather than guess.
         *
         * This file is the user's: it can hold a hosted gateway, an API key, backends
         * agentide never wrote. Treating every read failure as "no file yet" would replace
         * all of that with one entry the first time a read failed for any reason other than
         * absence -- a lock, a permission, a drive that blinked. Only "not found" is safe
         * to read as empty; anything else stops here with the file untouched.
         */
        let existing: Record<string, unknown> = {};
        try {
          const file = await readFile(path);
          const parsed = JSON.parse(file.text) as { providers?: Record<string, unknown> };
          existing = parsed.providers ?? {};
        } catch (err) {
          if (isIpcError(err) && err.code === "notFound") {
            // The ordinary case: nothing has written it yet.
          } else if (err instanceof SyntaxError) {
            // Hand-edited into invalid JSON. Overwriting would silently discard whatever
            // they were part-way through typing.
            setError(
              `${path} is not valid JSON, so nothing was written. Fix or delete it and try again.`,
            );
            return;
          } else {
            setError(`could not read ${path}: ${errorMessage(err)}`);
            return;
          }
        }
        const providers = { ...existing };
        const port = portFor(model);
        const context = contextFor(model, vramGb);
        providers[model.id] = providerEntry(home, model, port, context);
        await writeFile(path, `${JSON.stringify({ providers }, null, 2)}\n`, false);
        // The sidecar reads this file at startup and at the start of a turn, so without
        // this the Model menu would not show the model until one of those happened -- and
        // the button's own message tells you to go and pick it there.
        publishPendingProvider({
          key: model.id,
          models: [
            {
              // What llama.cpp will report the model as: the filename without its suffix,
              // which is what `provider-config.ts` derives when an entry names a file.
              id: model.file.replace(/\.gguf$/i, ""),
              name: model.name,
              supportsEffort: false,
            },
          ],
          // The command too, not just the models: this entry is what launches the backend
          // on the first prompt after installing, before the sidecar has read the file.
          start: startCommandFor(home, model, port, context),
          host: "127.0.0.1",
          port,
          note: model.note,
        });
        // Nothing to fetch when both halves are already here, and starting the script
        // anyway would open a terminal tab to discover that and exit.
        const already = progress[model.id];
        if (!(already && isComplete(already) && engine)) {
          await startDownload(home, model, vramGb !== null, root);
        }
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(null);
      }
    },
    [home, root, vramGb, progress, engine],
  );

  return (
    <section className="settings-section">
      <h2 className="settings-legend">Local models</h2>
      <p className="note">
        Run a model on this machine instead of Anthropic's. agentide downloads llama.cpp and
        the weights, then starts the server itself when you pick the model — you will see it
        loading in a terminal tab. Nothing leaves the machine, and nothing is billed.
      </p>
      <p className="note">
        The catch is tool calling: everything agentide does goes through the{" "}
        <code>ide_*</code> tools, so a model that is weak at them looks like a broken IDE
        rather than a weaker assistant. The list is short for that reason.
      </p>

      <div className="settings-row">
        <span className="settings-label">This machine</span>
        <span className="settings-path">
          {vramGb === null
            ? "no NVIDIA GPU found — models will run on the CPU, slowly"
            : `${vramGb}GB of video memory`}
          {engine ? " · llama.cpp installed" : " · llama.cpp not installed yet"}
        </span>
      </div>

      {error && <p className="note is-error">{error}</p>}

      <div className="model-list">
        {LOCAL_MODELS.map((model) => {
          const state = progress[model.id];
          const done = state ? isComplete(state) : false;
          const active = state?.running ?? false;
          const fit = fitsIn(model, vramGb);
          // A model whose trained context cannot hold the prompt is unusable here whatever
          // the hardware, so it reads as unavailable rather than as a poor fit.
          const usable = runsAgentide(model);
          return (
            <div key={model.id} className={`model-row is-${usable ? fit : "too-big"}`}>
              <div className="model-head">
                <span className="model-name">{model.name}</span>
                <span className="model-size">{model.gigabytes}GB</span>
                <span className={`model-fit is-${usable ? fit : "unusable"}`}>
                  {usable ? fitLabel(fit) : "context too small"}
                </span>
              </div>
              <p className="model-note">{model.note}</p>

              {active && state && (
                <div className="model-progress" title={`${Math.round(state.fraction * 100)}%`}>
                  <span className="model-bar" style={{ width: `${state.fraction * 100}%` }} />
                </div>
              )}

              <div className="model-actions">
                {!usable ? (
                  <span className="model-ready">
                    agentide sends about 42k tokens before your message; this model caps at{" "}
                    {Math.round(model.trainedContext / 1024)}k
                  </span>
                ) : done ? (
                  <>
                    {/**
                     * A downloaded model still needs an action.
                     *
                     * The entry in `providers.json` holds a port and a context size worked
                     * out from this machine, and both can go stale -- the context floor
                     * changed once already, after a 32k window turned out to reject every
                     * turn agentide sends. With nothing but a line of text here there was
                     * no way to apply that without hand-editing the file, which is the one
                     * thing this panel exists to avoid.
                     */}
                    <span className="model-ready">
                      downloaded · {Math.round(contextFor(model, vramGb) / 1024)}k context on
                      port {portFor(model)}
                    </span>
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={busy !== null || !home}
                      title="Rewrite this model's entry for the current hardware. Downloads nothing."
                      onClick={() => void install(model)}
                    >
                      Reapply
                    </button>
                  </>
                ) : active ? (
                  <>
                    <span className="model-ready">
                      {Math.round((state?.fraction ?? 0) * 100)}% of {model.gigabytes}GB
                    </span>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => void pauseDownload(model)}
                    >
                      Pause
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={busy !== null || !home}
                    onClick={() => void install(model)}
                  >
                    {state && state.bytes > 0 ? "Resume" : "Use local model"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

