import { EDIT_MODES, MODE_HELP, MODE_LABEL } from "../lib/editmode";
import type { EditMode } from "../lib/editmode";
import { PROMPT_HELP, PROMPT_LABEL, PROMPT_MODES } from "../lib/promptmode";
import type { PromptMode } from "../lib/promptmode";
import type { EffortLevel, ModelInfo } from "../lib/protocol";
import type { McpServerRow } from "../lib/transcript";

/**
 * What the next turn runs on. Sits directly above the composer, because it describes
 * the prompt you are about to send rather than the conversation behind it.
 *
 * Both values are optional at every hop: unset means the SDK's own default, which is a
 * real answer, not a missing one. Neither is invented here.
 */

/**
 * Shown until the SDK publishes its catalogue, which only happens once a turn has begun.
 * Provisional and labelled as such — offering nothing would make the control useless
 * before the first prompt, and offering a fabricated list would be worse.
 */
const PROVISIONAL_MODELS: ModelInfo[] = [
  { value: "claude-opus-5", displayName: "Opus 5", description: "" },
  { value: "claude-sonnet-5", displayName: "Sonnet 5", description: "" },
  { value: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "" },
];

const ALL_EFFORTS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * A server's status as a colour class. Only `connected` is good news; everything else,
 * including a status this build has not seen, is something the person has to act on, so
 * an unknown word warns rather than passing silently.
 *
 * `pending` warns rather than reading as a quiet wait. MCP startup is non-blocking, and
 * this row describes the init message -- the moment the turn's prompt was built. A server
 * still pending then contributed no tools to the turn the person is watching, which is
 * the state this strip was added to reveal. Dimming it would hide it.
 *
 * Only `disabled` is dimmed, because that one is a choice rather than an outcome.
 */
function mcpTone(status: string): string {
  if (status === "connected") return "ok";
  if (status === "disabled") return "off";
  if (status === "failed") return "error";
  return "warn";
}

interface RunControlsProps {
  mode: EditMode;
  onMode: (mode: EditMode) => void;
  promptMode: PromptMode;
  onPromptMode: (mode: PromptMode) => void;
  /** False when `.agentide/system.md` is absent, so Tuned can say it has nothing to add. */
  tunedAvailable: boolean;
  models: ModelInfo[];
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
  model,
  effort,
  onModel,
  onEffort,
  mcpServers,
  disabled,
}: RunControlsProps) {
  const known = models.length > 0;
  const list = known ? models : PROVISIONAL_MODELS;
  const selected = list.find((entry) => entry.value === model);

  /**
   * Only the levels this model actually has. The SDK silently downgrades an unsupported
   * level, and a control that offers a setting which quietly does nothing is worse than
   * one that does not offer it.
   */
  const efforts =
    selected?.supportedEffortLevels ??
    (selected && selected.supportsEffort === false ? [] : ALL_EFFORTS);

  return (
    <div className="run-controls">
      {/**
       * A segmented control, not a select: three options that change how much the agent
       * can do without asking should all be visible at once, and the one in force should
       * be readable without opening anything.
       */}
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

      <div className="segmented" role="radiogroup" aria-label="System prompt">
        {PROMPT_MODES.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={option === promptMode}
            className={`segment${option === promptMode ? " is-on" : ""}`}
            title={
              option === "tuned" && !tunedAvailable
                ? "No .agentide/system.md in this workspace, so this adds nothing yet."
                : PROMPT_HELP[option]
            }
            disabled={disabled}
            onClick={() => onPromptMode(option)}
          >
            {PROMPT_LABEL[option]}
          </button>
        ))}
      </div>

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
          {list.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.displayName}
            </option>
          ))}
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

      {/**
       * One note slot, and the more actionable message wins it. A missing system.md is
       * something the person can fix; the catalogue arriving is just a wait.
       */}
      {promptMode === "tuned" && !tunedAvailable ? (
        <span className="note control-note">no .agentide/system.md — Tuned adds nothing</span>
      ) : (
        !known && <span className="note control-note">catalogue arrives with the first turn</span>
      )}

      {/**
       * The MCP servers this turn will have, one chip each.
       *
       * Here rather than in a pane of its own, because it answers the same question the
       * rest of this row does -- what the next prompt runs with -- and because an MCP
       * server is only ever interesting for the two seconds after it fails to start.
       * A connected server shows its tool count and nothing else; anything else shows
       * the status word, because that is the part worth reading.
       *
       * A connected server contributing zero tools is drawn as a warning. It is the
       * shape of the bug that hid the IDE's own tools for three phases, and "connected"
       * on its own says nothing about whether the model can see anything.
       */}
      {mcpServers.length > 0 && (
        <div className="mcp-strip">
          <span className="legend">MCP</span>
          {mcpServers.map((server) => {
            const empty = server.status === "connected" && server.tools === 0;
            return (
              <span
                key={server.name}
                className={`mcp-server is-${empty ? "warn" : mcpTone(server.status)}`}
                title={`${server.name}: ${server.status}, ${server.tools} tool${server.tools === 1 ? "" : "s"}`}
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
    </div>
  );
}
