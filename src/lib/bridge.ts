/**
 * Typed wrappers over the Rust commands in `src-tauri/src/fs.rs`.
 *
 * Every path argument is sent as a plain string and normalized by `ipc.rs` on the way
 * in, so callers may pass whatever the OS dialog gave them; everything coming back is a
 * `WirePath`.
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import { MAXIMIZED_EVENT } from "./protocol";
import type {
  AgentEvent,
  AgentStartOptions,
  DirListing,
  FileContents,
  FileStat,
  FsEvent,
  JsonObject,
  PermissionDecision,
  PromptOptions,
  ToolResult,
  WirePath,
  Workspace,
  Checkpoint,
  CheckpointDiff,
  DiffFile,
  FileHunks,
  RevertOutcome,
  RewindResult,
  PtyEvent,
  PtyInfo,
  PtySpawnOptions,
  LspEvent,
  LspInfo,
  LspMessage,
  LspStartOptions,
  GitBranch,
  GitCommitResult,
  GitFileDiff,
  GitStatus,
  ConversationSummary,
  ConversationEntry,
  ClaudeProject,
  MemoryStats,
  MemoryVault,
} from "./protocol";

/** Native folder picker. Returns null when the user cancels. */
export async function pickFolder(): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, title: "Open folder" });
  return typeof picked === "string" ? picked : null;
}

/**
 * Open a folder as the workspace and subscribe to its changes.
 *
 * Batches arrive debounced from the Rust watcher, so `onChanges` runs once per burst
 * rather than once per OS notification. Opening again replaces the previous watcher.
 */
export async function openWorkspace(
  path: string,
  onChanges: (changes: FsEvent[]) => void,
): Promise<Workspace> {
  const channel = new Channel<FsEvent[]>();
  channel.onmessage = onChanges;
  return invoke<Workspace>("open_workspace", { path, onEvent: channel });
}

export async function closeWorkspace(): Promise<void> {
  return invoke("close_workspace");
}

export async function listDir(path: WirePath): Promise<DirListing> {
  return invoke<DirListing>("list_dir", { path });
}

/**
 * Every file in the workspace, for quick open.
 *
 * One call, not a lazy walk: the palette ranks the whole project on each keystroke. Empty
 * when no workspace is open. Capped in Rust, so a huge repository returns a prefix rather
 * than a hang.
 */
export async function listFiles(limit?: number): Promise<WirePath[]> {
  return invoke<WirePath[]>("list_files", { limit });
}

export async function readFile(path: WirePath): Promise<FileContents> {
  return invoke<FileContents>("read_file", { path });
}

export async function writeFile(
  path: WirePath,
  contents: string,
  bom = false,
): Promise<FileStat> {
  return invoke<FileStat>("write_file", { path, contents, bom });
}

// ---------------------------------------------------------------------------
// Agent -- wrappers over `src-tauri/src/agent.rs`
// ---------------------------------------------------------------------------

/**
 * Start the agent sidecar and subscribe to its events.
 *
 * Starting again replaces the running sidecar and its channel. The workspace root is not
 * passed here: the Rust core reads it from its own state on every prompt, so opening a
 * different folder needs no restart. Prompting before a folder is open fails with an
 * `agent` error.
 */
export async function agentStart(
  onEvent: (event: AgentEvent) => void,
  options: AgentStartOptions = {},
): Promise<void> {
  const channel = new Channel<AgentEvent>();
  channel.onmessage = onEvent;
  return invoke("agent_start", {
    options: { hostTools: options.hostTools ?? [], hostPermissions: options.hostPermissions ?? false },
    onEvent: channel,
  });
}

/** Stop the sidecar. Safe to call when none is running. */
export async function agentStop(): Promise<void> {
  return invoke("agent_stop");
}

/**
 * Run a turn. Resolves once the prompt has been handed to the sidecar, not when the turn
 * ends -- watch the channel for `done` with this `sessionId`.
 *
 * `sessionId` is the frontend's own handle for a conversation; reusing one continues it.
 */
export async function agentPrompt(
  sessionId: string,
  text: string,
  options?: PromptOptions,
): Promise<void> {
  return invoke("agent_prompt", { sessionId, text, options });
}

/** Stop the running turn and drop anything queued behind it. */
export async function agentInterrupt(sessionId: string): Promise<void> {
  return invoke("agent_interrupt", { sessionId });
}

/**
 * Answer a `permission_request`. Rejects with an `agent` error if something already
 * answered it -- which is the normal outcome when `hostPermissions` was left false.
 */
export async function agentPermissionReply(
  id: string,
  decision: PermissionDecision,
  extra: { updatedInput?: JsonObject; message?: string } = {},
): Promise<void> {
  return invoke("agent_permission_reply", {
    id,
    decision,
    updatedInput: extra.updatedInput,
    message: extra.message,
  });
}

/**
 * Answer a `tool_call`. Rejects with an `agent` error if something already answered it,
 * which is what happens for any tool not named in `agentStart`'s `hostTools`.
 */
export async function agentToolReply(id: string, result: ToolResult): Promise<void> {
  return invoke("agent_tool_reply", { id, result });
}


// ---------------------------------------------------------------------------
// Window chrome -- wrappers over `src-tauri/src/window.rs`
//
// The window is frameless (`decorations: false`) and transparent, so the title bar is
// ours to draw. Give the bar a `data-tauri-drag-region` attribute to make dragging it
// move the window; Tauri handles double-click-to-maximize on that element itself.
// Resizing is still the OS's: the frame is invisible, but its hit-testing is not gone.
// ---------------------------------------------------------------------------

export const windowChrome = {
  /** Send the window to the taskbar. */
  async minimize(): Promise<void> {
    return invoke("window_minimize");
  },

  /** Maximize when restored, restore when maximized. */
  async toggleMaximize(): Promise<void> {
    return invoke("window_toggle_maximize");
  },

  /** Close the window, which quits the app and stops the sidecar with it. */
  async close(): Promise<void> {
    return invoke("window_close");
  },

  /** The state now, for the title bar's first paint. */
  async isMaximized(): Promise<boolean> {
    return invoke<boolean>("window_is_maximized");
  },

  /**
   * Run `handler` whenever the window is maximized or restored, whoever did it -- the
   * title bar's button, a double click on the drag region, a Win+Arrow snap, a drag to
   * the top of the screen. Resolves to the unsubscribe function.
   */
  async onMaximizedChange(handler: (maximized: boolean) => void): Promise<() => void> {
    return listen<boolean>(MAXIMIZED_EVENT, (event) => handler(event.payload));
  },

  /**
   * Whether the translucent backdrop applied. False on a machine whose Windows is too
   * old for it, and on any non-Windows build: the window is then an ordinary opaque one
   * and the CSS has to supply its own background rather than tinting the desktop.
   */
  async effectActive(): Promise<boolean> {
    return invoke<boolean>("window_effect_active");
  },

  /**
   * Put the backdrop back, or take it away, for the Transparency setting. Resolves to
   * whether it is on afterwards -- which is not the same as what was asked for: applying
   * can fail, and the honest answer is what the CSS has to be told.
   */
  async setBackdrop(enabled: boolean): Promise<boolean> {
    return invoke<boolean>("window_set_backdrop", { enabled });
  },
};

// ---------------------------------------------------------------------------
// Checkpoints

/**
 * Commit the current tree to the shadow repository.
 *
 * Cheap enough to run before every turn, which is the point: a turn without a
 * checkpoint before it is a turn that cannot be undone.
 */
export async function checkpointCreate(label: string): Promise<Checkpoint> {
  return invoke<Checkpoint>("checkpoint_create", { label });
}

/** Newest first. */
export async function checkpointList(limit?: number): Promise<Checkpoint[]> {
  return invoke<Checkpoint[]>("checkpoint_list", { limit });
}

/**
 * Every changed file between a checkpoint and `to` — or, with `to` omitted, between it
 * and the working tree as it stands. Files whose text is too large or not text at all
 * come back flagged rather than dropped.
 */
export async function checkpointDiff(from: string, to?: string): Promise<CheckpointDiff> {
  return invoke<CheckpointDiff>("checkpoint_diff", { from, to });
}

/** One file's two sides — for re-reading a row after a revert, or one the bulk diff's budget left out. */
export async function checkpointFileDiff(
  checkpoint: string,
  path: WirePath,
): Promise<DiffFile | null> {
  return invoke<DiffFile | null>("checkpoint_file_diff", { checkpoint, path });
}

/** One file's hunks, recomputed from the file as it stands right now. */
export async function checkpointHunks(
  checkpoint: string,
  path: WirePath,
): Promise<FileHunks> {
  return invoke<FileHunks>("checkpoint_hunks", { checkpoint, path });
}

/** Put one file back the way it was. A file that did not exist then is removed. */
export async function checkpointRevertFile(
  checkpoint: string,
  path: WirePath,
): Promise<RevertOutcome> {
  return invoke<RevertOutcome>("checkpoint_revert_file", { checkpoint, path });
}

/**
 * Put selected hunks back. All-or-nothing: if any id is stale, or the subset will not
 * reverse-apply, nothing is written and this rejects with `"stale"`.
 */
export async function checkpointRevertHunks(
  checkpoint: string,
  path: WirePath,
  hunks: string[],
): Promise<RevertOutcome> {
  return invoke<RevertOutcome>("checkpoint_revert_hunks", { checkpoint, path, hunks });
}

/**
 * Restore the whole work tree to a checkpoint.
 *
 * Takes a safety checkpoint first, so the rewind is itself undoable. `deleteCreated`
 * defaults to true — files made since the checkpoint are removed, and every one of them
 * is in the safety checkpoint. Pass false to keep them; they come back in `kept`.
 * Nothing the ignore rules exclude is ever deleted, captured or restored.
 */
export async function checkpointRewind(
  checkpoint: string,
  deleteCreated?: boolean,
): Promise<RewindResult> {
  return invoke<RewindResult>("checkpoint_rewind", { checkpoint, deleteCreated });
}

// ---------------------------------------------------------------------------
// Terminal -- wrappers over `src-tauri/src/pty.rs`
// ---------------------------------------------------------------------------

/**
 * Start a shell -- or `options.command` -- in a pty and subscribe to it.
 *
 * `onOutput` receives bytes, not text, and must go straight to xterm.js:
 * `terminal.write(chunk)` takes a `Uint8Array` and keeps the decoder state that a chunk
 * ending mid-character needs. Decoding it here instead would corrupt those characters.
 * Chunks are already coalesced by the Rust side (~12ms, up to 64 KiB), so there is
 * nothing to gain by batching them again.
 *
 * `onEvent` fires once, with `exited`, after the last output of the session. Spawning
 * onto an id that is already running replaces it and kills the process that was there,
 * which the old session reports on its own channel.
 */
export async function ptySpawn(
  options: PtySpawnOptions,
  onOutput: (chunk: Uint8Array) => void,
  onEvent: (event: PtyEvent) => void,
): Promise<PtyInfo> {
  const channel = new Channel<ArrayBuffer | PtyEvent>();
  // One channel, two shapes: raw output arrives as an ArrayBuffer, everything else as an
  // object. See the terminal notes in `protocol.ts`.
  channel.onmessage = (message) => {
    if (message instanceof ArrayBuffer) onOutput(new Uint8Array(message));
    else onEvent(message);
  };
  return invoke<PtyInfo>("pty_spawn", { options, onEvent: channel });
}

/**
 * Send input to the shell. This is what xterm.js's `onData` hands you, unchanged --
 * keystrokes, pasted text and the escape sequences the terminal generates.
 *
 * Rejects with a `"pty"` error once the session has exited, so input is never silently
 * dropped into a dead terminal.
 */
export async function ptyWrite(id: string, data: string): Promise<void> {
  return invoke("pty_write", { id, data });
}

/**
 * Tell the shell the terminal changed shape -- from the fit addon, on every pane resize.
 * A pty that is never resized keeps wrapping at 24x80.
 */
export async function ptyResize(id: string, rows: number, cols: number): Promise<void> {
  return invoke("pty_resize", { id, rows, cols });
}

/**
 * End a session and everything running in it. Safe to call twice, and safe to call on a
 * session that has already exited -- closing a tab should not have to check first.
 */
export async function ptyKill(id: string): Promise<void> {
  return invoke("pty_kill", { id });
}

// ---------------------------------------------------------------------------
// Language servers -- wrappers over `src-tauri/src/lsp.rs`
//
// Rust owns the process and the `Content-Length` framing; the LSP client is on this side.
// See the language-server notes in `protocol.ts` for what that division means.
// ---------------------------------------------------------------------------

/**
 * Start a language server and subscribe to it.
 *
 * `onEvent` receives batches: `messages` carries an array in the order the server wrote
 * them, so loop over it. Messages arrive already parsed -- Rust copies the server's bytes
 * verbatim into the channel payload, so the channel's own parse is the only one -- and
 * must not be `JSON.parse`d again.
 *
 * Rejects with `"notFound"` when the program is not installed and `"lsp"` when it is
 * there but will not start. Nothing about `initialize` happens here: send it yourself as
 * the first `lspSend`, with `options.root` as the workspace folder.
 */
export async function lspStart(
  options: LspStartOptions,
  onEvent: (event: LspEvent) => void,
): Promise<LspInfo> {
  const channel = new Channel<LspEvent>();
  channel.onmessage = onEvent;
  return invoke<LspInfo>("lsp_start", { options, onEvent: channel });
}

/**
 * Send one JSON-RPC message -- request, response or notification. Pass the object; the
 * framing is added in Rust and nothing there reads what is inside it.
 *
 * Rejects with an `"lsp"` error once the server has exited, so a request is never
 * silently written into a dead pipe and left waiting for a reply that cannot come.
 */
export async function lspSend(id: string, message: LspMessage): Promise<void> {
  return invoke("lsp_send", { id, message });
}

/**
 * Stop a server and everything it spawned. Safe to call twice, and safe to call on one
 * that has already exited.
 *
 * Closes the server's stdin and gives it a moment before killing it, which is how a
 * language server is asked to leave -- and what keeps rust-analyzer from orphaning a
 * `cargo` process it had running. Send `shutdown`/`exit` first if you want the protocol's
 * own handshake; this works either way. The session reports `exited` regardless.
 */
export async function lspStop(id: string): Promise<void> {
  return invoke("lsp_stop", { id });
}

// ---------------------------------------------------------------------------
// The user's own git repository -- wrappers over `src-tauri/src/git.rs`
//
// Every one of these runs git in the user's working tree with their config, so a commit
// made here runs their hooks and signs the way theirs do. See that module's header.
// ---------------------------------------------------------------------------

/** Never throws for "not a repository"; that comes back as `isRepo: false`. */
export async function gitStatus(): Promise<GitStatus> {
  return invoke<GitStatus>("git_status");
}

/**
 * One file's two sides. `staged` picks the comparison -- index against HEAD, or working
 * tree against index -- so a row and the diff it opens always describe the same change.
 */
export async function gitFileDiff(rel: string, staged: boolean): Promise<GitFileDiff> {
  return invoke<GitFileDiff>("git_file_diff", { rel, staged });
}

export async function gitStage(paths: string[]): Promise<void> {
  return invoke("git_stage", { paths });
}

/** Index only: this can never touch the working tree, so it cannot eat an edit. */
export async function gitUnstage(paths: string[]): Promise<void> {
  return invoke("git_unstage", { paths });
}

/** Rejects with an `"git"` error carrying a failing hook's own output. */
export async function gitCommit(message: string, amend = false): Promise<GitCommitResult> {
  return invoke<GitCommitResult>("git_commit", { message, amend });
}

export async function gitBranches(): Promise<GitBranch[]> {
  return invoke<GitBranch[]>("git_branches");
}

/** Never forced: git refuses a switch that would discard changes, and names the files. */
export async function gitSwitch(name: string): Promise<void> {
  return invoke("git_switch", { name });
}

// ---------------------------------------------------------------------------
// Past conversations -- wrappers over `src-tauri/src/conversations.rs`
//
// These read the agent SDK's own transcripts, which are also the Claude Code CLI's. No
// existing transcript is ever modified: the SDK owns those files and resumes from them.
// `conversationImport` writes, but only a new file — it copies one in rather than
// editing it where it lies.
// ---------------------------------------------------------------------------

/** Most recently active first. Empty for a workspace that has never had a turn. */
export async function conversationsList(): Promise<ConversationSummary[]> {
  return invoke<ConversationSummary[]>("conversations_list");
}

/**
 * One conversation's messages, for reading.
 *
 * `fromDir` reads out of another project's directory instead of this workspace's, which
 * is how a conversation is previewed before importing it.
 */
export async function conversationRead(
  id: string,
  fromDir?: string,
): Promise<ConversationEntry[]> {
  return invoke<ConversationEntry[]>("conversation_read", { id, fromDir: fromDir ?? null });
}

/**
 * Every project directory under `~/.claude/projects`, newest first.
 *
 * Cheap by design — one head-of-file read per directory, not per transcript — because the
 * store is hundreds of megabytes and this opens a settings panel.
 */
export async function claudeProjectsList(): Promise<ClaudeProject[]> {
  return invoke<ClaudeProject[]>("claude_projects_list");
}

/** The conversations in one project directory. Costs a full scan of each transcript. */
export async function claudeConversationsList(dir: string): Promise<ConversationSummary[]> {
  return invoke<ConversationSummary[]>("claude_conversations_list", { dir });
}

/**
 * Copy a conversation from another project into this workspace and return its new id.
 *
 * A copy under a fresh session id, so the original keeps working where it is. The result
 * is a separate conversation that starts with the same history — resuming it here does
 * not continue the one it came from.
 */
export async function conversationImport(id: string, fromDir: string): Promise<string> {
  return invoke<string>("conversation_import", { id, fromDir });
}

// ---------------------------------------------------------------------------
// The memory vault -- wrappers over `src-tauri/src/memory.rs`
//
// The notes are written by the model through ordinary `Write` calls, which is why there
// is no write command here. These four only locate the folder, make it, measure it and
// show it.
// ---------------------------------------------------------------------------

/**
 * Where memory lives, resolved from `~/.agentide/memory.json` or the default.
 *
 * Asked of Rust rather than worked out here: the sidecar resolves the same file for the
 * SDK, and a second guess in the frontend would eventually disagree with the folder being
 * written to. It also comes back as a `WirePath`, which is what makes it comparable
 * against the paths the model types.
 */
/**
 * Video memory in whole gigabytes, or null when there is no NVIDIA GPU to ask.
 *
 * Used to say which local models fit before one is downloaded. Absent is not an error:
 * llama.cpp runs on the CPU, and the list says what that costs rather than refusing.
 */
export async function gpuVramGb(): Promise<number | null> {
  return invoke<number | null>("gpu_vram_gb");
}

export async function memoryVault(): Promise<MemoryVault> {
  return invoke<MemoryVault>("memory_vault");
}

/** Create the vault if absent, and explain it in a README if it is empty. Never overwrites. */
export async function memorySeed(vault: WirePath): Promise<void> {
  return invoke("memory_seed", { vault });
}

/** Note count and size. Stats only — no note is opened, so this is cheap enough for a panel. */
export async function memoryStats(vault: WirePath): Promise<MemoryStats> {
  return invoke<MemoryStats>("memory_stats", { vault });
}

/** Show the vault in the OS file manager. */
export async function memoryReveal(vault: WirePath): Promise<void> {
  return invoke("memory_reveal", { vault });
}
