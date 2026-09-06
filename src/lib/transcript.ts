/**
 * Folds the agent channel into rows the transcript can draw.
 *
 * This file exists so exactly one place has to understand the SDK's message union.
 * That union is large (37 variants), it moves between releases, and two of its shapes
 * are actively misleading:
 *
 *   - `type: "system"` is not one variant. It discriminates again on `subtype` --
 *     `init`, `api_retry`, `compact_boundary`, `status` -- so switching on `type` alone
 *     silently collapses a rate-limit retry and a context compaction into one bucket.
 *   - a tool's *result* arrives as a `type: "user"` message with `isSynthetic`. Render
 *     `type: "user"` naively and the model's own tool output appears as something the
 *     person said.
 *
 * The reducer is pure and takes `TranscriptAction`, so it can be tested against
 * recorded event sequences without a browser, a sidecar, or a model call.
 *
 * Rows are addressed. The address is the durable anchor the world is built on: it never
 * renumbers, so a row can be referred to after the fact.
 */

import type {
  AgentEvent,
  ConversationEntry,
  JsonObject,
  ModelInfo,
  SlashCommand,
} from "./protocol";

/** What drives a tool row's colour: what kind of thing the agent reached for. */
export type ToolClass =
  | "read" /* Read, Glob, Grep -- looks, changes nothing */
  | "mutate" /* Write, Edit -- changes the tree */
  | "exec" /* Bash -- runs something */
  | "semantic" /* ide_* -- consults the language server */
  | "net" /* WebFetch, WebSearch -- leaves the machine */
  | "agent" /* Task -- spawns a subagent */
  | "other";

export type RowStatus = "running" | "ok" | "error" | "denied" | "abandoned";

export type NoticeTone = "info" | "warn" | "error";

interface BaseRow {
  /** Monotonic, never reused, never renumbered. */
  addr: number;
  /** Which turn this row belongs to, for drawing boundary rules. */
  turn: number;
}

export type Row =
  | (BaseRow & { kind: "prompt"; text: string })
  | (BaseRow & { kind: "text"; text: string })
  | (BaseRow & { kind: "thinking"; text: string })
  | (BaseRow & {
      kind: "tool";
      id: string;
      name: string;
      cls: ToolClass;
      operand: string;
      status: RowStatus;
      /** Right-aligned measurement: the size of what came back. */
      measure?: string;
      /** Full result text, for expansion. */
      detail?: string;
      /**
       * What the tool was called with, kept only when `cls` is `mutate`.
       *
       * Conditional because this is the one class whose input is drawn: `toolDiff` builds
       * the edit's diff out of it, and the result text -- "File created successfully" --
       * cannot. Every other tool's arguments would sit in state for the rest of the
       * session having never been read, and inputs are not small: a `Task` carries a whole
       * subagent prompt. The mutating ones are already the expensive half, since a `Write`
       * holds the entire file.
       */
      input?: JsonObject;
      /** Seconds elapsed, while still running. */
      elapsed?: number;
      /**
       * The approval this call is waiting on, when it needed one. It lives on the row
       * rather than beside it: a `tool_use` block and its `permission_request` are one
       * action, and drawing both gives it two addresses.
       */
      permission?: { id: string; status: "pending" | "allow" | "deny"; source?: "ui" | "host" };
    })
  | (BaseRow & {
      kind: "permission";
      id: string;
      tool: string;
      operand: string;
      input: JsonObject;
      status: "pending" | "allow" | "deny";
      /** Who answered. `host` means the core auto-answered, not the person. */
      source?: "ui" | "host";
    })
  | (BaseRow & { kind: "notice"; tone: NoticeTone; text: string })
  | (BaseRow & {
      kind: "turn";
      reason: string;
      durationMs?: number;
      costUsd?: number;
      turns?: number;
      error?: string;
    });

/**
 * The status of a server the loader never started, because the application it drives is
 * not open.
 *
 * Not one of the SDK's words -- the SDK never saw this server. `closed` describes the
 * program rather than the server: nothing failed, the thing it talks to is shut. It is
 * a constant because `RunControls` tones and titles chips by it, and a second spelling
 * would dim nothing and say nothing.
 */
export const MCP_CLOSED = "closed";

/**
 * What the agent is doing right now, for the line above the composer.
 *
 * Derived from the rows rather than tracked alongside them. A second piece of state
 * saying "currently editing" would be a second thing that can be wrong, and it would go
 * stale exactly when a turn ends unexpectedly -- which is the moment the line matters.
 */
export interface Activity {
  /** What is happening, in a word: `thinking`, `editing`, `running`. */
  verb: string;
  /** What it is happening to: a file, a command, a symbol. */
  detail?: string;
  /** Reasoning tokens so far, while the model is thinking. */
  tokens?: number;
  /** Waiting on a person rather than on the model, which is a different kind of wait. */
  blocked?: boolean;
}

/** The verb for a tool, from what kind of thing it reaches for. */
const VERBS: Record<ToolClass, string> = {
  read: "reading",
  mutate: "editing",
  exec: "running",
  semantic: "resolving",
  net: "fetching",
  agent: "delegating",
  other: "working",
};

/**
 * The one thing worth saying about a turn in flight, or `null` when nothing is.
 *
 * Ordered by what the person can act on. An approval outranks everything, because
 * nothing is happening until it is answered and the wait is theirs to end. A running
 * tool outranks thinking, because the tool is the more specific answer -- "editing
 * ide-host.ts" beats "thinking" when both are true.
 */
export function liveActivity(state: TranscriptState): Activity | null {
  if (state.status !== "running") return null;

  const pending = findLastIndex(
    state.rows,
    (row) =>
      (row.kind === "permission" && row.status === "pending") ||
      (row.kind === "tool" && row.permission?.status === "pending"),
  );
  if (pending !== -1) {
    const row = state.rows[pending];
    const tool = row.kind === "permission" ? row.tool : row.kind === "tool" ? row.name : "";
    return { verb: "waiting for you", detail: shortToolName(tool), blocked: true };
  }

  const busy = findLastIndex(state.rows, (row) => row.kind === "tool" && row.status === "running");
  if (busy !== -1) {
    const row = state.rows[busy];
    if (row.kind === "tool") {
      return { verb: VERBS[row.cls], detail: row.operand || shortToolName(row.name) };
    }
  }

  if (state.thinking !== null) return { verb: "thinking", tokens: state.thinking };
  return { verb: "working" };
}

/** One MCP server the turn started with, as the init message described it. */
export interface McpServerRow {
  name: string;
  /**
   * The SDK's own word: `connected`, `failed`, `pending`, `needs-auth`, `disabled` --
   * or `MCP_CLOSED` for a server the sidecar held back before the SDK could see it.
   */
  status: string;
  /** How many of the turn's tools came from this server. Derived; see `readMcpServers`. */
  tools: number;
  /** `host:port` the gate found closed. Only ever set on a `MCP_CLOSED` row. */
  at?: string;
}

export interface TranscriptMeta {
  pid?: number;
  sdkVersion?: string;
  model?: string;
  cwd?: string;
  toolCount?: number;
  permissionMode?: string;
  /**
   * Every external MCP server this turn has, started or held back -- the rendered list,
   * rebuilt from both halves by `mergeMcp`. Undefined until one of them arrives; empty
   * means the turn had none.
   */
  mcpServers?: McpServerRow[];
}

export type TranscriptStatus = "idle" | "starting" | "ready" | "running" | "exited";

export interface TranscriptState {
  rows: Row[];
  status: TranscriptStatus;
  /** Slash commands this installation accepts, as the SDK reported them. */
  commands: SlashCommand[];
  sessionId: string | null;
  meta: TranscriptMeta;
  /**
   * Row index by SDK `tool_use` id, so a result can find its call.
   *
   * A `Map`, mutated in place, and deliberately not part of the immutable state: these
   * are derived lookup tables that nothing renders, so copying them per event bought no
   * safety and cost a second quadratic on top of the `rows` copy. `rows` itself stays
   * immutable, because React's identity check is what makes a memoised row cheap.
   */
  toolIndex: Map<string, number>;
  /** Row index by host permission-request id. Same reasoning as `toolIndex`. */
  permIndex: Map<string, number>;
  nextAddr: number;
  turn: number;
  /**
   * Whether an SDK `result` already closed this turn. Both `result` and the protocol's
   * own `done` mark the end, and drawing both prints the turn close twice -- `result`
   * wins because it is the one carrying duration, cost and turn count.
   */
  turnClosed: boolean;
  /**
   * Live reasoning estimate while the model thinks, or null when it is not.
   *
   * This is a real measurement, not a spinner: the SDK streams
   * `system/thinking_tokens` with a running estimate. It is deliberately not a row --
   * addresses never renumber, so a transient state must not consume one.
   */
  thinking: number | null;
  /**
   * When the running turn began, for the elapsed clock beside the activity line.
   *
   * Wall clock rather than a tick count: the number has to survive the pane
   * re-rendering, and a counter incremented in the reducer would reset every time a
   * row arrived -- which on a busy turn is constantly.
   */
  turnStartedAt: number;
  /**
   * The SDK's own model catalogue, empty until the first turn publishes it. Empty means
   * "not known yet", never "none available" -- the UI must say so rather than showing an
   * empty picker, and must not gate sending on it.
   */
  models: ModelInfo[];
  /**
   * The two halves the MCP strip is built from, kept unmerged. See `mergeMcp`.
   *
   * `started` is undefined until an init message arrives, which is what keeps
   * `meta.mcpServers` undefined when nothing has reported yet.
   */
  mcp: { started?: McpServerRow[]; gated: McpServerRow[] };
}

/** A prompt the person submitted. Not on the wire — the UI raises it locally. */
export type TranscriptAction =
  | { t: "prompt_submitted"; text: string }
  /**
   * Start a new conversation in the same sidecar.
   *
   * Everything the conversation accumulated goes -- rows, addresses, turn count, the
   * derived indices -- while everything that describes the *installation* stays: the
   * model list and the command list were read once per sidecar and are still true. The
   * status stays too, because the sidecar did not restart and is still ready.
   */
  /**
   * A line the UI needs to say for itself, with no event behind it.
   *
   * Raised locally like `prompt_submitted`, and for the same reason: the checkpoint
   * that could not be taken is something this app knows and the SDK never hears about,
   * so there is no event to fold. It is a row rather than a toast because it belongs to
   * the turn it qualifies -- scrolling back to a turn should show that it had no
   * checkpoint, not leave that fact in a notification that has since gone.
   */
  | { t: "local_notice"; tone: NoticeTone; text: string }
  | { t: "conversation_reset" }
  /**
   * Replay a conversation this session is about to continue.
   *
   * Resuming used to be invisible: the SDK was handed the id at prompt time and the
   * transcript stayed empty, so the model knew the history and the person did not. What
   * you were continuing was a word in a status line rather than something you could read.
   *
   * The rows are the real exchange, drawn as prompts and replies like any other, because
   * that is what they are. A notice marks where the replay ends and this session begins --
   * the one thing the rows cannot say for themselves.
   */
  | { t: "conversation_loaded"; id: string; entries: ConversationEntry[] }
  | AgentEvent;

export function initialState(): TranscriptState {
  return {
    rows: [],
    status: "idle",
    sessionId: null,
    meta: {},
    toolIndex: new Map(),
    permIndex: new Map(),
    nextAddr: 1,
    turn: 0,
    turnClosed: false,
    thinking: null,
    turnStartedAt: 0,
    models: [],
    commands: [],
    mcp: { gated: [] },
  };
}

// --- Classification ----------------------------------------------------------

const TOOL_CLASSES: Record<string, ToolClass> = {
  Read: "read",
  Glob: "read",
  Grep: "read",
  NotebookRead: "read",
  Write: "mutate",
  Edit: "mutate",
  NotebookEdit: "mutate",
  Bash: "exec",
  BashOutput: "exec",
  KillShell: "exec",
  WebFetch: "net",
  WebSearch: "net",
  Task: "agent",
};

export function toolClass(name: string): ToolClass {
  // MCP tools arrive namespaced, e.g. `mcp__ide__ide_diagnostics`.
  const bare = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  if (bare.startsWith("ide_")) return "semantic";
  return TOOL_CLASSES[bare] ?? "other";
}

/** Strip the MCP namespace so the op column stays a fixed, readable width. */
export function shortToolName(name: string): string {
  return name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
}

/**
 * The one argument worth putting in the operand column. Falls back to the first string
 * in the input rather than printing nothing, because an unknown tool with no operand is
 * a row you cannot act on.
 */
/**
 * The file an assistant message is about to change, or `null` when it is not changing one.
 *
 * Read straight off the message rather than out of the rows, because the point is to open
 * the file *as the edit is announced* -- a row exists by then too, but it carries the
 * display operand, which is relative and has already lost the drive letter.
 *
 * Only `mutate` tools count. Opening the editor on every `Read` would yank the view around
 * for the whole of a turn spent looking, and the person is usually reading something else
 * while that happens.
 *
 * `vault` is the memory vault, when there is one. A note is written with `Write` like any
 * other file, so without this the editor jumps to a memory note the moment the agent
 * records something -- taking the view off the code the turn is actually about. What is in
 * the vault is the agent's own bookkeeping; it is worth a row, not the editor.
 */
export function editedFile(msg: JsonObject, vault?: string): string | null {
  if (msg.type !== "assistant") return null;
  for (const block of blocksOf(msg)) {
    if (block.type !== "tool_use" || !block.name) continue;
    if (toolClass(block.name) !== "mutate") continue;
    const input = block.input as JsonObject | undefined;
    for (const key of ["file_path", "notebook_path", "path"]) {
      const value = input?.[key];
      if (typeof value !== "string" || value === "") continue;
      const path = wirePath(value);
      return inside(path, vault) ? null : path;
    }
  }
  return null;
}

/**
 * Is `path` under `dir`?
 *
 * Case-insensitive, because this is Windows and the model types whatever spelling it
 * inferred -- `c:\users\...` against a vault the core normalized to `C:/Users/...` would
 * compare as a different tree and let the note through. Both sides are already
 * forward-slashed by the time they get here.
 */
function inside(path: string, dir: string | undefined): boolean {
  if (!dir) return false;
  const base = dir.replace(/\/$/, "").toLowerCase();
  return path.toLowerCase().startsWith(`${base}/`);
}

/**
 * A path as the rest of this app spells one: forward slashes, upper-case drive.
 *
 * The SDK hands back what the model typed, which on Windows is `C:\a\b`. Everything here
 * matches paths by string -- the editor's open file, the watcher's events -- so one
 * spelling reaching the editor and another reaching the watcher means the file opens and
 * then never refreshes. See the `WirePath` note in CLAUDE.md.
 */
function wirePath(raw: string): string {
  return raw
    .split("\\")
    .join("/")
    .replace(/^([a-z]):/, (_, letter: string) => `${letter.toUpperCase()}:`);
}

export function operandOf(name: string, input: JsonObject | undefined, cwd?: string): string {
  if (!input) return "";
  const bare = shortToolName(name);
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string" && value !== "") return value;
    }
    return undefined;
  };

  let raw: string | undefined;
  switch (bare) {
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookRead":
    case "NotebookEdit":
      raw = pick("file_path", "notebook_path", "path");
      break;
    case "Glob":
    case "Grep":
      raw = pick("pattern");
      break;
    case "Bash":
    case "BashOutput":
      raw = pick("command", "description");
      break;
    case "WebFetch":
      raw = pick("url");
      break;
    case "WebSearch":
      raw = pick("query");
      break;
    case "Task":
      raw = pick("description", "subagent_type");
      break;
    default:
      // `symbol` leads: for an `ide_*` call the symbol is the subject and the path is
      // merely where it was found.
      raw = pick("symbol", "name", "query", "pattern", "path", "file_path");
  }
  if (raw === undefined) {
    const first = Object.values(input).find((v) => typeof v === "string" && v !== "");
    raw = typeof first === "string" ? first : "";
  }
  return collapse(relativize(raw, cwd));
}

/** Paths render relative to the workspace: the root is already in the module header. */
function relativize(value: string, cwd?: string): string {
  if (!cwd) return value;
  const norm = value.replace(/\\/g, "/");
  const root = cwd.replace(/\\/g, "/").replace(/\/$/, "");
  return norm.startsWith(`${root}/`) ? norm.slice(root.length + 1) : norm;
}

/** One line, no runs of whitespace — a listing row is a row. */
function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Byte counts in the same shape the tree's length column uses. */
export function formatMeasure(text: string): string {
  const bytes = text.length;
  if (bytes < 1024) return String(bytes);
  const units = ["K", "M"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return value < 10 ? `${value.toFixed(1)}${units[unit]}` : `${Math.round(value)}${units[unit]}`;
}

// --- Content-block reading ---------------------------------------------------

interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: JsonObject;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function blocksOf(msg: JsonObject): Block[] {
  const message = msg.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (Array.isArray(content)) return content as Block[];
  // A plain string body is legal for a user message.
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

/** A tool result's body is a string, or content blocks, depending on the tool. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const b = block as Block;
        if (typeof b === "string") return b;
        if (b?.type === "text" && typeof b.text === "string") return b.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// --- Reducer -----------------------------------------------------------------

export function reduce(state: TranscriptState, action: TranscriptAction): TranscriptState {
  switch (action.t) {
    case "prompt_submitted":
      return push(
        {
          ...state,
          status: "running",
          turn: state.turn + 1,
          turnClosed: false,
          thinking: null,
          turnStartedAt: Date.now(),
        },
        (addr, turn) => ({ kind: "prompt", addr, turn, text: action.text }),
      );

    case "local_notice":
      return push(state, (addr, turn) => ({
        kind: "notice",
        addr,
        turn,
        tone: action.tone,
        text: action.text,
      }));

    case "conversation_reset": {
      const fresh = initialState();
      return {
        ...fresh,
        status: state.status === "exited" ? "exited" : "ready",
        models: state.models,
        commands: state.commands,
        meta: { ...fresh.meta, pid: state.meta.pid, sdkVersion: state.meta.sdkVersion },
      };
    }

    case "conversation_loaded": {
      // Reset first, for the same reasons `conversation_reset` gives: a replay is the
      // start of a different conversation, and leaving the previous one above it would
      // put two histories in one column with nothing marking the seam.
      const fresh = initialState();
      let next: TranscriptState = {
        ...fresh,
        status: state.status === "exited" ? "exited" : "ready",
        models: state.models,
        commands: state.commands,
        meta: { ...fresh.meta, pid: state.meta.pid, sdkVersion: state.meta.sdkVersion },
      };

      for (const entry of action.entries) {
        const text = entry.text.trim();
        // A reply that only called tools has no text of its own. Naming the tools is
        // better than an empty row, and much better than dropping the turn entirely.
        const body =
          text || (entry.tools.length > 0 ? `(used ${entry.tools.join(", ")})` : "");
        if (!body) continue;
        next = push(next, (addr, turn) =>
          entry.role === "user"
            ? { addr, turn, kind: "prompt", text: body }
            : { addr, turn, kind: "text", text: body },
        );
      }

      const count = next.rows.length;
      return push(next, (addr, turn) => ({
        addr,
        turn,
        kind: "notice",
        tone: "info",
        text:
          count > 0
            ? `continuing ${action.id} — ${count} message${count === 1 ? "" : "s"} above are its history`
            : `continuing ${action.id} — nothing was said in it yet`,
      }));
    }

    case "models":
      return { ...state, models: action.models };

    case "commands":
      return { ...state, commands: action.commands };

    case "mcp_gated":
      return mergeMcp(state, {
        ...state.mcp,
        gated: action.servers.map((server) => ({
          name: server.name,
          status: MCP_CLOSED,
          // Nothing was started, so nothing was contributed. Stated rather than left
          // out: a chip with no count is the shape of a server whose tools vanished.
          tools: 0,
          at: `${server.host}:${server.port}`,
        })),
      });

    case "ready":
      return {
        ...state,
        status: "ready",
        meta: { ...state.meta, pid: action.pid, sdkVersion: action.sdkVersion },
      };

    case "event":
      return reduceSdk({ ...state, sessionId: action.sessionId }, action.msg);

    case "permission_request": {
      // The call it belongs to is the most recent unapproved one still running under
      // that name. The SDK emits the `tool_use` block first, so it is already drawn.
      const name = shortToolName(action.tool);
      const index = findLastIndex(
        state.rows,
        (row) => row.kind === "tool" && row.status === "running" && row.name === name && !row.permission,
      );
      if (index >= 0) {
        return replace(state, index, (row) =>
          row.kind === "tool" ? { ...row, permission: { id: action.id, status: "pending" } } : row,
        );
      }
      // No call to attach to (an approval that arrived before its block, or for a tool
      // this surface never drew). A standalone row beats silently dropping the prompt.
      return push({ ...state }, (addr, turn) => ({
        kind: "permission",
        addr,
        turn,
        id: action.id,
        tool: name,
        operand: operandOf(action.tool, action.input, state.meta.cwd),
        input: action.input,
        status: "pending",
      }));
    }

    case "permission_decided": {
      const attached = findLastIndex(
        state.rows,
        (row) => row.kind === "tool" && row.permission?.id === action.id,
      );
      if (attached >= 0) {
        return replace(state, attached, (row) =>
          row.kind === "tool" && row.permission
            ? {
                ...row,
                permission: { ...row.permission, status: action.decision, source: action.source },
                // A denial ends the call; the SDK sends no tool_result for it.
                status: action.decision === "deny" ? "denied" : row.status,
              }
            : row,
        );
      }
      const index = state.permIndex.get(action.id);
      if (index === undefined) return state;
      return replace(state, index, (row) =>
        row.kind === "permission"
          ? { ...row, status: action.decision, source: action.source }
          : row,
      );
    }

    // The host-side halves of an `ide_*` call. The call itself already rendered as a
    // `tool_use` block, so drawing these again would double every semantic row.
    case "tool_call":
    case "tool_result":
      return state;

    case "done":
      // `result` already drew this turn's close, with more detail than `done` carries.
      if (state.turnClosed && !action.error) {
        return { ...state, status: "ready", thinking: null };
      }
      return push(
        { ...state, status: "ready", turnClosed: true, thinking: null },
        (addr, turn) => ({
          kind: "turn",
          addr,
          turn,
          reason: action.reason,
          error: action.error,
        }),
      );

    case "exited": {
      // Fail exactly the rows that will never be answered, rather than spinning.
      const rows = state.rows.map((row) =>
        row.kind === "tool" && row.status === "running"
          ? {
              ...row,
              status: "abandoned" as const,
              permission: row.permission?.status === "pending"
                ? { ...row.permission, status: "deny" as const, source: "host" as const }
                : row.permission,
            }
          : row.kind === "permission" && row.status === "pending"
            ? { ...row, status: "deny" as const, source: "host" as const }
            : row,
      );
      return push({ ...state, rows, status: "exited", thinking: null }, (addr, turn) => ({
        kind: "notice",
        addr,
        turn,
        tone: action.code === 0 ? "info" : "error",
        text: action.message,
      }));
    }

    default:
      return state;
  }
}

function reduceSdk(state: TranscriptState, msg: JsonObject): TranscriptState {
  const type = typeof msg.type === "string" ? msg.type : "";

  if (type === "system") return reduceSystem(state, msg);
  if (type === "assistant") return reduceAssistant(state, msg);
  if (type === "user") return reduceUser(state, msg);
  if (type === "result") return reduceResult(state, msg);
  if (type === "tool_progress") return reduceProgress(state, msg);
  // stream_event and the two dozen remaining variants carry nothing this surface
  // draws. Dropping them is deliberate: an unknown variant must never become a row.
  return state;
}

function reduceSystem(state: TranscriptState, msg: JsonObject): TranscriptState {
  switch (msg.subtype) {
    case "init": {
      const tools = Array.isArray(msg.tools)
        ? msg.tools.filter((tool): tool is string => typeof tool === "string")
        : [];
      // Through `mergeMcp` rather than straight into `meta`: this message owns the
      // started half of the strip and nothing else.
      const merged = mergeMcp(state, {
        ...state.mcp,
        started: readMcpServers(msg.mcp_servers, tools),
      });
      return {
        ...merged,
        meta: {
          ...merged.meta,
          model: typeof msg.model === "string" ? msg.model : undefined,
          cwd: typeof msg.cwd === "string" ? msg.cwd : undefined,
          toolCount: Array.isArray(msg.tools) ? msg.tools.length : undefined,
          permissionMode:
            typeof msg.permissionMode === "string" ? msg.permissionMode : undefined,
        },
      };
    }
    case "api_retry": {
      const attempt = num(msg.attempt);
      const max = num(msg.max_retries);
      const status = msg.error_status === null ? "" : ` ${num(msg.error_status) ?? ""}`;
      return push(state, (addr, turn) => ({
        kind: "notice",
        addr,
        turn,
        tone: "warn",
        text: `api retry ${attempt ?? "?"}/${max ?? "?"}${status} — ${String(msg.error ?? "")}`,
      }));
    }
    case "memory_recall": {
      // The recall supervisor pulled notes into this turn before the model saw the
      // prompt. Unsaid, that is indistinguishable from the model guessing correctly --
      // and when it recalls the wrong note, from the model being wrong for no reason.
      // Naming the notes is what makes both cases readable, and it is the only place the
      // vault appears in the transcript at all.
      const names = recalled(msg.memories);
      if (names.length === 0) return state;
      return push(state, (addr, turn) => ({
        kind: "notice",
        addr,
        turn,
        tone: "info",
        text: `recalled from memory — ${names.join(", ")}`,
      }));
    }
    case "thinking_tokens": {
      // A live estimate while the model reasons. Never a row.
      const tokens = num(msg.estimated_tokens);
      return tokens === undefined ? state : { ...state, thinking: tokens };
    }
    case "compact_boundary": {
      const meta = msg.compact_metadata as
        | { trigger?: string; pre_tokens?: number; post_tokens?: number }
        | undefined;
      const pre = meta?.pre_tokens;
      const post = meta?.post_tokens;
      const span =
        pre !== undefined && post !== undefined
          ? ` ${formatTokens(pre)} → ${formatTokens(post)}`
          : "";
      return push(state, (addr, turn) => ({
        kind: "notice",
        addr,
        turn,
        tone: "info",
        text: `context compacted (${meta?.trigger ?? "auto"})${span}`,
      }));
    }
    default:
      // `status` and friends are chatter, not events worth an address.
      return state;
  }
}

/**
 * What a `memory_recall` surfaced, as short names.
 *
 * A memory's `path` is one of three things and only the first is a file: an absolute path
 * to a note, a `<synthesis:DIR>` sentinel standing for a paragraph distilled from many
 * small notes, or an https URL for an organization memory. Each gets the shortest thing
 * that still identifies it -- the whole path would push the row past the pane and the
 * vault prefix is the same on every entry, so it distinguishes nothing.
 *
 * Duplicates are dropped: two entries can name the same file when the same note is
 * surfaced under more than one scope, and the row should not say it twice.
 */
function recalled(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const memory of value) {
    const path = (memory as { path?: unknown } | null)?.path;
    if (typeof path !== "string" || path === "") continue;
    // `filter(Boolean)` so a URL with a trailing slash names its last segment rather
    // than nothing -- an entry that contributes no name would make the row understate
    // what was recalled, which is the whole failure this is here to prevent.
    const name = path.startsWith("<synthesis:")
      ? "a synthesis"
      : (path.split(/[\\/]/).filter(Boolean).pop() ?? path);
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Rebuild `meta.mcpServers` from both halves, replacing whichever one `mcp` carries.
 *
 * Two messages describe this strip and both arrive at the start of the same turn: the
 * SDK's `init`, listing the servers that were started, and the sidecar's `mcp_gated`,
 * listing the ones it held back. Nothing orders them against each other, so each is
 * stored as it lands and the rendered list is derived. Writing the merged list directly
 * would make whichever arrived second overwrite the first -- and `readMcpServers`
 * returns undefined for an init with no `mcp_servers` at all, which through a `...meta`
 * spread would erase the gated chips rather than leave them alone.
 *
 * Started first, held back after: the servers the turn can actually use lead.
 */
function mergeMcp(state: TranscriptState, mcp: TranscriptState["mcp"]): TranscriptState {
  const merged =
    mcp.started === undefined && mcp.gated.length === 0
      ? undefined
      : [...(mcp.started ?? []), ...mcp.gated];
  return { ...state, mcp, meta: { ...state.meta, mcpServers: merged } };
}

/**
 * The init message's MCP servers, each with the number of tools it contributed.
 *
 * The count is derived rather than reported: `mcp_servers` says only whether a server
 * connected, and `tools` is the flat list the turn ended up with. Read apart, a server
 * that connects and exposes nothing looks healthy -- which is exactly the failure that
 * hid the IDE's own tools for three phases. Read together, it shows as a zero.
 */
function readMcpServers(value: unknown, tools: string[]): McpServerRow[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: McpServerRow[] = [];
  for (const entry of value) {
    const name = (entry as { name?: unknown } | null)?.name;
    if (typeof name !== "string") continue;
    const status = (entry as { status?: unknown }).status;
    const prefix = `mcp__${name}__`;
    rows.push({
      name,
      status: typeof status === "string" ? status : "unknown",
      tools: tools.filter((tool) => tool.startsWith(prefix)).length,
    });
  }
  return rows;
}

function reduceAssistant(state: TranscriptState, msg: JsonObject): TranscriptState {
  // Content means the reasoning for this step produced something; stop counting.
  let next: TranscriptState = { ...state, thinking: null };

  if (typeof msg.error === "string") {
    next = push(next, (addr, turn) => ({
      kind: "notice",
      addr,
      turn,
      tone: "error",
      text: `assistant error: ${String(msg.error)}`,
    }));
  }

  for (const block of blocksOf(msg)) {
    if (block.type === "text" && block.text?.trim()) {
      const text = block.text;
      next = push(next, (addr, turn) => ({ kind: "text", addr, turn, text }));
    } else if (block.type === "thinking" && block.thinking?.trim()) {
      const text = block.thinking;
      next = push(next, (addr, turn) => ({ kind: "thinking", addr, turn, text }));
    } else if (block.type === "tool_use" && block.id && block.name) {
      const { id, name, input } = block;
      const cls = toolClass(name);
      next = push(next, (addr, turn) => ({
        kind: "tool",
        addr,
        turn,
        id,
        name: shortToolName(name),
        cls,
        operand: operandOf(name, input, next.meta.cwd),
        // Only the class whose diff gets drawn keeps its arguments; see `input` on Row.
        input: cls === "mutate" ? input : undefined,
        status: "running",
      }));
      next.toolIndex.set(id, next.rows.length - 1);
    }
  }
  return next;
}

/**
 * A user message is either a real prompt or the SDK handing back a tool result. Only
 * the second kind is drawn here: a real prompt already rendered when it was submitted.
 */
function reduceUser(state: TranscriptState, msg: JsonObject): TranscriptState {
  let next = state;
  for (const block of blocksOf(msg)) {
    if (block.type !== "tool_result" || !block.tool_use_id) continue;
    const index = next.toolIndex.get(block.tool_use_id);
    if (index === undefined) continue;
    const text = resultText(block.content);
    const failed = block.is_error === true;
    next = replace(next, index, (row) =>
      row.kind === "tool"
        ? {
            ...row,
            status: failed ? "error" : "ok",
            measure: failed ? "err" : formatMeasure(text),
            detail: text || undefined,
            elapsed: undefined,
          }
        : row,
    );
  }
  return next;
}

function reduceResult(state: TranscriptState, msg: JsonObject): TranscriptState {
  return push({ ...state, turnClosed: true, thinking: null }, (addr, turn) => ({
    kind: "turn",
    addr,
    turn,
    reason: typeof msg.subtype === "string" ? msg.subtype : "result",
    durationMs: num(msg.duration_ms),
    costUsd: num(msg.total_cost_usd),
    turns: num(msg.num_turns),
    error: Array.isArray(msg.errors) && msg.errors.length ? String(msg.errors[0]) : undefined,
  }));
}

/** Keeps a long-running tool visibly alive rather than looking hung. */
function reduceProgress(state: TranscriptState, msg: JsonObject): TranscriptState {
  const id = typeof msg.tool_use_id === "string" ? msg.tool_use_id : undefined;
  if (!id) return state;
  const index = state.toolIndex.get(id);
  if (index === undefined) return state;
  const elapsed = num(msg.elapsed_time_seconds);
  return replace(state, index, (row) =>
    row.kind === "tool" && row.status === "running" ? { ...row, elapsed } : row,
  );
}

// --- Helpers -----------------------------------------------------------------

function push(state: TranscriptState, make: (addr: number, turn: number) => Row): TranscriptState {
  const row = make(state.nextAddr, state.turn);
  const next: TranscriptState = {
    ...state,
    rows: [...state.rows, row],
    nextAddr: state.nextAddr + 1,
  };
  if (row.kind === "permission") {
    next.permIndex.set(row.id, next.rows.length - 1);
  }
  return next;
}

function replace(
  state: TranscriptState,
  index: number,
  update: (row: Row) => Row,
): TranscriptState {
  const rows = state.rows.slice();
  rows[index] = update(rows[index]);
  return { ...state, rows };
}

/** `Array.prototype.findLastIndex` needs a newer lib target than this project sets. */
function findLastIndex(rows: Row[], match: (row: Row) => boolean): number {
  for (let i = rows.length - 1; i >= 0; i -= 1) if (match(rows[i])) return i;
  return -1;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** What the turn is doing right now, for the line above the composer. */
export interface Activity {
  /** One or two words. The thing that is happening. */
  verb: string;
  /** What it is happening to, when there is something worth naming. */
  detail?: string;
  /** A live reasoning estimate, while the model is thinking. */
  tokens?: number;
  /**
   * The turn is waiting on the person, not on the machine.
   *
   * Drawn differently, because it is the one state where staring at the indicator will
   * never change it -- a spinner that means "answer me" reads as "still working", and
   * the person waits for something that is waiting for them.
   */
  blocked?: boolean;
}

/**
 * The current activity, or `null` when nothing is running.
 *
 * Derived rather than tracked: every fact here is already in `rows` and `thinking`, and a
 * second copy updated alongside them would be a second thing to get wrong. Reading it back
 * out costs one scan of a list that is short by construction.
 *
 * The order is a priority, not a sequence. A pending approval outranks everything because
 * it is the only state the person can act on; a running tool outranks thinking because a
 * name and an operand say more than a token count.
 */
export function activity(state: TranscriptState): Activity | null {
  if (state.status !== "running") return null;

  const waiting = findLastIndex(
    state.rows,
    (row) =>
      (row.kind === "permission" && row.status === "pending") ||
      (row.kind === "tool" && row.permission?.status === "pending"),
  );
  if (waiting !== -1) {
    const row = state.rows[waiting];
    const tool = row.kind === "permission" ? row.tool : row.kind === "tool" ? row.name : "";
    return { verb: "waiting for you", detail: shortToolName(tool), blocked: true };
  }

  const active = findLastIndex(state.rows, (row) => row.kind === "tool" && row.status === "running");
  if (active !== -1) {
    const row = state.rows[active];
    if (row.kind === "tool") {
      return { verb: shortToolName(row.name), detail: row.operand || undefined };
    }
  }

  if (state.thinking !== null) return { verb: "thinking", tokens: state.thinking };
  return { verb: "working" };
}

/** Token counts, in the compact shape the rest of the listing measures in. */
export function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  const k = value / 1000;
  return k < 10 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
}

/** Four digits, so the address column never changes width. */
export function formatAddr(addr: number): string {
  return addr.toString(10).padStart(4, "0");
}
