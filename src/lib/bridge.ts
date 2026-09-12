/** Typed wrappers over the Rust commands in `src-tauri/src/fs.rs`. Paths go out as plain strings
 * and are normalized by `ipc.rs`; everything coming back is a `WirePath`. */

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import { inOrder } from "./in-order";
import { MAXIMIZED_EVENT } from "./protocol";
import type {
  AgentEvent,
  Attachment,
  AgentStartOptions,
  DirListing,
  FileContents,
  FileStat,
  FsEvent,
  JsonObject,
  PermissionDecision,
  PromptOptions,
  SearchOptions,
  SearchResults,
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

/** Open a folder as the workspace and subscribe to its changes. Batches arrive debounced from the
 * Rust watcher, so `onChanges` runs per burst. Opening again replaces the previous watcher. */
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

/** Every file in the workspace, for quick open. One call, not a lazy walk — the palette ranks the
 * whole project per keystroke. Capped in Rust, so a huge repository returns a prefix, not a hang. */
export async function listFiles(limit?: number): Promise<WirePath[]> {
  return invoke<WirePath[]>("list_files", { limit });
}

/** Every occurrence of `query` in the workspace. One walk per call, capped in Rust — a long
 * answer comes back with `truncated` set rather than as a hang. */
export async function searchWorkspace(
  query: string,
  options: SearchOptions,
): Promise<SearchResults> {
  return invoke<SearchResults>("search_workspace", { query, options });
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

// --- Agent -- wrappers over `src-tauri/src/agent.rs` ------------------------

/** Start the agent sidecar and subscribe to its events. Starting again replaces it. The workspace
 * root is not passed: Rust reads it per prompt, so opening a different folder needs no restart. */
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

/** Run a turn. Resolves once the prompt is handed to the sidecar, not when the turn ends — watch
 * the channel for `done`. `sessionId` is the frontend's handle; reusing one continues it. */
export async function agentPrompt(
  sessionId: string,
  text: string,
  options?: PromptOptions,
  attachments?: Attachment[],
): Promise<void> {
  return invoke("agent_prompt", { sessionId, text, attachments, options });
}

/** Build the query before the first prompt, so `/` has commands to offer and the model
 * picker is populated. Fire and forget: a failure costs a menu, never a turn. */
export async function agentWarm(sessionId: string, options?: PromptOptions): Promise<void> {
  return invoke("agent_warm", { sessionId, options });
}

/** Stop the running turn and drop anything queued behind it. */
export async function agentInterrupt(sessionId: string): Promise<void> {
  return invoke("agent_interrupt", { sessionId });
}

/**
 * Ask who is signed in, or sign out. The answer arrives as an `account` event, not here —
 * the sidecar owns the binary that knows.
 *
 * Signing out is machine-wide: it drops the credential the person's own Claude Code uses.
 * Confirm before calling it; nothing here can put it back.
 */
export async function agentAuth(
  action: "status" | "logout",
  account?: string,
): Promise<void> {
  return invoke("agent_auth", { action, account });
}

/** Answer a `permission_request`. Rejects with an `agent` error if something already answered it,
 * which is the normal outcome when `hostPermissions` was left false. */
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

/** Answer a `tool_call`. Rejects with an `agent` error if something already answered it, which is
 * what happens for any tool not named in `agentStart`'s `hostTools`. */
export async function agentToolReply(id: string, result: ToolResult): Promise<void> {
  return invoke("agent_tool_reply", { id, result });
}


// --- Window chrome -- wrappers over `src-tauri/src/window.rs` ---------------
// Frameless and transparent: the title bar is ours, and needs `data-tauri-drag-region` to drag.

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

  /** Run `handler` whenever the window is maximized or restored, whoever did it — button, double
   * click, Win+Arrow, drag to the top. Resolves to the unsubscribe function. */
  async onMaximizedChange(handler: (maximized: boolean) => void): Promise<() => void> {
    return listen<boolean>(MAXIMIZED_EVENT, (event) => handler(event.payload));
  },

  /** Whether the translucent backdrop applied. False on older Windows and every non-Windows build,
   * where the CSS has to supply its own background instead of tinting the desktop. */
  async effectActive(): Promise<boolean> {
    return invoke<boolean>("window_effect_active");
  },

  /** Put the backdrop back, or take it away. Resolves to whether it is on afterwards, which is not
   * what was asked for: applying can fail, and the CSS needs the honest answer. */
  async setBackdrop(enabled: boolean): Promise<boolean> {
    return invoke<boolean>("window_set_backdrop", { enabled });
  },
};

// ---------------------------------------------------------------------------
// Checkpoints

/** Commit the current tree to the shadow repository. Cheap enough to run before every turn, which
 * is the point: a turn without a checkpoint before it cannot be undone. */
export async function checkpointCreate(label: string): Promise<Checkpoint> {
  return invoke<Checkpoint>("checkpoint_create", { label });
}

/** Newest first. */
export async function checkpointList(limit?: number): Promise<Checkpoint[]> {
  return invoke<Checkpoint[]>("checkpoint_list", { limit });
}

/** Every changed file between a checkpoint and `to`, or the working tree when `to` is omitted.
 * Files too large or not text come back flagged rather than dropped. */
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

/** Put selected hunks back. All-or-nothing: a stale id, or a subset that will not reverse-apply,
 * writes nothing and rejects with `"stale"`. */
export async function checkpointRevertHunks(
  checkpoint: string,
  path: WirePath,
  hunks: string[],
): Promise<RevertOutcome> {
  return invoke<RevertOutcome>("checkpoint_revert_hunks", { checkpoint, path, hunks });
}

/** Restore the whole work tree to a checkpoint, taking a safety checkpoint first so the rewind is
 * undoable. `deleteCreated` defaults to true; ignored files are never touched either way. */
export async function checkpointRewind(
  checkpoint: string,
  deleteCreated?: boolean,
): Promise<RewindResult> {
  return invoke<RewindResult>("checkpoint_rewind", { checkpoint, deleteCreated });
}

// --- Terminal -- wrappers over `src-tauri/src/pty.rs` ------------------------

/** Start a shell — or `options.command` — in a pty and subscribe. `onOutput` gets bytes and must go
 * straight to `terminal.write`: decoding here corrupts a chunk that ends mid-character. */
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
  // Queued per id: see `in-order.ts` for the race this closes.
  return inOrder(options.id, () => invoke<PtyInfo>("pty_spawn", { options, onEvent: channel }));
}

/**
 * A file as base64, for attaching an image to a prompt.
 *
 * Rejects rather than truncates when the file is over `maxBytes`: half an image is not a
 * smaller image, and the caller has a limit worth naming in the error.
 */
export async function readFileBase64(path: WirePath, maxBytes: number): Promise<string> {
  return invoke<string>("read_file_base64", { path, maxBytes });
}

/** Send input to the shell — xterm's `onData` unchanged. Rejects with a `"pty"` error once the
 * session has exited, so input is never silently dropped into a dead terminal. */
export async function ptyWrite(id: string, data: string): Promise<void> {
  return invoke("pty_write", { id, data });
}

/** Tell the shell the terminal changed shape, from the fit addon. A pty that is never resized
 * keeps wrapping at 24x80. */
export async function ptyResize(id: string, rows: number, cols: number): Promise<void> {
  return invoke("pty_resize", { id, rows, cols });
}

/** End a session and everything in it. Safe to call twice, and on one that already exited —
 * closing a tab should not have to check first. */
export async function ptyKill(id: string): Promise<void> {
  // Behind the same queue as the spawn: a kill that overtakes one kills the wrong session.
  return inOrder(id, () => invoke<void>("pty_kill", { id }));
}

// --- Language servers -- wrappers over `src-tauri/src/lsp.rs` ----------------
// Rust owns the process and the `Content-Length` framing; the LSP client is on this side.

/** Start a language server and subscribe. `onEvent` gets batches of already-parsed `messages` —
 * do not `JSON.parse` them again. Send `initialize` yourself as the first `lspSend`. */
export async function lspStart(
  options: LspStartOptions,
  onEvent: (event: LspEvent) => void,
): Promise<LspInfo> {
  const channel = new Channel<LspEvent>();
  channel.onmessage = onEvent;
  return invoke<LspInfo>("lsp_start", { options, onEvent: channel });
}

/** Send one JSON-RPC message; framing is added in Rust, which never reads inside it. Rejects with
 * `"lsp"` once the server has exited, so a request never waits on a reply that cannot come. */
export async function lspSend(id: string, message: LspMessage): Promise<void> {
  return invoke("lsp_send", { id, message });
}

/** Stop a server and everything it spawned; safe to call twice. Closes stdin and waits a moment
 * before killing, which keeps rust-analyzer from orphaning a `cargo` process. */
export async function lspStop(id: string): Promise<void> {
  return invoke("lsp_stop", { id });
}

// --- The user's own git repository -- wrappers over `src-tauri/src/git.rs` ---
// Runs git in their working tree with their config, so a commit here runs their hooks and signs.

/** Never throws for "not a repository"; that comes back as `isRepo: false`. */
export async function gitStatus(): Promise<GitStatus> {
  return invoke<GitStatus>("git_status");
}

/** One file's two sides. `staged` picks the comparison — index against HEAD, or working tree
 * against index — so a row and the diff it opens describe the same change. */
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

// --- Past conversations -- wrappers over `src-tauri/src/conversations.rs` ----
// The agent SDK's own transcripts. No existing one is ever modified; `conversationImport` copies.

/** Most recently active first. Empty for a workspace that has never had a turn. */
export async function conversationsList(): Promise<ConversationSummary[]> {
  return invoke<ConversationSummary[]>("conversations_list");
}

/** One conversation's messages, for reading. `fromDir` reads out of another project's directory,
 * which is how a conversation is previewed before importing it. */
export async function conversationRead(
  id: string,
  fromDir?: string,
): Promise<ConversationEntry[]> {
  return invoke<ConversationEntry[]>("conversation_read", { id, fromDir: fromDir ?? null });
}

/** Every project directory under `~/.claude/projects`, newest first. One head-of-file read per
 * directory, not per transcript: the store is hundreds of megabytes and this opens a panel. */
export async function claudeProjectsList(): Promise<ClaudeProject[]> {
  return invoke<ClaudeProject[]>("claude_projects_list");
}

/** The conversations in one project directory. Costs a full scan of each transcript. */
export async function claudeConversationsList(dir: string): Promise<ConversationSummary[]> {
  return invoke<ConversationSummary[]>("claude_conversations_list", { dir });
}

/** Copy a conversation from another project into this workspace, under a fresh session id. The
 * result starts with the same history but does not continue the original. */
export async function conversationImport(id: string, fromDir: string): Promise<string> {
  return invoke<string>("conversation_import", { id, fromDir });
}

// --- The memory vault -- wrappers over `src-tauri/src/memory.rs` -------------
// The model writes notes through ordinary `Write` calls, which is why there is no write command.

/** Video memory in whole gigabytes, or null when there is no NVIDIA GPU. Absent is not an error:
 * llama.cpp runs on the CPU, and the model list says what that costs rather than refusing. */
export async function gpuVramGb(): Promise<number | null> {
  return invoke<number | null>("gpu_vram_gb");
}

/** Where memory lives, resolved by Rust from `~/.agentide/memory.json` — the sidecar resolves the
 * same file, and a second guess here would drift from the folder being written to. */
/** Whether a turn could authenticate right now. Asked after a sign-in finishes, so the
 * readiness banner clears without waiting for a turn. */
export async function signedIn(): Promise<boolean> {
  return invoke<boolean>("tools_signed_in");
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
