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

import type { AgentEvent, JsonObject, ModelInfo } from "./protocol";

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

export interface TranscriptMeta {
  pid?: number;
  sdkVersion?: string;
  model?: string;
  cwd?: string;
  toolCount?: number;
  permissionMode?: string;
}

export type TranscriptStatus = "idle" | "starting" | "ready" | "running" | "exited";

export interface TranscriptState {
  rows: Row[];
  status: TranscriptStatus;
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
   * The SDK's own model catalogue, empty until the first turn publishes it. Empty means
   * "not known yet", never "none available" -- the UI must say so rather than showing an
   * empty picker, and must not gate sending on it.
   */
  models: ModelInfo[];
}

/** A prompt the person submitted. Not on the wire — the UI raises it locally. */
export type TranscriptAction = { t: "prompt_submitted"; text: string } | AgentEvent;

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
    models: [],
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
        { ...state, status: "running", turn: state.turn + 1, turnClosed: false, thinking: null },
        (addr, turn) => ({ kind: "prompt", addr, turn, text: action.text }),
      );

    case "models":
      return { ...state, models: action.models };

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
      const tools = Array.isArray(msg.tools) ? msg.tools.length : undefined;
      return {
        ...state,
        meta: {
          ...state.meta,
          model: typeof msg.model === "string" ? msg.model : undefined,
          cwd: typeof msg.cwd === "string" ? msg.cwd : undefined,
          toolCount: tools,
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
      next = push(next, (addr, turn) => ({
        kind: "tool",
        addr,
        turn,
        id,
        name: shortToolName(name),
        cls: toolClass(name),
        operand: operandOf(name, input, next.meta.cwd),
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
