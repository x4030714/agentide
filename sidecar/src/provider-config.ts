/**
 * Where a turn's model actually comes from.
 *
 * Claude Code speaks exactly one wire protocol -- Anthropic's Messages API -- and is
 * pointed at `api.anthropic.com` unless told otherwise. `ANTHROPIC_BASE_URL` and
 * `ANTHROPIC_AUTH_TOKEN` are the "otherwise", and anything that answers on that URL in
 * that shape can serve a turn: llama.cpp and LM Studio speak it natively now, and LiteLLM
 * translates in front of everything else, which is the route to a hosted Qwen or Nemotron.
 *
 * So running an open model is configuration, not machinery. This file is the configuration.
 *
 * ## Two ways to write an entry
 *
 * The common one is a model file and a port:
 *
 * ```json
 * { "qwen": { "model": "D:/models/qwen3-coder-30b.gguf", "port": 8080 } }
 * ```
 *
 * A `.gguf` is only weights; something has to run them. That entry means "start
 * llama.cpp on this file", and the command is built from it -- the engine, the context
 * size and the port are all things with a right answer that nobody should have to retype.
 *
 * The other is for anything that is not a local llama.cpp -- LM Studio, a LiteLLM gateway,
 * a hosted endpoint -- where agentide is not launching anything and only needs to know
 * where to talk and what to call the models:
 *
 * ```json
 * { "hosted": { "baseUrl": "https://gateway.example", "host": "gateway.example",
 *               "port": 443, "token": "${NVIDIA_KEY}", "models": [{ "id": "nemotron" }] } }
 * ```
 *
 * ## The one thing that makes this dangerous
 *
 * With `ANTHROPIC_BASE_URL` set and nothing listening, Claude Code does **not** fall back
 * to the cloud -- it fails the turn with an API error naming neither the provider nor the
 * port. A backend the person forgot to start would look like agentide being broken. That
 * is why `port` is required rather than optional: there has to be something to check.
 *
 * ## Read per turn, user level only
 *
 * Re-read every prompt, so an edit lands on the next turn rather than the next restart --
 * the rule `mcp.json` and `system.md` already follow. There is no workspace file on
 * purpose: which machine runs the model is a fact about the machine, the same argument
 * that put `system.md` and the memory vault a level up.
 */

import { homedir } from "node:os";
import { basename, join } from "node:path";

import { z } from "zod";

import { expandVars, isOff, issues, listening, readJson, warn } from "./config-file.ts";
import type { ProviderInfo } from "./protocol.ts";

/** Beside `mcp.json` and `memory.json`, so there is one directory to remember. */
const CONFIG_PATH = join(".agentide", "providers.json");

/** Localhost unless said otherwise: a model server is on this machine or behind a proxy on it. */
const DEFAULT_HOST = "127.0.0.1";

/**
 * llama.cpp's server, expected on PATH.
 *
 * Named rather than discovered: a wrong guess at an install location produces a command
 * that fails in a terminal tab, which is at least visible. Set `engine` to a full path
 * when it is not on PATH, which on Windows it usually is not.
 */
const DEFAULT_ENGINE = "llama-server";

/**
 * 64K by default.
 *
 * 32K is the floor for this kind of work -- below it the system prompt and thirteen tool
 * descriptions consume the window before any code arrives -- and 64K is the first size
 * that leaves room to actually read a file. It is a default rather than a fixed value
 * because it is also the setting most likely to exceed the VRAM on hand.
 */
const DEFAULT_CONTEXT = 65_536;

const ModelSchema = z.strictObject({
  /** Sent as `--model`, so exactly what the backend calls it. */
  id: z.string().min(1),
  /** What the picker shows. Defaults to `id`, which is usually already readable. */
  name: z.string().min(1).optional(),
  /**
   * Whether this model takes an effort level. Off by default and rarely true: effort is
   * an Anthropic concept, and a control that silently does nothing is worse than none.
   */
  supportsEffort: z.boolean().optional(),
});

const ProviderSchema = z.strictObject({
  /**
   * A `.gguf` to run locally. Implies the engine, the command and the base URL, and names
   * the model after the file unless `models` says otherwise.
   */
  model: z.string().min(1).optional(),
  /** Where llama.cpp's server lives, when it is not on PATH. */
  engine: z.string().min(1).optional(),
  /** Tokens of context to load the model with. See `DEFAULT_CONTEXT`. */
  contextLength: z.number().int().min(1024).optional(),
  /**
   * The command that brings the backend up, for anything `model` cannot express. Given
   * both, this wins -- it is the escape hatch, so it has to be able to escape.
   */
  start: z.string().min(1).optional(),
  /** Defaults to `http://<host>:<port>`. No trailing `/v1`: both backends want the origin. */
  baseUrl: z.string().min(1).optional(),
  /** Required: an unreachable backend fails every turn rather than falling back. */
  port: z.number().int().min(1).max(65_535),
  host: z.string().min(1).optional(),
  /**
   * Any non-empty string satisfies a local backend; a hosted one needs the real key.
   * `${VAR}` is expanded from this process's environment and never printed.
   */
  token: z.string().min(1).optional(),
  /** Required unless `model` gives one to derive. */
  models: z.array(ModelSchema).min(1).optional(),
  /**
   * Keep it running when agentide closes. Off by default, because the reaper takes every
   * child down with the app and a model server is a child -- see `src-tauri/src/reaper.rs`.
   * Turning it on means agentide can no longer clean it up, which is the trade this field
   * exists to let someone make deliberately.
   */
  detached: z.boolean().optional(),
  disabled: z.boolean().optional(),
  /** The comment JSON cannot hold. No runtime effect, on purpose. */
  note: z.string().optional(),
});

/** One model a provider offers. */
export interface ProviderModel {
  id: string;
  name: string;
  supportsEffort: boolean;
}

/** A configured backend, with its secrets already resolved. */
export interface Provider {
  key: string;
  baseUrl: string;
  token: string;
  /** The command that starts it, when this is a backend agentide launches. */
  start?: string;
  host: string;
  port: number;
  models: ProviderModel[];
  detached: boolean;
  note?: string;
}

/**
 * The name a model file goes by in the picker: `qwen3-coder-30b-q4_k_m.gguf` becomes
 * `qwen3-coder-30b-q4_k_m`. The quantisation stays, because it is the difference between
 * two files that are otherwise the same model and the person chose between them.
 */
function modelNameFrom(path: string): string {
  return basename(path.replace(/\\/g, "/")).replace(/\.gguf$/i, "");
}

/**
 * The command that runs a `.gguf`.
 *
 * `--host 127.0.0.1` is deliberate: llama.cpp binds every interface by default, and a
 * model server reachable from the network is not what "run a model locally" asked for.
 * Quoted because a model lives under a path with spaces more often than not.
 *
 * The leading `&` is the reason this is a function and not a template at the call site.
 * The terminal is PowerShell, where a quoted path in the first position is a *string
 * expression*, not a command -- so without the call operator this does not fail to find
 * the program, it fails to parse, with `Unexpected token '-m'`. The model then never
 * starts, and the only symptom upstream is the port gate reporting that the backend did
 * not come up, which points at everything except the quoting.
 */
function engineCommand(model: string, engine: string, context: number, port: number): string {
  return `& "${engine}" -m "${model}" -c ${context} --port ${port} --host 127.0.0.1`;
}

/**
 * Every provider in the file, gates unchecked.
 *
 * The gate is deliberately not applied here. The host needs the entry *before* the backend
 * is up -- that is what `start` is for -- so "which providers exist" and "which are
 * reachable right now" are two questions with two answers.
 */
export function loadProviders(home: string = homedir()): Provider[] {
  const parsed = readJson(join(home, CONFIG_PATH), "providers");
  if (parsed === null) return [];

  const file = z.object({ providers: z.record(z.string(), z.unknown()).optional() }).safeParse(parsed);
  if (!file.success) {
    warn(`${CONFIG_PATH}: ${issues(file.error)}; its providers were skipped`);
    return [];
  }

  const providers: Provider[] = [];
  for (const [key, value] of Object.entries(file.data.providers ?? {})) {
    // Checked before the shape is, so `{"disabled": true}` alone is a valid way to switch
    // one off without keeping the rest of the entry valid.
    if (isOff(value)) continue;

    const entry = ProviderSchema.safeParse(value);
    if (!entry.success) {
      warn(`providers.json: "${key}" was ignored -- ${issues(entry.error)}`);
      continue;
    }

    const resolved = expandVars(entry.data);
    if ("missing" in resolved) {
      // Named, never valued. This is the path an API key travels, and a warning that
      // helpfully printed it would put it in the log the person pastes into a bug report.
      warn(
        `providers.json: "${key}" was ignored -- ${resolved.missing.join(" and ")} ` +
          `${resolved.missing.length === 1 ? "is" : "are"} not set in this process's environment`,
      );
      continue;
    }

    const data = resolved.value;
    const models = data.models ?? (data.model ? [{ id: modelNameFrom(data.model) }] : null);
    if (!models) {
      // Nothing to put in the picker. An entry that names neither a file nor a model list
      // describes a backend nobody could select.
      warn(`providers.json: "${key}" was ignored -- it names neither "model" nor "models"`);
      continue;
    }

    const host = data.host ?? DEFAULT_HOST;
    // `start` wins over `model`: it is the escape hatch, and an escape hatch that loses to
    // the convenience it exists to bypass is not one.
    const start =
      data.start ??
      (data.model
        ? engineCommand(
            data.model,
            data.engine ?? DEFAULT_ENGINE,
            data.contextLength ?? DEFAULT_CONTEXT,
            data.port,
          )
        : undefined);

    providers.push({
      key,
      baseUrl: (data.baseUrl ?? `http://${host}:${data.port}`).replace(/\/+$/, ""),
      // Any non-empty value satisfies a local backend, and sending none at all makes the
      // CLI look for an Anthropic key instead -- which is the confusing failure, not a
      // secure one.
      token: data.token ?? "agentide",
      ...(start ? { start } : {}),
      host,
      port: data.port,
      models: models.map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        supportsEffort: model.supportsEffort ?? false,
      })),
      detached: data.detached ?? false,
      ...(data.note ? { note: data.note } : {}),
    });
  }
  return providers;
}

/**
 * The providers as the host may see them: no `baseUrl`, no `token`.
 *
 * The boundary is the point. The host draws the models and knows what command starts a
 * backend, neither of which needs the credential, and a key that never crosses into the
 * webview cannot be read out of it. Built by naming the fields that go rather than the
 * ones that stay, so a field added to `Provider` later is excluded until someone decides
 * otherwise.
 */
export function publicProviders(providers: Provider[]): ProviderInfo[] {
  return providers.map((provider) => ({
    key: provider.key,
    models: provider.models,
    ...(provider.start ? { start: provider.start } : {}),
    host: provider.host,
    port: provider.port,
    ...(provider.note ? { note: provider.note } : {}),
  }));
}

/** The provider a turn asked for, or null when it asked for none. */
export function findProvider(providers: Provider[], key: string | undefined): Provider | null {
  if (!key) return null;
  return providers.find((provider) => provider.key === key) ?? null;
}

/**
 * The environment that points the CLI at a provider.
 *
 * Spread over `process.env` by the caller, never in place of it: `Options.env` replaces
 * the subprocess environment entirely, and dropping `PATH` or an existing Claude login is
 * not a trade worth making for two variables.
 */
export function providerEnv(provider: Provider): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: provider.baseUrl,
    ANTHROPIC_AUTH_TOKEN: provider.token,
  };
}

/** Whether a provider is answering right now. See the module note on why this matters. */
export function providerReady(provider: Provider): Promise<boolean> {
  return listening(provider.port, provider.host);
}

/**
 * Wait for a backend that is starting up.
 *
 * Loading a 30B model off disk takes tens of seconds, and the turn that asked for it is
 * already waiting -- failing at the first refused connection would mean the first prompt
 * after launch never works. Polls rather than sleeping the whole time, so a backend that
 * was already warm costs one connect.
 */
export async function waitForProvider(provider: Provider, deadlineMs: number): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    if (await providerReady(provider)) return true;
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
