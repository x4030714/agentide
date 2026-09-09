/** Open models via `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`; re-read per prompt, user level only.
 * `port` is required: on a dead base URL Claude Code fails the turn instead of falling back. */

import { homedir } from "node:os";
import { basename, join } from "node:path";

import { z } from "zod";

import { expandVars, isOff, issues, listening, readJson, warn } from "./config-file.ts";
import type { ProviderInfo } from "./protocol.ts";

/** Beside `mcp.json` and `memory.json`, so there is one directory to remember. */
const CONFIG_PATH = join(".agentide", "providers.json");

/** Localhost unless said otherwise: a model server is on this machine or behind a proxy on it. */
const DEFAULT_HOST = "127.0.0.1";

/** llama.cpp's server, expected on PATH. Named rather than discovered, so a wrong guess fails
 * visibly in a terminal tab. Set `engine` to a full path otherwise -- usually needed on Windows. */
const DEFAULT_ENGINE = "llama-server";

/** 32K is the floor -- prompt and tool descriptions eat it before any code arrives -- so 64K is
 * the first size with room to read a file. A default, not a constant: it is what blows VRAM. */
const DEFAULT_CONTEXT = 65_536;

const ModelSchema = z.strictObject({
  /** Sent as `--model`, so exactly what the backend calls it. */
  id: z.string().min(1),
  /** What the picker shows. Defaults to `id`, which is usually already readable. */
  name: z.string().min(1).optional(),
  /** Whether this model takes an effort level. Off by default: effort is an Anthropic concept,
   * and a control that silently does nothing is worse than no control. */
  supportsEffort: z.boolean().optional(),
});

const ProviderSchema = z.strictObject({
  /** A `.gguf` to run locally. Implies the engine, command and base URL, and names the model
   * after the file unless `models` says otherwise. */
  model: z.string().min(1).optional(),
  /** Where llama.cpp's server lives, when it is not on PATH. */
  engine: z.string().min(1).optional(),
  /** Tokens of context to load the model with. See `DEFAULT_CONTEXT`. */
  contextLength: z.number().int().min(1024).optional(),
  /** The command that brings the backend up, for anything `model` cannot express. Wins over
   * `model` -- an escape hatch has to be able to escape. */
  start: z.string().min(1).optional(),
  /** Defaults to `http://<host>:<port>`. No trailing `/v1`: both backends want the origin. */
  baseUrl: z.string().min(1).optional(),
  /** Required: an unreachable backend fails every turn rather than falling back. */
  port: z.number().int().min(1).max(65_535),
  host: z.string().min(1).optional(),
  /** Any non-empty string satisfies a local backend; a hosted one needs the real key. `${VAR}`
   * is expanded from this process's environment and never printed. */
  token: z.string().min(1).optional(),
  /** Required unless `model` gives one to derive. */
  models: z.array(ModelSchema).min(1).optional(),
  /** Keep it running when agentide closes. Off by default: the reaper takes every child down
   * with the app (`src-tauri/src/reaper.rs`), and on means nothing cleans it up. */
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

/** `qwen3-coder-30b-q4_k_m.gguf` becomes `qwen3-coder-30b-q4_k_m`. The quantisation stays: it
 * is the only difference between two files of the same model. */
function modelNameFrom(path: string): string {
  return basename(path.replace(/\\/g, "/")).replace(/\.gguf$/i, "");
}

/** `--host 127.0.0.1` because llama.cpp otherwise binds every interface. The leading `&` is
 * required: in PowerShell a quoted path in first position parses as a string, not a command. */
function engineCommand(model: string, engine: string, context: number, port: number): string {
  return `& "${engine}" -m "${model}" -c ${context} --port ${port} --host 127.0.0.1`;
}

/** Every provider in the file, gates unchecked: the host needs the entry before the backend is
 * up (that is what `start` is for), so existence and reachability stay separate questions. */
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
      // Any non-empty value satisfies a local backend; sending none makes the CLI go looking
      // for an Anthropic key instead.
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

/** The providers as the host may see them: no `baseUrl`, no `token`. Allow-listed, not
 * denied, so a field added to `Provider` stays out of the webview until someone says so. */
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

/** Spread over `process.env` by the caller, never in place of it -- `Options.env` replaces the
 * subprocess environment whole, taking `PATH` and any existing Claude login with it. */
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

/** Loading a 30B off disk takes tens of seconds, so the first refused connection cannot be
 * fatal. Polls rather than sleeps, so an already-warm backend costs one connect. */
export async function waitForProvider(provider: Provider, deadlineMs: number): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    if (await providerReady(provider)) return true;
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
