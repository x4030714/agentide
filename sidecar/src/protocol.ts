/**
 * The sidecar wire protocol -- the single source of truth.
 *
 * One JSON object per line, both directions, over the sidecar's stdin/stdout.
 *
 * The shapes are declared as Zod schemas and the TypeScript types are derived from them,
 * so there is one definition rather than a type plus a validator that can drift apart.
 * `src-tauri/src/agent.rs` and `src/lib/protocol.ts` mirror what is here by hand; change
 * one and change the other two.
 *
 * The mirrors are kept honest by `protocol-fixtures.json`, which holds one canonical
 * message per variant. `codec.test.ts` validates every entry against the schemas below,
 * and `agent::tests::fixtures_*` parses the same file into the Rust types and serializes
 * it back. A field renamed, retyped or dropped on one side fails that side's test.
 *
 * ## Path policy
 *
 * Paths on this wire are already normalized: `agent.rs` fills `cwd` from the workspace
 * root it holds as a `WirePath`, and tool arguments naming files travel as strings the
 * host normalized on the way in. The sidecar never normalizes a path itself; see the
 * module docs in `src-tauri/src/ipc.rs` for why that is the rule.
 */

import { StringDecoder } from "node:string_decoder";
import { z } from "zod";

/** A decoded JSON object, carried through without being interpreted. */
const jsonObject = z.record(z.string(), z.unknown());
export type JsonObject = Record<string, unknown>;

/**
 * How the SDK resolves a tool call that is not pre-approved. Mirrors the SDK's
 * `PermissionMode`; Phase 2's mode toggle maps onto it.
 */
export const PermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/**
 * How much reasoning the model spends on a turn. Mirrors the SDK's `EffortLevel`.
 *
 * Not every model accepts every level; `ModelInfoSchema` carries the ones each model
 * takes, which is what the picker should offer.
 */
export const EffortLevelSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

/**
 * Per-turn agent configuration. Sent with each prompt rather than at startup so the
 * Phase 2 mode toggle takes effect on the next turn without restarting the sidecar.
 */
export const PromptOptionsSchema = z.strictObject({
  model: z.string().optional(),
  /** Omitted means the SDK's own default, which is not a value this protocol invents. */
  effort: EffortLevelSchema.optional(),
  permissionMode: PermissionModeSchema.optional(),
  /** Tools auto-approved without reaching `canUseTool`. */
  allowedTools: z.array(z.string()).optional(),
  /** Tools denied outright. A bare name removes the tool from the model's context. */
  disallowedTools: z.array(z.string()).optional(),
  maxTurns: z.number().int().optional(),
  /**
   * Appended to Claude Code's preset system prompt, never replacing it.
   *
   * Replacing would throw away the tool-use discipline the preset carries and make us
   * responsible for keeping it current per model release; appending keeps that and adds
   * what the preset cannot know. Omitted means the bare preset.
   */
  systemPromptAppend: z.string().optional(),
  /**
   * Emit `stream_event` messages so the transcript can render text as it arrives. Off by
   * default: it multiplies event volume, and a UI that only renders complete assistant
   * messages should not pay for it.
   */
  includePartialMessages: z.boolean().optional(),
});
export type PromptOptions = z.infer<typeof PromptOptionsSchema>;

/** The answer to a `tool_call`. Discriminated so a failure can never be read as text. */
export const ToolResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), text: z.string() }),
  z.strictObject({ ok: z.literal(false), error: z.string() }),
]);
export type ToolResult = z.infer<typeof ToolResultSchema>;

/** Why a turn ended. `interrupted` means the host asked, not that the model stopped. */
export const DoneReasonSchema = z.enum(["success", "interrupted", "max_turns", "error"]);
export type DoneReason = z.infer<typeof DoneReasonSchema>;

export const PermissionDecisionSchema = z.enum(["allow", "deny"]);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

/**
 * One model the installation can run. The subset of the SDK's `ModelInfo` a picker
 * needs; the fields describing modes this protocol does not plumb are dropped here
 * rather than forwarded and ignored.
 */
export const ModelInfoSchema = z.strictObject({
  /** The id to send back as `PromptOptions.model`. */
  value: z.string(),
  /** The canonical id `value` resolves to, when `value` is an alias such as `sonnet`. */
  resolvedModel: z.string().optional(),
  displayName: z.string(),
  description: z.string(),
  supportsEffort: z.boolean().optional(),
  /** The levels this model accepts. Absent means the SDK did not say. */
  supportedEffortLevels: z.array(EffortLevelSchema).optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

// ---------------------------------------------------------------------------
// host -> sidecar
// ---------------------------------------------------------------------------

export const HostMessageSchema = z.discriminatedUnion("t", [
  /**
   * Run a turn. `cwd` is the workspace root, filled by `agent.rs` from Rust state on
   * every prompt so a workspace change lands without a sidecar restart.
   */
  z.strictObject({
    t: z.literal("prompt"),
    sessionId: z.string(),
    cwd: z.string(),
    text: z.string(),
    options: PromptOptionsSchema.optional(),
  }),
  /** Answer to a `permission_request`. `message` is the reason shown to the model on deny. */
  z.strictObject({
    t: z.literal("permission_reply"),
    id: z.string(),
    decision: PermissionDecisionSchema,
    updatedInput: jsonObject.optional(),
    message: z.string().optional(),
  }),
  /** Answer to a `tool_call`. */
  z.strictObject({
    t: z.literal("tool_reply"),
    id: z.string(),
    result: ToolResultSchema,
  }),
  /** Stop the running turn and drop anything queued behind it. */
  z.strictObject({ t: z.literal("interrupt"), sessionId: z.string() }),
  /** Liveness probe. Answered with `pong` without touching the model. */
  z.strictObject({ t: z.literal("ping"), id: z.string() }),
]);
export type HostMessage = z.infer<typeof HostMessageSchema>;

// ---------------------------------------------------------------------------
// sidecar -> host
// ---------------------------------------------------------------------------

export const SidecarMessageSchema = z.discriminatedUnion("t", [
  /** Emitted once, before any other message, when the stdio loop is listening. */
  z.strictObject({ t: z.literal("ready"), pid: z.number().int(), sdkVersion: z.string() }),
  /**
   * One `SDKMessage` from the agent SDK, verbatim. Opaque here and in Rust: the SDK's
   * message union is large and moves, so only the transcript UI destructures it.
   */
  z.strictObject({ t: z.literal("event"), sessionId: z.string(), msg: jsonObject }),
  /**
   * The models this installation can run. Sent once per sidecar lifetime, during the
   * first turn: the list only exists on a live query, so there is nothing to report
   * before one has started. Not tied to a session -- it describes the installation.
   */
  z.strictObject({ t: z.literal("models"), models: z.array(ModelInfoSchema) }),
  /** A tool call that fell through to a prompt. Await a `permission_reply` with this id. */
  z.strictObject({
    t: z.literal("permission_request"),
    id: z.string(),
    sessionId: z.string(),
    tool: z.string(),
    input: jsonObject,
  }),
  /** An IDE tool needing data only the host has. Await a `tool_reply` with this id. */
  z.strictObject({
    t: z.literal("tool_call"),
    id: z.string(),
    sessionId: z.string(),
    name: z.string(),
    args: jsonObject,
  }),
  /** The turn ended. `error` carries detail when `reason` is `error`. */
  z.strictObject({
    t: z.literal("done"),
    sessionId: z.string(),
    reason: DoneReasonSchema,
    error: z.string().optional(),
  }),
  z.strictObject({ t: z.literal("pong"), id: z.string() }),
]);
export type SidecarMessage = z.infer<typeof SidecarMessageSchema>;

// ---------------------------------------------------------------------------
// codec
// ---------------------------------------------------------------------------

/**
 * A line longer than this is treated as a desynchronized stream rather than a large
 * message. Tool results carrying file contents are the reason the ceiling is high.
 */
export const MAX_LINE_BYTES = 32 * 1024 * 1024;

/** Serialize a message to its wire line, terminator included. */
export function encodeLine(message: HostMessage | SidecarMessage): string {
  // JSON escapes newlines inside strings, so the encoded form is always one line.
  return `${JSON.stringify(message)}\n`;
}

/**
 * Reassembles newline-delimited lines from arbitrary byte chunks.
 *
 * A stdio read boundary falls wherever the OS puts it: mid-message, mid-line and
 * mid-UTF-8-character are all normal. `StringDecoder` holds back a split character; the
 * carry buffer holds back a split line. Neither a chunk smaller than a message nor a
 * message larger than a chunk is a special case.
 */
export class LineDecoder {
  readonly #decoder = new StringDecoder("utf8");
  readonly #maxLineBytes: number;
  #carry = "";

  constructor(maxLineBytes: number = MAX_LINE_BYTES) {
    this.#maxLineBytes = maxLineBytes;
  }

  /** Complete lines contained in `chunk`, without their terminators. */
  push(chunk: Uint8Array | string): string[] {
    const text = typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    if (text === "") return [];

    const parts = (this.#carry + text).split("\n");
    // The last part has no terminator yet; it is the start of the next line.
    this.#carry = parts.pop() ?? "";
    // Comparing UTF-16 units against a byte ceiling under-counts, never over-counts, so
    // this can only trip later than the true byte limit -- the safe direction for a guard.
    if (this.#carry.length > this.#maxLineBytes) {
      this.#carry = "";
      throw new Error(`wire line exceeds ${this.#maxLineBytes} bytes; stream desynchronized`);
    }
    // A host writing CRLF is not this layer's problem to diagnose.
    return parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line)).filter(Boolean);
  }

  /** Whatever is buffered at end of stream. A well-behaved peer leaves nothing. */
  flush(): string | null {
    const rest = this.#carry.trim();
    this.#carry = "";
    return rest === "" ? null : rest;
  }
}

/**
 * Parse a host line, rejecting anything this build does not know how to run.
 *
 * Validated rather than cast: the host is another process, and a message that is one
 * field short should fail here with a readable error rather than three frames deep in a
 * handler.
 */
export function parseHostMessage(line: string): HostMessage {
  const parsed = HostMessageSchema.safeParse(JSON.parse(line));
  if (!parsed.success) {
    throw new Error(`unreadable host message: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
