import { EDIT_MODES, MODE_HELP, MODE_LABEL } from "../lib/editmode";
import type { EditMode } from "../lib/editmode";
import { modelLabel, modelMenu } from "../lib/model-menu";
import { PROMPT_HELP, PROMPT_LABEL, PROMPT_MODES } from "../lib/promptmode";
import type { PromptMode } from "../lib/promptmode";
import type { EffortLevel, ModelInfo, ProviderInfo } from "../lib/protocol";
import { MCP_CLOSED } from "../lib/transcript";
import type { McpServerRow } from "../lib/transcript";

/**
 * What the next turn runs on, above the composer because it describes the prompt you are about
 * to send. Both values stay optional: unset means the SDK's default, and nothing is invented here.
 */

/** One row of the menu. The grouping and the wording live in `model-menu.ts`. */
function modelOption(entry: ModelInfo) {
  return (
    <option key={entry.value} value={entry.value} title={entry.description || undefined}>
      {modelLabel(entry)}
    </option>
  );
}

const ALL_EFFORTS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Only `connected` is good news, so anything unrecognised warns rather than passing silently --
 * `pending` included, since a server still pending gave this turn no tools. Choices are not faults.
 */
function mcpTone(status: string): string {
  if (status === "connected") return "ok";
  if (status === "disabled" || status === MCP_CLOSED) return "off";
  if (status === "failed") return "error";
  return "warn";
}

interface RunControlsProps {
  mode: EditMode;
  onMode: (mode: EditMode) => void;
  promptMode: PromptMode;
  onPromptMode: (mode: PromptMode) => void;
  /** False when neither system.md exists, so Tuned can say it has nothing to add. */
  tunedAvailable: boolean;
  models: ModelInfo[];
  /** The backends `providers.json` names. Empty means none configured, not "not yet known". */
  providers: ProviderInfo[];
  model: string | null;
  effort: EffortLevel | null;
  onModel: (model: string | null) => void;
  onEffort: (effort: EffortLevel | null) => void;
  /** From the last init message. Empty before the first turn, and drawn as nothing. */
  mcpServers: McpServerRow[];
  disabled: boolean;
}

export function RunControls({
  mode,
  onMode,
  promptMode,
  onPromptMode,
  tunedAvailable,
  models,
  providers,
  model,
  effort,
  onModel,
  onEffort,
  mcpServers,
  disabled,
}: RunControlsProps) {
  const { known, catalogue, pinned, providers: backends, all } = modelMenu(models, providers);
  const selected = all.find((entry) => entry.value === model);

  /** Only levels this model has: the SDK silently downgrades, so offering the rest would lie. */
  const efforts =
    selected?.supportedEffortLevels ??
    (selected && selected.supportsEffort === false ? [] : ALL_EFFORTS);

  return (
    <>
      {/**
       * One chip per MCP server. Connected-but-zero-tools warns: that shape hid the IDE's own
       * tools for three phases. Gated servers are drawn too, or they vanish from the strip.
       */}
      {mcpServers.length > 0 && (
        <div className="mcp-strip">
          <span className="legend">MCP</span>
          {mcpServers.map((server) => {
            const empty = server.status === "connected" && server.tools === 0;
            // Gated servers name the address, not the tool count: the port says what to open.
            const title = server.at
              ? `${server.name}: not started — nothing is listening on ${server.at}`
              : `${server.name}: ${server.status}, ${server.tools} tool${server.tools === 1 ? "" : "s"}`;
            return (
              <span
                key={server.name}
                className={`mcp-server is-${empty ? "warn" : mcpTone(server.status)}`}
                title={title}
              >
                {server.name}
                <span className="mcp-count">
                  {server.status === "connected" ? server.tools : server.status}
                </span>
              </span>
            );
          })}
        </div>
      )}

    <div className="run-controls">
      {/* Segmented, not a select: how much the agent may do unasked should be readable
          without opening anything. */}
      <div className="segmented" role="radiogroup" aria-label="Edit mode">
        {EDIT_MODES.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={option === mode}
            className={`segment${option === mode ? " is-on" : ""}`}
            title={MODE_HELP[option]}
            disabled={disabled}
            onClick={() => onMode(option)}
          >
            {MODE_LABEL[option]}
          </button>
        ))}
      </div>

      {/**
        * A select, where the edit mode beside it is segments.
        *
        * It was segments too, until a fourth mode arrived: the row does not wrap (see
        * `.run-controls`), so a control that grows with the list pushed Model and Effort off
        * the end and left the pane with a horizontal scrollbar. Edit mode is three fixed
        * options you toggle constantly; this is a list that grows and you set once a week.
        */}
      <label className="control">
        <span className="legend">Prompt</span>
        <select
          className="control-select"
          value={promptMode}
          title={
            promptMode === "tuned" && !tunedAvailable
              ? "No system.md in ~/.agentide or this workspace, so this adds nothing yet."
              : PROMPT_HELP[promptMode]
          }
          disabled={disabled}
          onChange={(event) => onPromptMode(event.target.value as PromptMode)}
        >
          {PROMPT_MODES.map((option) => (
            <option key={option} value={option}>
              {PROMPT_LABEL[option]}
            </option>
          ))}
        </select>
      </label>

      <label className="control">
        <span className="legend">Model</span>
        <select
          className="control-select"
          value={model ?? ""}
          disabled={disabled}
          onChange={(event) => onModel(event.target.value || null)}
          title={known ? selected?.description : "provisional list until the first turn"}
        >
          <option value="">default</option>
          {known ? (
            <>
              <optgroup label="This installation">{catalogue.map(modelOption)}</optgroup>
              {pinned.length > 0 && (
                <optgroup label="Pinned versions">{pinned.map(modelOption)}</optgroup>
              )}
              {backends.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.items.map(modelOption)}
                </optgroup>
              ))}
            </>
          ) : (
            // One group before the first turn -- nothing to contrast against yet. Backends keep
            // their groups regardless: they came from a file, not from a query nobody has run.
            <>
              {pinned.map(modelOption)}
              {backends.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.items.map(modelOption)}
                </optgroup>
              ))}
            </>
          )}
        </select>
      </label>

      {efforts.length > 0 && (
        <label className="control">
          <span className="legend">Effort</span>
          <select
            className="control-select"
            value={effort ?? ""}
            disabled={disabled}
            onChange={(event) => onEffort((event.target.value || null) as EffortLevel | null)}
          >
            <option value="">default</option>
            {efforts.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* One note slot, and the fixable message wins it. The catalogue arriving is just a wait. */}
      {promptMode === "tuned" && !tunedAvailable ? (
        <span className="note control-note">no system.md — Tuned adds nothing</span>
      ) : (
        !known && <span className="note control-note">catalogue arrives with the first turn</span>
      )}

    </div>
    </>
  );
}
