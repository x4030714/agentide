/** The models and slash commands this installation offers. `supportedModels()` needs a live
 * `Query`, which only a turn has, so the first turn asks and publishes and later ones skip. */

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

/** Ask `running` for the model list and send it on, unless an earlier turn already did.
 * Returns immediately; a rejection is logged and costs a picker rather than a turn. */
  publish(running: Query): void {
    if (this.#asked) return;
// Set before awaiting, so two turns in the same tick cannot both ask, and left set after a
// failure, so a broken build asks once rather than once per turn. Restarting is the retry.
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

// Same moment and same reason as the models: describes the installation, needs a live `Query`.
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

/** Narrow one SDK row to the wire shape. Field by field, not a spread: the SDK carries flags
 * this protocol does not plumb, and spreading puts fields on the wire that no schema covers. */
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
