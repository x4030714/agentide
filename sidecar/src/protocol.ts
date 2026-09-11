/** The wire protocol, one JSON object per line. These schemas are the source of truth: change one
 * and change `agent.rs` and `src/lib/protocol.ts` too. Paths arrive normalized; never normalize here. */

import { StringDecoder } from "node:string_decoder";
import { z } from "zod";

/** A decoded JSON object, carried through without being interpreted. */
const jsonObject = z.record(z.string(), z.unknown());
export type JsonObject = Record<string, unknown>;

/** How the SDK resolves a call that is not pre-approved. Mirrors the SDK's `PermissionMode`. */
export const PermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/** How much reasoning a turn gets. Mirrors the SDK's `EffortLevel`; not every model takes every
 * level, which is what `ModelInfoSchema.supportedEffortLevels` carries. */
export const EffortLevelSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

/** Per-turn agent configuration. Sent with each prompt rather than at startup, so a mode change
 * takes effect on the next turn without restarting the sidecar. */
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
  /** Appended to Claude Code's preset system prompt, never replacing it: replacing throws away the
   * tool-use discipline the preset carries. Omitted means the bare preset. */
  systemPromptAppend: z.string().optional(),
  /** A bundle of SDK options the sidecar owns; see `advanced.ts`. One field rather than
   * five, so a subagent's prompt never crosses the wire. Startup-only, so it is in
   * `queryFingerprint`. */
  promptProfile: z.enum(["advanced"]).optional(),
  /** Which Claude account this turn runs under -- a key from `accounts.json`, or absent for
   * the machine's own login. Startup-only, so it is in `queryFingerprint`. */
  account: z.string().optional(),
  /** Continue a past conversation: the id of a transcript on disk, not a session this process has
   * seen. Per prompt, because picking one is something the user does mid-session. */
  resumeConversation: z.string().optional(),
  /** Which backend runs this turn, or omitted for Anthropic's own. Unlike `model` it cannot be
   * applied to a running query -- it is env the CLI reads once -- so a change rebuilds the query. */
  provider: z.string().optional(),
  /** Emit `stream_event` messages so text can render as it arrives. Off by default: it multiplies
   * event volume, and a UI that renders only complete messages should not pay for it. */
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

/** One slash command this installation accepts, as the SDK reports it. Read from the SDK because
 * they come from the CLI build, `.claude/commands` and plugins -- any fixed list is wrong somewhere. */
export const SlashCommandSchema = z.strictObject({
  /** Without the leading slash. */
  name: z.string(),
  description: z.string(),
  /** What arguments it takes, e.g. "<file>". Empty when it takes none. */
  argumentHint: z.string(),
  /** Other spellings that resolve to it, e.g. /cost for /usage. */
  aliases: z.array(z.string()).optional(),
});

export type SlashCommand = z.infer<typeof SlashCommandSchema>;

/** An MCP server the loader held back, and where it would have been. `host` and `port` travel with
 * the name because the chip has to say what to open; a name alone reads as a broken server. */
export const GatedServerSchema = z.strictObject({
  name: z.string(),
  host: z.string(),
  /** Bounded like the `requires` gate it comes from, so the Rust mirror can hold a u16. */
  port: z.number().int().min(1).max(65_535),
});
export type GatedServer = z.infer<typeof GatedServerSchema>;

/** The subset of the SDK's `ModelInfo` a picker needs; the rest is dropped, not forwarded and ignored. */
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

/** A configured backend as the host may see it: `baseUrl` and `token` stay in the sidecar. A key
 * that never crosses this boundary cannot be read out of the webview. */
/** One thing wrong with this install, and what to do about it. See `doctor.ts`. */
export const ProblemSchema = z.strictObject({
  severity: z.enum(["blocked", "degraded"]),
  title: z.string(),
  fix: z.string(),
  /** A command that fixes it, when one exists. The window runs it in a terminal tab, so a
   * sign-in's device code and prompts are visible and answerable. */
  command: z.string().optional(),
});
export type Problem = z.infer<typeof ProblemSchema>;

export const ProviderInfoSchema = z.strictObject({
  /** The key to send back as `PromptOptions.provider`. */
  key: z.string(),
  models: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      supportsEffort: z.boolean(),
    }),
  ),
  /** The command that starts it, when the entry gives one. */
  start: z.string().optional(),
  host: z.string(),
  port: z.number().int(),
  note: z.string().optional(),
});
export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;

/** One switchable Claude account. Carries no credential: an account here is a
 * `CLAUDE_CONFIG_DIR`, and the credential inside it is Claude Code's. */
export const AccountInfoSchema = z.strictObject({
  key: z.string(),
  name: z.string(),
  /** Shown so it is clear that switching also switches conversation history. */
  configDir: z.string(),
  /** Whether this directory has ever been signed in. Cheap: a file check, not a spawn. */
  used: z.boolean(),
});
export type AccountInfo = z.infer<typeof AccountInfoSchema>;

/** Who is signed in. Everything but `loggedIn` is absent on some auth methods, and all of
 * it is absent when the binary could not be asked at all. */
export const AccountSchema = z.strictObject({
  loggedIn: z.boolean(),
  method: z.string().optional(),
  email: z.string().optional(),
  organization: z.string().optional(),
  plan: z.string().optional(),
  error: z.string().optional(),
  /** What to run in a terminal to sign in. Resolved here because this is where the binary
   * is found; the window runs it in a tab rather than guessing the path itself. */
  loginCommand: z.string().optional(),
});
export type Account = z.infer<typeof AccountSchema>;

/**
 * Something attached to a prompt.
 *
 * Two kinds, because they reach the model two different ways. An `image` is inlined as a
 * content block -- the model looks at it, and there is no other way for it to. A `file` is
 * a path: the model already has Read and the `ide_*` tools, so pointing at it beats inlining
 * a megabyte of source into every later turn of the conversation.
 */
export const AttachmentSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("image"),
    /** What the Messages API accepts. Anything else is refused before it gets here. */
    mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    /** Base64, no data: prefix. */
    data: z.string().min(1),
    /** For the transcript row; a pasted image has none. */
    name: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal("file"),
    path: z.string().min(1),
  }),
]);
export type Attachment = z.infer<typeof AttachmentSchema>;

// host -> sidecar

export const HostMessageSchema = z.discriminatedUnion("t", [
  /** Run a turn. `cwd` is refilled from Rust state on every prompt, so a workspace change lands
   * without a sidecar restart. */
  z.strictObject({
    t: z.literal("prompt"),
    sessionId: z.string(),
    cwd: z.string(),
    text: z.string(),
    /** Images to look at and files to read. Absent is the ordinary case. */
    attachments: z.array(AttachmentSchema).optional(),
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
  /** Build the query without running a turn, so the command and model lists -- which live
   * on a live `Query` -- are there before the first prompt rather than after it. */
  z.strictObject({
    t: z.literal("warm"),
    sessionId: z.string(),
    cwd: z.string(),
    options: PromptOptionsSchema.optional(),
  }),
  /** Ask who is signed in, or sign out. Both answer with `account`.
   *
   * `logout` is machine-wide -- it drops the credential the person's own Claude Code uses --
   * so the surface that sends it has already confirmed with them. */
  z.strictObject({
    t: z.literal("auth"),
    action: z.enum(["status", "logout"]),
    /** Which account to ask about, or act on. Absent means the machine's own login. */
    account: z.string().optional(),
  }),
  /** Liveness probe. Answered with `pong` without touching the model. */
  z.strictObject({ t: z.literal("ping"), id: z.string() }),
]);
export type HostMessage = z.infer<typeof HostMessageSchema>;

// sidecar -> host

export const SidecarMessageSchema = z.discriminatedUnion("t", [
  /** Emitted once, before any other message, when the stdio loop is listening. */
  z.strictObject({ t: z.literal("ready"), pid: z.number().int(), sdkVersion: z.string() }),
  /** One `SDKMessage` from the agent SDK, verbatim. Opaque here and in Rust: the union is large and
   * moves, so only the transcript UI destructures it. */
  z.strictObject({ t: z.literal("event"), sessionId: z.string(), msg: jsonObject }),
  /** The models this installation can run. Once per sidecar, during the first turn, because the
   * list only exists on a live query. Not tied to a session -- it describes the installation. */
  z.strictObject({ t: z.literal("models"), models: z.array(ModelInfoSchema) }),
  /** The backends `providers.json` names. Refreshed every turn: the file is re-read every turn, and
   * a picker told once would go stale the moment a backend was added. */
  z.strictObject({ t: z.literal("providers"), providers: z.array(ProviderInfoSchema) }),
  /** What this machine is missing before it can run a turn. Sent once, at startup. */
  z.strictObject({ t: z.literal("readiness"), problems: z.array(ProblemSchema) }),
  z.strictObject({ t: z.literal("commands"), commands: z.array(SlashCommandSchema) }),
  /** The external MCP servers this turn was built without, because the application each one drives
   * is not open. Reported because an unstarted server is invisible in the SDK's own `init`. */
  z.strictObject({
    t: z.literal("mcp_gated"),
    sessionId: z.string(),
    servers: z.array(GatedServerSchema),
  }),
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
  /** Who is signed in, after an `auth` request. `note` carries the outcome of a sign-out,
   * in words the surface shows as-is. */
  z.strictObject({
    t: z.literal("account"),
    account: AccountSchema,
    /** Which account this describes, and every account that could be picked. Sent together
     * so the picker and the panel can never disagree about what is selected. */
    key: z.string(),
    accounts: z.array(AccountInfoSchema),
    note: z.string().optional(),
  }),
  /** How much of the context window the conversation occupies, after a turn. The number
   * that was invisible when a 925k-token conversation ate a session allowance in two turns. */
  z.strictObject({
    t: z.literal("context"),
    sessionId: z.string(),
    tokens: z.number().int().nonnegative(),
    /** The window the SDK measures against -- the compaction window when one is set. */
    max: z.number().int().positive(),
  }),
  z.strictObject({ t: z.literal("pong"), id: z.string() }),
]);
export type SidecarMessage = z.infer<typeof SidecarMessageSchema>;

// codec

/** Longer than this is a desynchronized stream, not a large message. Tool results carrying file
 * contents are why the ceiling is high. */
export const MAX_LINE_BYTES = 32 * 1024 * 1024;

/** Serialize a message to its wire line, terminator included. */
export function encodeLine(message: HostMessage | SidecarMessage): string {
  // JSON escapes newlines inside strings, so the encoded form is always one line.
  return `${JSON.stringify(message)}\n`;
}

/** Reassembles newline-delimited lines from arbitrary byte chunks. A read boundary falls
 * mid-message, mid-line or mid-UTF-8 character; the decoder and the carry buffer cover all three. */
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

/** Parse a host line, rejecting what this build cannot run. Validated rather than cast: a message
 * one field short should fail here with a readable error, not three frames into a handler. */
export function parseHostMessage(line: string): HostMessage {
  const parsed = HostMessageSchema.safeParse(JSON.parse(line));
  if (!parsed.success) {
    throw new Error(`unreadable host message: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
