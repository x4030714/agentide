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
};
