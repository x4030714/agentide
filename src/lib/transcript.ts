/** Folds the agent channel into rows. Two SDK shapes mislead: `system` re-discriminates on
 * `subtype`, and a tool *result* arrives as a `user` message with `isSynthetic`. */

import { toolDiff, type DiffHunk } from "./diff";
import type {
  AgentEvent,
  Problem,
  ConversationEntry,
  JsonObject,
  ModelInfo,
  ProviderInfo,
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
  | (BaseRow & {
      kind: "prompt";
      text: string;
      /** What went with it. Kept as labels, not the data: a row holds what to draw, and the
       * base64 of an image has no business living in the transcript for the session. */
      sent?: { kind: "image" | "file"; label: string }[];
    })
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
      /** The call's arguments, kept only for `mutate` — the one class whose input is drawn.
       * Every other tool's would sit unread all session, and a `Task` carries a whole prompt. */
      input?: JsonObject;
      /** Seconds elapsed, while still running. */
      elapsed?: number;
      /** The approval this call waits on. On the row, not beside it: the call and its
       * permission request are one action, and two rows would be two addresses. */
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

/** A server the loader never started because its application is shut. Not one of the SDK's
 * words — it never saw this server — and a constant because `RunControls` tones chips by it. */
export const MCP_CLOSED = "closed";

/** What the agent is doing, for the line above the composer. Derived from the rows: a
 * second piece of state would go stale exactly when a turn ends unexpectedly. */
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

/** The one thing worth saying about a turn in flight. Ordered by what the person can act
 * on: an approval outranks all, and a running tool outranks thinking. */
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
  /** Every external MCP server this turn has, started or held back. Undefined until one
   * arrives; empty means the turn had none. */
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
  /** Row index by `tool_use` id. Mutated in place and outside the immutable state: nothing
   * renders it, so copying per event bought no safety and cost a second quadratic. */
  toolIndex: Map<string, number>;
  /** Row index by host permission-request id. Same reasoning as `toolIndex`. */
  permIndex: Map<string, number>;
  nextAddr: number;
  turn: number;
  /** Whether a `result` already closed this turn. Both it and `done` mark the end, and
   * `result` wins: it is the one carrying duration, cost and turn count. */
  turnClosed: boolean;
  /** Live reasoning estimate while the model thinks. A real measurement, not a spinner —
   * and not a row, because a transient state must not consume an address. */
  thinking: number | null;
  /** The answer as it arrives. A preview only — the real message still makes the row, so a
   * dropped or malformed delta costs a blank pane and never a wrong transcript. */
  streaming: string | null;
  /** When the running turn began, for the elapsed clock. Wall clock, not a tick count: a
   * counter in the reducer would reset on every row, which on a busy turn is constantly. */
  turnStartedAt: number;
  /** What this install is missing, from the sidecar's startup check. A blocked problem means
   * no turn can run, so the composer says so instead of letting one fail. */
  problems: Problem[];
  /**
   * What this conversation has cost, in USD.
   *
   * Not a sum of the turn rows. `total_cost_usd` is documented as *cumulative* for a
   * streaming-input session -- every result carries the running total, so adding them up
   * counts the first turn once per turn after it. It is only cumulative per `query()`
   * though, and agentide rebuilds the query whenever a startup-only option changes: a new
   * model, a different backend, a switched account. So the running figure restarts, and the
   * one before it still has to be paid for.
   *
   * `banked` is the total of the queries that have ended; `reported` is the live one's
   * latest figure. A figure lower than the last is how a rebuild is detected -- there is no
   * event for it here, and the count only ever goes up within one query.
   */
  cost: { banked: number; reported: number };
  /** How much of the window the conversation occupies, after the last turn. Null until a
   * turn has finished; the sidecar cannot measure an empty query. */
  context: { tokens: number; max: number } | null;

  /** The SDK's model catalogue, empty until a turn publishes it. Empty means "not known
   * yet", never "none available" — and must not gate sending. */
  models: ModelInfo[];
  /**
   * The backends `providers.json` names. Unlike `models` these arrive at startup, so an
   * empty list here really does mean "none configured" rather than "not known yet".
   */
  providers: ProviderInfo[];
  /** The two halves the MCP strip is built from, unmerged. `started` stays undefined until
   * an init arrives, which is what keeps `meta.mcpServers` undefined. */
  mcp: { started?: McpServerRow[]; gated: McpServerRow[] };
}

/** A prompt the person submitted. Not on the wire — the UI raises it locally. */
export type TranscriptAction =
  | { t: "prompt_submitted"; text: string; sent?: { kind: "image" | "file"; label: string }[] }
  /** Start a new conversation in the same sidecar. What the conversation accumulated goes;
   * what describes the installation stays, because the sidecar did not restart. */
  /** A line the UI says for itself, with no event behind it. A row rather than a toast:
   * scrolling back to a turn should still show that it had no checkpoint. */
  | { t: "local_notice"; tone: NoticeTone; text: string }
  | { t: "conversation_reset" }
  /** Replay a conversation this session will continue. Resuming used to be invisible — the
   * model knew the history and the person did not. A notice marks where the replay ends. */
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
    streaming: null,
    problems: [],
    cost: { banked: 0, reported: 0 },
    context: null,
    turnStartedAt: 0,
    models: [],
    providers: [],
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

/** The one argument worth the operand column. Falls back to the first string in the input:
 * an unknown tool with no operand is a row you cannot act on. */
/** The file an assistant message is about to change. Read off the message, not the rows;
 * only `mutate` tools, and never inside the vault, where a note is an ordinary `Write`. */
export function editedFile(msg: JsonObject, vault?: string, root?: string | null): string | null {
  return editedChange(msg, vault, root)?.path ?? null;
}

/** A file the agent just changed, and the change itself. */
export interface AgentEdit {
  path: string;
  /** The hunks, still unplaced -- each carries the `anchor` that finds it in the new file.
   * Empty when the tool's input did not describe a diff we can draw. */
  hunks: DiffHunk[];
}

/**
 * The edit in an assistant message, with its diff.
 *
 * Read from the tool's *input*, like every other diff here: `Edit` answers in prose, and the
 * input is drawable before the write has even landed. A vault write returns null -- the
 * agent's own memory is not a change to this workspace and must not steal the editor.
 */
export function editedChange(
  msg: JsonObject,
  vault?: string,
  root?: string | null,
): AgentEdit | null {
  if (msg.type !== "assistant") return null;
  for (const block of blocksOf(msg)) {
    if (block.type !== "tool_use" || !block.name) continue;
    if (toolClass(block.name) !== "mutate") continue;
    const input = block.input as JsonObject | undefined;
    for (const key of ["file_path", "notebook_path", "path"]) {
      const value = input?.[key];
      if (typeof value !== "string" || value === "") continue;
      /**
       * Resolved against the workspace, because the model writes `sample.txt` at least as
       * often as it writes the full path -- and everything downstream matches paths by
       * string. Left relative, the tab, the file the editor loaded, and the watcher's events
       * were three spellings of one file: the tab opened, and then nothing about it ever
       * matched again. The edit ribbon never drew once for exactly this reason.
       */
      const raw = wirePath(value);
      const path = isAbsolutePath(raw) && root ? raw : root ? `${wirePath(root).replace(/\/$/, "")}/${raw}` : raw;
      if (inside(path, vault)) return null;
      return { path, hunks: toolDiff(block.name, input)?.hunks ?? [] };
    }
  }
  return null;
}

/** Is `path` under `dir`? Case-insensitive: the model types whatever spelling it inferred,
 * and `c:\users\...` against a normalized `C:/Users/...` would compare as a different tree. */
function inside(path: string, dir: string | undefined): boolean {
  if (!dir) return false;
  const base = dir.replace(/\/$/, "").toLowerCase();
  return path.toLowerCase().startsWith(`${base}/`);
}

/** A path spelled the way the rest of this app spells one. Everything matches by string, so
 * two spellings mean the file opens in the editor and then never refreshes. */
/**
 * Whether a path stands on its own, or needs a workspace to mean anything.
 *
 * `C:/x`, `//server/share` and `/x` are absolute; `sample.txt` and `src/main.rs` are not.
 * The model writes whichever it feels like, and usually the short one.
 */
function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:\//.test(path) || path.startsWith("//") || path.startsWith("/");
}

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
        (addr, turn) => ({
          kind: "prompt",
          addr,
          turn,
          text: action.text,
          ...(action.sent && action.sent.length > 0 ? { sent: action.sent } : {}),
        }),
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
        providers: state.providers,
        commands: state.commands,
        meta: { ...fresh.meta, pid: state.meta.pid, sdkVersion: state.meta.sdkVersion },
      };
    }

    case "conversation_loaded": {
      // Reset first: a replay starts a different conversation, and leaving the previous one
      // above it puts two histories in one column with nothing marking the seam.
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

    case "providers":
      return { ...state, providers: action.providers };

    case "commands":
      return { ...state, commands: action.commands };

    case "readiness":
      // Not a row. It describes the machine rather than the conversation, and a row would
      // scroll away exactly when someone needs it -- before their first prompt.
      return { ...state, problems: action.problems };

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

    case "context":
      return { ...state, context: { tokens: action.tokens, max: action.max } };

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
        return { ...state, status: "ready", thinking: null, streaming: null };
      }
      return push(
        { ...state, status: "ready", turnClosed: true, thinking: null, streaming: null },
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
      return push({ ...state, rows, status: "exited", thinking: null, streaming: null }, (addr, turn) => ({
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
  if (type === "stream_event") return reduceStream(state, msg);
  // The two dozen remaining variants carry nothing this surface draws. Dropping them is
  // deliberate: an unknown variant must never become a row.
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
      // Notes pulled in before the model saw the prompt. Unsaid, that looks like the model
      // guessing — or, on a wrong note, like it being wrong for no reason.
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
    case "agentide_note": {
      // Ours, not the SDK's -- the sidecar's hooks speak through this. Delegation is the
      // only thing that uses it: four subagents can work for a minute and nothing else in
      // the stream says so.
      const text = typeof msg.text === "string" ? msg.text : "";
      if (text === "") return state;
      return push(state, (addr, turn) => ({ kind: "notice", addr, turn, tone: "info", text }));
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

/** What a `memory_recall` surfaced, as short names. A `path` is a file, a `<synthesis:DIR>`
 * sentinel, or an https URL; each gets the shortest thing that still identifies it. */
function recalled(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const memory of value) {
    const path = (memory as { path?: unknown } | null)?.path;
    if (typeof path !== "string" || path === "") continue;
    // `filter(Boolean)` so a URL with a trailing slash names its last segment rather than
    // nothing — an entry contributing no name makes the row understate what was recalled.
    const name = path.startsWith("<synthesis:")
      ? "a synthesis"
      : (path.split(/[\\/]/).filter(Boolean).pop() ?? path);
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Rebuild `meta.mcpServers` from both halves. Two messages describe this strip and nothing
 * orders them, so each is stored as it lands and whichever arrives second cannot erase it. */
function mergeMcp(state: TranscriptState, mcp: TranscriptState["mcp"]): TranscriptState {
  const merged =
    mcp.started === undefined && mcp.gated.length === 0
      ? undefined
      : [...(mcp.started ?? []), ...mcp.gated];
  return { ...state, mcp, meta: { ...state.meta, mcpServers: merged } };
}

/** The init message's MCP servers, each with the tools it contributed. The count is derived,
 * because a server that connects and exposes nothing looks healthy until you count. */
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

/** The answer, a few characters at a time. Text deltas only — a half-parsed tool argument is
 * worse than a pause. A new block resets rather than appends; they are separate paragraphs. */
function reduceStream(state: TranscriptState, msg: JsonObject): TranscriptState {
  const event = msg.event as { type?: string; delta?: { type?: string; text?: string }; content_block?: { type?: string } } | undefined;
  if (!event) return state;
  if (event.type === "content_block_start") {
    return event.content_block?.type === "text" ? { ...state, streaming: "" } : state;
  }
  if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
    const text = event.delta.text ?? "";
    return text ? { ...state, streaming: (state.streaming ?? "") + text } : state;
  }
  return state;
}

function reduceAssistant(state: TranscriptState, msg: JsonObject): TranscriptState {
  // Content means the reasoning for this step produced something; stop counting.
  // The message that was being previewed has arrived; the preview is now the row.
  let next: TranscriptState = { ...state, thinking: null, streaming: null };

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
  const reported = num(msg.total_cost_usd) ?? 0;
  // A drop means this result came from a query that started counting again.
  const cost =
    reported < state.cost.reported
      ? { banked: state.cost.banked + state.cost.reported, reported }
      : { ...state.cost, reported };

  return push({ ...state, cost, turnClosed: true, thinking: null, streaming: null }, (addr, turn) => ({
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
  /** The turn is waiting on the person, not the machine. Drawn differently: a spinner that
   * means "answer me" reads as "still working", and both sides then wait. */
  blocked?: boolean;
}

/** The current activity, or `null`. Derived rather than tracked, so there is no second copy
 * to get wrong. The order is a priority: an approval outranks a tool outranks thinking. */
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
/** What the conversation has cost so far. See `TranscriptState.cost` for why it is not a sum
 * of the turn rows. */
export function sessionCost(state: TranscriptState): number {
  return state.cost.banked + state.cost.reported;
}

export function formatAddr(addr: number): string {
  return addr.toString(10).padStart(4, "0");
}
