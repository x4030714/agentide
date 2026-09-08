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
 * One button per model: llama.cpp, the weights, and the `providers.json` entry. The list is
 * fixed because a model that fumbles the `ide_*` tools reads as a broken IDE, not a weaker one.
 */

/** How often a running download refreshes its bar. Cheap: one directory listing. */
const POLL_MS = 1000;

interface LocalModelsProps {
  /** Where the agent's terminals run, so the download tab opens in the workspace. */
  root: WirePath | null;
  /** NVIDIA memory, or `null` for none -- not an error: llama.cpp runs on the CPU. */
  vramGb: number | null;
}

export function LocalModels({ root, vramGb }: LocalModelsProps) {
  const [home, setHome] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [engine, setEngine] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Home via the path the core already hands out; a dedicated command would duplicate it.
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
   * Entry first, download second: gated on its port, it shows in the menu as not answering,
   * which beats an empty menu while seventeen gigabytes arrive.
   */
  const install = useCallback(
    async (model: LocalModel) => {
      if (!home) return;
      setBusy(model.id);
      setError(null);
      try {
        const path = `${home}/.agentide/providers.json` as WirePath;
        /**
         * This file is the user's -- keys, gateways agentide never wrote. Only "not found" is
         * safe to read as empty; any other failure stops here with the file untouched.
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
            // Hand-edited into invalid JSON; overwriting would discard a half-finished edit.
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
        // The sidecar only re-reads this file at startup and turn start, so the menu would not
        // show the model until then -- and the button tells you to go and pick it.
        publishPendingProvider({
          key: model.id,
          models: [
            {
              // What llama.cpp reports: the filename without its suffix, as `provider-config.ts`
              // derives it.
              id: model.file.replace(/\.gguf$/i, ""),
              name: model.name,
              supportsEffort: false,
            },
          ],
          // The command too: this launches the backend on the first prompt after installing.
          start: startCommandFor(home, model, port, context),
          host: "127.0.0.1",
          port,
          note: model.note,
        });
        // Both halves already here: starting the script would open a tab just to exit.
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
          // Too small a trained context is unusable at any hardware, so it reads as unavailable.
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
                    {/* A downloaded model still needs Reapply: the entry's port and context
                        can go stale, and the alternative is hand-editing the file. */}
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

