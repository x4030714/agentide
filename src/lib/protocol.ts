/** Mirror of `src-tauri/src/ipc.rs`. Change one and change the other. Nothing here talks to Tauri
 * — that is `bridge.ts`; this is types plus the few pure helpers over a `WirePath`. */

/** A path as the Rust core hands it out: absolute, `/`-separated, no `\\?\` prefix, upper-case
 * drive, no trailing slash. Never build one — pass the raw string and let `ipc.rs` normalize it. */
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
  /** A hunk no longer matches the file it was computed from. Always a refusal, never a partial
   * apply: a stale hunk applied blind corrupts the file. */
  | "stale"
  /** A terminal session that cannot be started, or is no longer running. */
  | "pty"
  /** A language server that cannot be started, or is no longer running. Not installed comes back
   * as `"notFound"` instead, so the two are distinguishable. */
  | "lsp"
  /** The user's own repository refused an operation. The message is git's own — a hook that
   * rejects a commit has already explained itself better than this app could. */
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

/** The app's only path-to-URI function — a second one is the mistake this prevents; see
 * `uriToPath`. The drive colon stays unescaped: Monaco normalises both spellings alike. */
export function toFileUri(path: WirePath): string {
  const encoded = path.replace(
    /[#?%]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  // A UNC path is already rooted at `//server/share`.
  return encoded.startsWith("//") ? `file:${encoded}` : `file:///${encoded}`;
}

/** One thing this install is missing, and what to do about it. Mirrors `Problem` in
 * `sidecar/src/doctor.ts`: `blocked` means no turn can run, `degraded` means a feature is
 * absent but the agent still works. */
export interface Problem {
  severity: "blocked" | "degraded";
  title: string;
  fix: string;
}

// --- Agent -------------------------------------------------------------------
// Defined once in `sidecar/src/protocol.ts`; both mirrors are checked against
// `sidecar/protocol-fixtures.json`.

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

/** How much reasoning the model spends on a turn. Offer only the selected model's
 * `supportedEffortLevels`; a level a model does not take is quietly downgraded, not refused. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/** Per-turn agent configuration. Sent with each prompt rather than at startup, so a mode change
 * takes effect on the next turn without restarting the sidecar. */
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
  /** Appended to Claude Code's preset system prompt, never replacing it. Omitted means the bare
   * preset, which is what the "Default" prompt mode sends. */
  systemPromptAppend?: string;
  /** Emit `stream_event` messages so text renders as it arrives. Off by default: it multiplies
   * event volume, which a transcript rendering only complete messages should not pay for. */
  includePartialMessages?: boolean;
  /** Continue a past conversation by its transcript id. Sent per prompt, because picking one is
   * something the user does mid-session. */
  resumeConversation?: string;
  /** Which backend runs this turn: a key from `~/.agentide/providers.json`, or omitted for
   * Anthropic's own. Chosen in the same menu as `model`, and set with it. */
  provider?: string;
}

export type PermissionDecision = "allow" | "deny";

/** One slash command this installation accepts. Reported by the SDK, not listed here: they come
 * from the CLI build, `.claude/commands` and any plugin, so a fixed list is wrong everywhere. */
export interface SlashCommand {
  /** Without the leading slash. */
  name: string;
  description: string;
  /** What arguments it takes, e.g. "<file>". Empty when it takes none. */
  argumentHint: string;
  /** Other spellings that resolve to it, e.g. `/cost` for `/usage`. */
  aliases?: string[];
}

/** One external MCP server the sidecar held back because the application it drives is not open.
 * `host` and `port` come with the name so the chip can say what to open. */
export interface GatedServer {
  name: string;
  host: string;
  port: number;
}

/** One model a configured backend offers. */
export interface ProviderModel {
  /** Sent back as `PromptOptions.model`, so exactly what the backend calls it. */
  id: string;
  name: string;
  supportsEffort: boolean;
}

/** A backend from `~/.agentide/providers.json`, as the host may see it. No base URL and no token:
 * those stay in the sidecar, the only process that reads the file's secrets. */
export interface ProviderInfo {
  /** Sent back as `PromptOptions.provider`. */
  key: string;
  models: ProviderModel[];
  /** The command that starts it, when this is a backend agentide launches. */
  start?: string;
  host: string;
  port: number;
  note?: string;
}

/** One model this installation can run, as the SDK reports it. Never hardcoded. */
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

/** The answer to an `ide_*` tool call. `ok` decides which of the other two fields is present;
 * build one with `toolOk` or `toolError` rather than by hand. */
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

/** Who answered a permission request or a tool call. `host` means the Rust core answered on our
 * behalf — what happens for every tool whose backend is not built yet, and worth drawing apart. */
export type ReplySource = "ui" | "host";

/** What arrives on the agent channel. One Rust thread writes it in the sidecar's own order, so a
 * `tool_call` precedes its `tool_result` and `done` follows every `event`; nothing is dropped. */
export type AgentEvent =
  /** The sidecar is listening. Always the first event after `agentStart`. */
  | { t: "ready"; pid: number; sdkVersion: string }
  /** One `SDKMessage`, verbatim and unvalidated — the union is large and moves, so only the
   * transcript destructures it. Switch on `msg.type`. */
  | { t: "event"; sessionId: string; msg: JsonObject }
  /** The models this installation can run. Arrives once per sidecar during the first turn: the SDK
   * only reports the list through a live query. Not tied to a session. */
  | { t: "models"; models: ModelInfo[] }
  /** The backends `~/.agentide/providers.json` names. A file, not a live query, so they arrive at
   * startup and are re-sent each turn. Carries no credential; see `ProviderInfo`. */
  | { t: "providers"; providers: ProviderInfo[] }
  | { t: "commands"; commands: SlashCommand[] }
  | { t: "readiness"; problems: Problem[] }
  /** The external MCP servers this turn was built without, their gate being closed. Sent at the
   * start of every turn, empty list included — the empty list is what clears last turn's chips. */
  | { t: "mcp_gated"; sessionId: string; servers: GatedServer[] }
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
  /** The sidecar is gone, cleanly or not. `pending` names the requests that will never be answered,
   * so the transcript can fail exactly those rows instead of leaving them spinning. */
  | { t: "exited"; code: number | null; message: string; pending: string[] };

/** What the frontend tells the Rust core it can answer for itself. */
export interface AgentStartOptions {
  /** Names of `ide_*` tools this frontend will answer. Anything unnamed the Rust core answers with
   * "not available in this build", so an unbuilt tool costs one tool error, not a stalled turn. */
  hostTools?: string[];
  /** This frontend will answer `permission_request`. Leave it false until there is an approval UI:
   * the core then denies every prompt with an explanation rather than leaving the agent waiting. */
  hostPermissions?: boolean;
}

// --- Window chrome -----------------------------------------------------------
// Frameless and transparent, so the title bar is the frontend's. Mirrors `src-tauri/src/window.rs`.

/** Tauri event carrying the new value whenever the main window is maximized or restored, by any
 * route. Subscribe through `onMaximizedChange` rather than by name. */
export const MAXIMIZED_EVENT = "window://maximized";

// --- Checkpoints -------------------------------------------------------------
// A shadow repo at `.agentide/checkpoints.git` makes agent edits reversible. The user's own
// `.git` is never read or written.

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

/** Why a file's text is absent from a diff. The row still renders — only the content is withheld,
 * so the queue never silently drops a change it cannot display. */
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

/** One hunk of a file's patch. `id` is content-derived and recomputed each request, so an id that
 * matches nothing is stale and reverting it fails with `"stale"` rather than landing elsewhere. */
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

/** The result of rewinding the work tree to a checkpoint. `safety` is taken *before* the rewind,
 * because this is the one operation that can remove work. */
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

// --- Terminal ----------------------------------------------------------------
// Output crosses as *bytes*, never a string: a read boundary lands mid-UTF-8 often enough to
// corrupt it visibly. Scrollback is the terminal's; Rust keeps none and cannot replay.

export interface PtySpawnOptions {
  /** This frontend's handle for the session — a tab id. Spawning onto a running id replaces it,
   * killing the process that was there. */
  id: string;
  /** Defaults to the open workspace, then to the home directory. */
  cwd?: WirePath;
  /** argv, where `command[0]` is the program. Omitted means an interactive shell: PowerShell 7, else
   * Windows PowerShell, else `cmd.exe`, and `$SHELL` elsewhere. `AGENTIDE_SHELL` overrides all. */
  command?: string[];
  /** One command line for the user's own shell to run and then exit. Takes precedence over
   * `command`; which shell it is stays decided in Rust, so the frontend never guesses. */
  shellCommand?: string;
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

/** The object half of a pty channel; the other half is raw output. `exited` is the last thing a
 * session sends, and `ptyWrite`/`ptyResize` then reject rather than swallowing what is typed. */
export type PtyEvent = {
  t: "exited";
  id: string;
  /** Null only when the platform would not report a code. */
  code: number | null;
  /** The signal that ended it, on platforms that have them. */
  signal: string | null;
  message: string;
};

// --- Language servers --------------------------------------------------------
// Rust is a pipe with a process attached; **this side is the client**. What arrives is already
// parsed — read `id` and `method`, do not `JSON.parse` again.

/** One JSON-RPC message, as the wire carries it. Untyped on purpose: this file mirrors the Rust
 * boundary, and LSP's own shapes belong to the client that speaks them. */
export type LspMessage = JsonObject;

export interface LspStartOptions {
  /** This frontend's handle for the server — one per language per workspace. Starting onto a
   * running id replaces it; the old one reports `exited` on its own channel. */
  id: string;
  /** argv, where `command[0]` is resolved against `PATH`. There is no table of known servers in
   * Rust: which server serves which language is decided here. */
  command: string[];
  /** Where the server is started, and what to name as the workspace folder in `initialize`.
   * Defaults to the open workspace. */
  root?: WirePath;
}

/** A server that is running, as `lspStart` reports it. */
export interface LspInfo {
  id: string;
  program: string;
  root: WirePath;
  pid: number | null;
}

/** What arrives on a language server's channel. Ordering holds within a variant, not across:
 * `messages` and `stderr` come from separate pipes. `exited` is the last thing a server sends. */
export type LspEvent =
  /** Protocol messages, oldest first, and **batched** — rust-analyzer emits `$/progress` by the
   * hundred per second while indexing. Order and boundaries are exact; just loop. */
  | { t: "messages"; id: string; messages: LspMessage[] }
  /** The server talking about itself: stderr, plus any stdout that was not a well-formed message.
   * A server that starts and then silently does nothing is explaining itself here. */
  | { t: "stderr"; id: string; lines: string[] }
  /** The process is gone and `lspSend` now rejects. The *only* death signal: nothing times a
   * request out, because rust-analyzer can take minutes while perfectly healthy. */
  | { t: "exited"; id: string; code: number | null; message: string };

// --- The user's own git repository -- mirrors `src-tauri/src/git.rs` ----------
// The real repository, with the user's history in it — not the shadow one described above.

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

/** One row in the panel. A file appears twice when it is staged and then edited again: git tracks
 * index and working tree separately. `staged` distinguishes the rows and points the button. */
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

// --- Past conversations -- mirrors `src-tauri/src/conversations.rs` -----------

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
  /** Size on disk. Importing copies the file, so the cost is worth seeing beforehand. */
  bytes: number;
}

/** One directory under `~/.claude/projects`: a workspace that has conversations in it. */
export interface ClaudeProject {
  /** The directory name, which is the handle for listing and importing out of it. */
  dir: string;
  /** The workspace the transcripts name, read from a record — `dir` cannot be reversed. */
  cwd: string;
  conversations: number;
  /** Newest transcript's modified time, from the filesystem rather than the records. */
  updatedMs: number | null;
  bytes: number;
}

/** One message from a past conversation, flattened for display. */
export interface ConversationEntry {
  role: "user" | "assistant";
  text: string;
  atMs: number | null;
  /** Tools this message called, so a reply that only used tools is not blank. */
  tools: string[];
}

// --- The memory vault -- mirrors `src-tauri/src/memory.rs` -------------------
// The notes are the SDK's; nothing here reads one. `memory.rs` says why the path is resolved twice.

/** Where memory lives on this machine, and whether the SDK is being told to use it. */
export interface MemoryVault {
  vault: WirePath;
  enabled: boolean;
}

/** What is in the vault, counted without opening any of it. */
export interface MemoryStats {
  /** Markdown files, at any depth. */
  notes: number;
  /** Bytes of those files only, not of everything in the folder. */
  bytes: number;
  /** The most recently written note, or `null` for an empty vault. */
  newestMs: number | null;
}
