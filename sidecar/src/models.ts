/**
 * What this installation can do: the models it offers and the slash commands it accepts.
 * Published once per sidecar.
 *
 * `supportedModels()` lives on a running `Query` -- `startup()` hands back a `WarmQuery`,
 * which does not expose it -- so the list cannot be read without a live turn, and this
 * process will not start one just to ask. The first turn asks, the answer goes out as a
 * `models` message, and every later turn skips it: the catalogue describes the
 * installation, not the turn.
 */

import type {
  ModelInfo as SdkModelInfo,
  Query,
  SlashCommand as SdkSlashCommand,
} from "@anthropic-ai/claude-agent-sdk";

import type { HostLink } from "./host.ts";
import type { ModelInfo, SlashCommand } from "./protocol.ts";

export class ModelCatalogue {
  readonly #link: HostLink;
  /** Whether this process has asked. A failed ask still counts; see `publish`. */
  #asked = false;

  constructor(link: HostLink) {
    this.#link = link;
  }

  /**
   * Ask `running` for the model list and send it on, unless an earlier turn already did.
   *
   * Returns immediately: the answer reaches the host when it reaches it, and no turn
   * waits for it. A rejection is logged and nothing is sent -- the frontend renders what
   * it has, and a missing catalogue costs a picker rather than a turn.
   */
  publish(running: Query): void {
    if (this.#asked) return;
    // Set before awaiting, so two turns starting in the same tick cannot both ask, and
    // left set after a failure, so a build where this never works asks once rather than
    // once per turn. Restarting the sidecar is the retry.
    this.#asked = true;
    void running.supportedModels().then(
      (models) => {
        // Typed as always present, but it reaches us from the CLI's initialize response;
        // a CLI predating the field would otherwise throw inside a turn that was fine.
        if (!Array.isArray(models)) {
          warn("the SDK reported no model list");
          return;
        }
        this.#link.send({ t: "models", models: models.map(forward) });
      },
      (error: unknown) => warn(`could not read the model list: ${describe(error)}`),
    );

    // Asked at the same moment and for the same reason: both describe the installation
    // rather than the turn, and both need a live `Query` to ask.
    void running.supportedCommands().then(
      (commands) => {
        if (!Array.isArray(commands)) {
          warn("the SDK reported no command list");
          return;
        }
        this.#link.send({ t: "commands", commands: commands.map(forwardCommand) });
      },
      (error: unknown) => warn(`could not read the command list: ${describe(error)}`),
    );
  }
}

/** Narrow one command row to the wire shape, for the same reason as `forward`. */
function forwardCommand(command: SdkSlashCommand): SlashCommand {
  return {
    name: command.name,
    description: command.description,
    argumentHint: command.argumentHint,
    ...(command.aliases && command.aliases.length > 0 ? { aliases: command.aliases } : {}),
  };
}

/**
 * Narrow one SDK row to the wire shape.
 *
 * Field by field rather than by spread: the SDK's `ModelInfo` carries flags for modes
 * this protocol does not plumb, and spreading would put fields on the wire that no
 * schema describes and no fixture covers.
 */
function forward(model: SdkModelInfo): ModelInfo {
  return {
    value: model.value,
    resolvedModel: model.resolvedModel,
    displayName: model.displayName,
    description: model.description,
    supportsEffort: model.supportsEffort,
    supportedEffortLevels: model.supportedEffortLevels,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warn(text: string): void {
  process.stderr.write(`[agent-host] ${text}\n`);
}
