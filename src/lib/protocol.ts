/**
 * Mirror of `src-tauri/src/ipc.rs`. Change one and change the other.
 *
 * Nothing here talks to Tauri; that is `bridge.ts`. This file is types plus the few
 * pure helpers that operate on a `WirePath`.
 */

/**
 * A path as the Rust core hands it out: absolute, `/`-separated, no `\\?\` prefix,
 * upper-case drive letter, no trailing slash (except a bare root like `C:/`).
 *
 * Never build one by concatenating user input -- pass the raw string to a command and
 * let `ipc.rs` normalize it.
 */
export type WirePath = string;

export type ErrorCode =
  | "invalidPath"
  | "notFound"
  | "permissionDenied"
  | "notUtf8"
  | "tooLarge"
  | "isDirectory"
  | "io"
  | "watch"
  /** The agent sidecar is not running, cannot be started, or cannot be reached. */
  | "agent";

export interface IpcError {
  code: ErrorCode;
  message: string;
}

export interface DirEntry {
  name: string;
  path: WirePath;
  isDir: boolean;
  /** Bytes; always 0 for directories. */
  size: number;
  /** Unix epoch milliseconds, or null when the platform will not say. */
  modifiedMs: number | null;
}

export interface DirListing {
  path: WirePath;
  entries: DirEntry[];
}

export interface FileContents {
  path: WirePath;
  /** UTF-8 text with any byte-order mark removed. */
  text: string;
  size: number;
  modifiedMs: number | null;
  /** Pass back to `writeFile` so saving does not strip the file's BOM. */
  hadBom: boolean;
}

export interface FileStat {
  path: WirePath;
  size: number;
  modifiedMs: number | null;
}

export interface Workspace {
  root: WirePath;
  name: string;
}

export type FsChangeKind = "created" | "modified" | "removed";

export interface FsEvent {
  kind: FsChangeKind;
  path: WirePath;
}

/** Tauri rejects with the serialized `IpcError`, not with an `Error`. */
export function isIpcError(value: unknown): value is IpcError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as IpcError).code === "string" &&
    typeof (value as IpcError).message === "string"
  );
}

export function errorMessage(value: unknown): string {
  if (isIpcError(value)) return value.message;
  if (value instanceof Error) return value.message;
  return String(value);
}

/** `/`, `C:/` or `//server/share` -- a path with no parent. */
export function isRoot(path: WirePath): boolean {
  return path === "/" || /^[A-Za-z]:\/$/.test(path) || /^\/\/[^/]+\/[^/]+$/.test(path);
}

/** The containing directory, or null for a root. */
export function parentOf(path: WirePath): WirePath | null {
  if (isRoot(path)) return null;
  const cut = path.lastIndexOf("/");
  if (cut < 0) return null;
  const parent = path.slice(0, cut);
  if (parent === "") return "/";
  // `C:/foo` -> `C:` is not a root; `C:/` is.
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent;
}

export function baseName(path: WirePath): string {
  const cut = path.lastIndexOf("/");
  const name = cut < 0 ? path : path.slice(cut + 1);
  return name === "" ? path : name;
}

/**
 * The `file://` URI form Monaco wants for a model. Kept next to the path helpers
 * because it is the third shape of the same path, and Phase 4's LSP client needs it too.
 *
 * Only the characters that would break URI parsing are escaped -- percent-encoding the
 * drive colon would produce a URI Monaco cannot turn back into a path.
 */
export function toFileUri(path: WirePath): string {
  const encoded = path.replace(
    /[#?%]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  // A UNC path is already rooted at `//server/share`.
  return encoded.startsWith("//") ? `file:${encoded}` : `file:///${encoded}`;
}

// ---------------------------------------------------------------------------
// Agent
//
// The stdio wire between the Rust core and the agent sidecar is defined once, in
// `sidecar/src/protocol.ts`. These are the parts of it the frontend also sees, mirrored
// from `src-tauri/src/ipc.rs`. Both mirrors are checked against
// `sidecar/protocol-fixtures.json` by tests on each side.
// ---------------------------------------------------------------------------

/** A JSON object carried through uninterpreted: tool arguments, tool inputs. */
export type JsonObject = Record<string, unknown>;

/** How the agent SDK resolves a tool call that is not pre-approved. */
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

/**
 * Per-turn agent configuration. Sent with each prompt rather than at startup, so a mode
 * change takes effect on the next turn without restarting the sidecar.
 */
export interface PromptOptions {
  /** Defaults to `claude-opus-5` in the sidecar. */
  model?: string;
  permissionMode?: PermissionMode;
  /** Tools auto-approved without producing a `permission_request`. */
  allowedTools?: string[];
  /** Tools denied outright. A bare name removes the tool from the model's context. */
  disallowedTools?: string[];
  maxTurns?: number;
  /**
   * Emit `stream_event` messages so the transcript can render text as it arrives. Off by
   * default: it multiplies event volume, and a transcript that renders only complete
   * assistant messages should not pay for it.
   */
  includePartialMessages?: boolean;
}

export type PermissionDecision = "allow" | "deny";

/** Why a turn ended. `interrupted` means the host asked, not that the model stopped. */
export type DoneReason = "success" | "interrupted" | "max_turns" | "error";

/**
 * The answer to an `ide_*` tool call. `ok` decides which of the other two fields is
 * present; build one with `toolOk` or `toolError` rather than by hand.
 */
export interface ToolResult {
  ok: boolean;
  text?: string;
  error?: string;
}

export function toolOk(text: string): ToolResult {
  return { ok: true, text };
}

export function toolError(error: string): ToolResult {
  return { ok: false, error };
}

/**
 * Who answered a permission request or a tool call. `host` means the Rust core answered
 * on our behalf, which is what happens for every tool whose backend is not built yet --
 * worth rendering differently from a decision the user actually made.
 */
export type ReplySource = "ui" | "host";

/**
 * What arrives on the agent channel.
 *
 * Ordering: one Rust thread writes this channel in the order the sidecar produced the
 * messages, so a `tool_call` always precedes its `tool_result`, and a session's `done`
 * always follows every `event` of that turn. Nothing is reordered and nothing is dropped.
 * `ready` is always first; `exited` is always last.
 */
export type AgentEvent =
  /** The sidecar is listening. Always the first event after `agentStart`. */
  | { t: "ready"; pid: number; sdkVersion: string }
  /**
   * One `SDKMessage` from the agent SDK, verbatim and unvalidated -- the union is large
   * and moves, so the transcript is the only thing that destructures it. Switch on
   * `msg.type`: `assistant`, `user`, `result`, `system`, `stream_event`.
   */
  | { t: "event"; sessionId: string; msg: JsonObject }
  /** A tool call awaiting approval. Answer with `agentPermissionReply`. */
  | {
      t: "permission_request";
      id: string;
      sessionId: string;
      tool: string;
      input: JsonObject;
    }
  /** The answer that went back to the sidecar, whoever produced it. */
  | {
      t: "permission_decided";
      id: string;
      sessionId: string;
      decision: PermissionDecision;
      source: ReplySource;
    }
  /** An IDE tool needing data only we have. Answer with `agentToolReply`. */
  | { t: "tool_call"; id: string; sessionId: string; name: string; args: JsonObject }
  /** The answer that went back to the sidecar, whoever produced it. */
  | {
      t: "tool_result";
      id: string;
      sessionId: string;
      result: ToolResult;
      source: ReplySource;
    }
  /** The turn ended. `error` carries detail when `reason` is `error`. */
  | { t: "done"; sessionId: string; reason: DoneReason; error?: string }
  /**
   * The sidecar is gone -- cleanly, or because it died. `pending` names the requests
   * that will never be answered, so the transcript can fail exactly those rows instead
   * of leaving them spinning. No further events arrive until `agentStart` runs again.
   */
  | { t: "exited"; code: number | null; message: string; pending: string[] };

/** What the frontend tells the Rust core it can answer for itself. */
export interface AgentStartOptions {
  /**
   * Names of `ide_*` tools this frontend will answer with `agentToolReply`. Anything not
   * named here the Rust core answers immediately with "not available in this build", so
   * an unbuilt tool costs the model one tool error rather than a stalled turn.
   */
  hostTools?: string[];
  /**
   * This frontend will answer `permission_request` with `agentPermissionReply`. Leave it
   * false until there is an approval UI: the Rust core then denies every prompt at once
   * with an explanation, rather than leaving the agent waiting on nobody.
   */
  hostPermissions?: boolean;
}
