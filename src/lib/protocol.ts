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
  | "agent"
  /** A window operation the runtime refused; in practice only during shutdown. */
  | "window"
  /** A checkpoint operation the shadow repository refused. */
  | "checkpoint"
  /**
   * A hunk no longer matches the file it was computed from. Always a refusal to act,
   * never a partial apply: a stale hunk applied blind corrupts the file.
   */
  | "stale"
  /** A terminal session that cannot be started, or is no longer running. */
  | "pty"
  /**
   * A language server that cannot be started, or is no longer running. A server that is
   * not installed comes back as `"notFound"` instead, so the two are distinguishable.
   */
  | "lsp"
  /**
   * The user's own repository refused an operation. The message is git's own -- a hook
   * that rejects a commit has already explained itself better than this app could.
   */
  | "git";

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
 * Only the characters that would break URI parsing are escaped. The drive colon is left
 * alone deliberately, and it costs nothing: Monaco normalises `file:///C:/a/b.rs` and
 * `file:///c%3A/a/b.rs` to the same URI, so both find the same model. Verified against
 * Monaco's own `URI` in `lsp-session.test.ts`, which is also where the inverse
 * (`uriToPath`) is pinned to this.
 *
 * This is the app's only path-to-URI function, and adding a second one is the mistake
 * this comment exists to prevent -- see the note on `uriToPath`.
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
 * How much reasoning the model spends on a turn.
 *
 * Not every model accepts every level: offer the ones in the selected model's
 * `ModelInfo.supportedEffortLevels`, and no picker at all when `supportsEffort` is not
 * true. A level a model does not take is quietly downgraded rather than refused.
 */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Per-turn agent configuration. Sent with each prompt rather than at startup, so a mode
 * change takes effect on the next turn without restarting the sidecar.
 */
export interface PromptOptions {
  /** Defaults to `claude-opus-5` in the sidecar. */
  model?: string;
  /** Omitted means the agent SDK's own default, not one this protocol invents. */
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  /** Tools auto-approved without producing a `permission_request`. */
  allowedTools?: string[];
  /** Tools denied outright. A bare name removes the tool from the model's context. */
  disallowedTools?: string[];
  maxTurns?: number;
  /**
   * Appended to Claude Code's preset system prompt, never replacing it. Omitted means
   * the bare preset — which is exactly what the "Default" prompt mode sends.
   */
  systemPromptAppend?: string;
  /**
   * Emit `stream_event` messages so the transcript can render text as it arrives. Off by
   * default: it multiplies event volume, and a transcript that renders only complete
   * assistant messages should not pay for it.
   */
  includePartialMessages?: boolean;
  /**
   * Continue a past conversation by its transcript id, rather than this session's own.
   * Sent per prompt, because picking one is something the user does mid-session.
   */
  resumeConversation?: string;
}

export type PermissionDecision = "allow" | "deny";

/**
 * One model this installation can run, as the agent SDK reports it. Arrives in a
 * `models` event; the list is not hardcoded anywhere.
 */
export interface ModelInfo {
  /** The id to send back as `PromptOptions.model`. */
  value: string;
  /** The canonical id `value` resolves to, when `value` is an alias such as `sonnet`. */
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  /** The levels this model accepts. Absent means the SDK did not say. */
  supportedEffortLevels?: EffortLevel[];
}

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
  /**
   * The models this installation can run. Arrives once per sidecar, during the first
   * turn -- the SDK will only report the list through a live query, so there is nothing
   * to show before the first prompt has been sent. Not tied to a session.
   */
  | { t: "models"; models: ModelInfo[] }
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

// ---------------------------------------------------------------------------
// Window chrome
//
// The window is frameless and transparent, so the title bar is the frontend's to draw.
// Mirrored from `src-tauri/src/window.rs`.
// ---------------------------------------------------------------------------

/**
 * Tauri event carrying the new value whenever the main window is maximized or restored
 * -- by our own button, a double click on the drag region, a Win+Arrow snap or a drag to
 * the top of the screen. Subscribe through `onMaximizedChange` rather than by name.
 */
export const MAXIMIZED_EVENT = "window://maximized";

// ---------------------------------------------------------------------------
// Checkpoints
//
// Mirrors the shapes in `src-tauri/src/ipc.rs`. The shadow git repository at
// `.agentide/checkpoints.git` is what makes every agent edit reversible; the user's own
// `.git`, index and history are never read or written.

/** One commit in the shadow repository. */
export interface Checkpoint {
  id: string;
  /** First seven characters, for display. Commands take the full id. */
  shortId: string;
  createdMs: number;
  label: string;
  /** `null` only for a workspace's first checkpoint. */
  parent: string | null;
  filesChanged: number;
  added: number;
  removed: number;
}

export type FileChange = "added" | "modified" | "deleted";

/**
 * Why a file's text is absent from a diff. The row still renders — only the content is
 * withheld, so the queue never silently drops a change it cannot display.
 */
export type Omitted = "binary" | "tooLarge" | "budget" | "notUtf8";

/** One changed file, with both sides where they can be shown. */
export interface DiffFile {
  path: WirePath;
  /** Workspace-relative, forward-slashed. */
  relative: string;
  status: FileChange;
  added: number;
  removed: number;
  binary: boolean;
  /** Text at the checkpoint. Absent for an added file, or when `omitted` is set. */
  before: string | null;
  /** Text now. Absent for a deleted file, or when `omitted` is set. */
  after: string | null;
  omitted: Omitted | null;
}

export interface CheckpointDiff {
  from: string;
  /** `null` means "against the working tree as it is now". */
  to: string | null;
  files: DiffFile[];
}

/**
 * One hunk of a file's patch.
 *
 * `id` is content-derived, not positional, and is recomputed from the file as it stands
 * each time hunks are requested. An id that no longer matches anything is stale, and
 * reverting it fails with `ErrorCode` `"stale"` rather than applying somewhere else.
 */
export interface Hunk {
  id: string;
  /** The `@@ … @@` line, for display. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  added: number;
  removed: number;
}

export interface FileHunks {
  path: WirePath;
  relative: string;
  /** Binary files have no hunks; the whole file is the unit. */
  binary: boolean;
  hunks: Hunk[];
}

export type RevertAction = "restored" | "deleted" | "unchanged";

export interface RevertOutcome {
  path: WirePath;
  action: RevertAction;
  /** Hunks reverted; 0 for a whole-file revert. */
  hunks: number;
}

/**
 * The result of rewinding the work tree to a checkpoint.
 *
 * `safety` is taken *before* the rewind, so the rewind is itself undoable — this is the
 * one operation that can remove work.
 */
export interface RewindResult {
  safety: Checkpoint;
  /** Taken after, so the timeline records the rewind rather than hiding it. */
  checkpoint: Checkpoint;
  restored: WirePath[];
  /** Created since the checkpoint and removed by the rewind. */
  deleted: WirePath[];
  /** Created since the checkpoint and deliberately left alone. */
  kept: WirePath[];
}

// ---------------------------------------------------------------------------
// Terminal
//
// Mirrors `src-tauri/src/ipc.rs`; the mechanism is in `src-tauri/src/pty.rs`.
//
// A pty session's channel carries two shapes. Output is *bytes* — an `ArrayBuffer`,
// never a string, because a read boundary lands mid-UTF-8-character often enough that
// decoding a chunk on its own visibly corrupts it. Hand it to xterm.js as a `Uint8Array`
// and its decoder carries the split character into the next chunk. Everything else is a
// `PtyEvent` object. `ptySpawn` in `bridge.ts` splits the two, so nothing above it has
// to know they share a channel.
//
// Scrollback is the terminal's: the Rust side keeps no history and cannot replay a
// session, so a terminal that is unmounted and remounted starts blank unless the
// frontend kept the buffer.
// ---------------------------------------------------------------------------

export interface PtySpawnOptions {
  /**
   * This frontend's handle for the session — a tab id. Spawning onto an id that is
   * already running replaces it, killing the process that was there.
   */
  id: string;
  /** Defaults to the open workspace, then to the home directory. */
  cwd?: WirePath;
  /**
   * argv, where `command[0]` is the program. Omitted means an interactive shell:
   * PowerShell 7 if it is installed, else Windows PowerShell, else `cmd.exe`, and
   * `$SHELL` elsewhere. `AGENTIDE_SHELL` in the environment overrides all of it.
   */
  command?: string[];
  /** Defaults to 24x80. Send the real size with `ptyResize` once the pane is measured. */
  rows?: number;
  cols?: number;
}

/** A session that is running, as `ptySpawn` reports it. */
export interface PtyInfo {
  id: string;
  /** What was actually started: the resolved shell, unless a command was given. */
  program: string;
  cwd: WirePath;
  pid: number | null;
  rows: number;
  cols: number;
}

/**
 * The object half of a pty channel; the other half is raw output.
 *
 * `exited` is the last thing a session sends, and it arrives after the last of its
 * output. The session is gone with it: `ptyWrite` and `ptyResize` on that id then reject
 * with a `"pty"` error rather than swallowing what is typed.
 */
export type PtyEvent = {
  t: "exited";
  id: string;
  /** Null only when the platform would not report a code. */
  code: number | null;
  /** The signal that ended it, on platforms that have them. */
  signal: string | null;
  message: string;
};

// ---------------------------------------------------------------------------
// Language servers
//
// Mirrors `src-tauri/src/ipc.rs`; the mechanism is in `src-tauri/src/lsp.rs`.
//
// The Rust side is a pipe with a process attached. It spawns the server, does the
// `Content-Length` framing on stdio in both directions, and reports the process dying.
// It does not model LSP: no request table, no id correlation, no capability handling, no
// `initialize`. **This side is the LSP client** — every bit of protocol semantics lives
// here, next to the Monaco providers that consume it.
//
// A message crosses as the server's own bytes, spliced verbatim into the channel payload
// rather than re-serialized, so what arrives is already a parsed object: read `id` and
// `method` off it directly, do not `JSON.parse` it again. What goes down is likewise the
// object, not a string of it.
// ---------------------------------------------------------------------------

/**
 * One JSON-RPC message, as the wire carries it. Deliberately untyped: this file mirrors
 * the Rust boundary, and LSP's own shapes belong to the client that speaks them.
 */
export type LspMessage = JsonObject;

export interface LspStartOptions {
  /**
   * This frontend's handle for the server — in practice one per language per workspace.
   * Starting onto an id that is already running replaces it, killing the process that was
   * there; the old one reports `exited` on its own channel.
   */
  id: string;
  /**
   * argv, where `command[0]` is the program, resolved against `PATH`. There is no table
   * of known servers in Rust: which server serves which language is decided here.
   */
  command: string[];
  /**
   * Where the server is started, and what you should name as the workspace folder in
   * `initialize`. Defaults to the open workspace.
   */
  root?: WirePath;
}

/** A server that is running, as `lspStart` reports it. */
export interface LspInfo {
  id: string;
  program: string;
  root: WirePath;
  pid: number | null;
}

/**
 * What arrives on a language server's channel.
 *
 * Ordering holds within a variant, not across them: `messages` arrive in the order the
 * server wrote them and `stderr` likewise, but they come from separate pipes with
 * separate OS buffers, so nothing can claim an order between the two. `exited` is the
 * last thing a server sends.
 */
export type LspEvent =
  /**
   * Protocol messages, oldest first. **Batched** — rust-analyzer emits `$/progress` by
   * the hundred per second while it indexes, and one channel message each would melt the
   * webview. An array preserves boundaries and order exactly, so correlating replies by
   * id is unaffected; just loop rather than assuming one message.
   */
  | { t: "messages"; id: string; messages: LspMessage[] }
  /**
   * The server talking about itself: its stderr, plus anything it wrote to stdout that
   * was not a well-formed message. This is where clangd says it cannot find a
   * `compile_commands.json` and rust-analyzer says the toolchain is wrong — a server that
   * starts and then silently does nothing is explaining itself here.
   */
  | { t: "stderr"; id: string; lines: string[] }
  /**
   * The process is gone and the session with it: `lspSend` on this id now rejects.
   *
   * This is the *only* signal that a server has died, and the only one worth acting on.
   * Nothing in Rust times a request out, because a request that is slow and a server that
   * is dead look identical from there — rust-analyzer can take minutes to become useful
   * on a large workspace and is perfectly healthy the whole time. So: keep waiting while
   * nothing arrives, and fail every outstanding request the moment this does.
   *
   * Sent on a deliberate `lspStop` and on a replacement too, so one handler covers all
   * three. `message` carries the tail of stderr when there was any.
   */
  | { t: "exited"; id: string; code: number | null; message: string };

// ---------------------------------------------------------------------------
// The user's own git repository -- mirrors `src-tauri/src/git.rs`
//
// Distinct from the checkpoint types above, which describe the private shadow
// repository. These describe the real one, the one with the user's history in it.
// ---------------------------------------------------------------------------

/** What a file's presence in the status list means. */
export type GitState =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "typeChanged"
  | "untracked"
  /** A merge conflict. Not stageable from the panel -- resolving it is an edit. */
  | "conflicted";

/**
 * One row in the panel.
 *
 * A file appears twice when it is staged and then edited again, because git tracks the
 * index and the working tree separately and that is a real state. `staged` is what
 * distinguishes the two rows, and what decides which way the stage button points.
 */
export interface GitFile {
  path: WirePath;
  /** Repository-relative: what the user reads, and what git commands take. */
  rel: string;
  staged: boolean;
  state: GitState;
  /** Where a rename or copy came from. */
  from: string | null;
}

/** `isRepo: false` is a normal answer -- plenty of folders worth opening are not repos. */
export interface GitStatus {
  isRepo: boolean;
  root: WirePath | null;
  /** `null` on a detached HEAD or an unborn branch. */
  branch: string | null;
  /** Short HEAD sha, or `null` before the first commit. */
  head: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  upstream: string | null;
  subject: string;
}

/** The two sides of one file's diff, for Monaco's diff editor. */
export interface GitFileDiff {
  path: WirePath;
  rel: string;
  /** `null` when the file did not exist on that side, or when it is binary. */
  before: string | null;
  after: string | null;
  binary: boolean;
}

export interface GitCommitResult {
  sha: string;
  subject: string;
}

// ---------------------------------------------------------------------------
// Past conversations -- mirrors `src-tauri/src/conversations.rs`
// ---------------------------------------------------------------------------

/** One past conversation, as much as is known without opening it. */
export interface ConversationSummary {
  /** The SDK's session id: the filename, and the handle for resuming. */
  id: string;
  /** The SDK's own generated title, when it made one. */
  title: string | null;
  /** The first thing the user said, which is the title when there is no title. */
  opening: string | null;
  startedMs: number | null;
  updatedMs: number | null;
  prompts: number;
  replies: number;
  branch: string | null;
}

/** One message from a past conversation, flattened for display. */
export interface ConversationEntry {
  role: "user" | "assistant";
  text: string;
  atMs: number | null;
  /** Tools this message called, so a reply that only used tools is not blank. */
  tools: string[];
}
