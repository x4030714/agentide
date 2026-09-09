import { ptyKill, ptySpawn } from "./bridge";
import type { WirePath } from "./protocol";

/** The agent's terminal: a real pty, its own session, a fresh shell per command. An
 * interactive shell would need a `cmd; echo __done_$?` sentinel to know when a command ended. */

/** The pty id for the agent's session. One session, so one id. */
export const AGENT_PTY_ID = "agent-shell";

/** How long a command may run before it is killed and reported as timed out. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Beyond this the model is being handed noise; the middle is dropped, not the end. */
const MAX_OUTPUT = 24_000;

export interface RunResult {
  /** `null` when the process was killed rather than exiting on its own. */
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  /** Wall clock, which is what the user watched. */
  ms: number;
}

type OutputListener = (chunk: Uint8Array) => void;

/** Who is rendering the agent's terminal, if anyone. A module-level listener, not a prop:
 * the session outlives the tab, so a command run with the tab never opened still runs. */
let listener: OutputListener | null = null;
const scrollback: Uint8Array[] = [];
let scrollbackBytes = 0;

/** Keep enough to fill a screen after the fact, and no more. */
const SCROLLBACK_LIMIT = 256 * 1024;

export function attachAgentTerminal(next: OutputListener): () => void {
  listener = next;
  // Replay what was missed, so opening the tab mid-build shows the build.
  for (const chunk of scrollback) next(chunk);
  return () => {
    if (listener === next) listener = null;
  };
}

function emit(chunk: Uint8Array) {
  scrollback.push(chunk);
  scrollbackBytes += chunk.byteLength;
  while (scrollbackBytes > SCROLLBACK_LIMIT && scrollback.length > 1) {
    scrollbackBytes -= scrollback.shift()!.byteLength;
  }
  listener?.(chunk);
}

/** Written into the terminal around each command, so the tab reads as a session. */
function banner(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

let running = false;

/** Run one command in the agent's terminal and wait. Serialised — two at once would
 * interleave in one terminal. The second waits rather than being refused. */
export async function runInAgentTerminal(
  command: string,
  cwd: WirePath | null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<RunResult> {
  while (running) await new Promise((resolve) => setTimeout(resolve, 60));
  running = true;
  const started = Date.now();

  const collected: Uint8Array[] = [];
  let settle: ((result: RunResult) => void) | null = null;
  const finished = new Promise<RunResult>((resolve) => {
    settle = resolve;
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  let done = false;
  const finish = (result: Omit<RunResult, "output" | "ms">) => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    settle?.({ ...result, output: decode(collected), ms: Date.now() - started });
  };

  emit(banner(`\r\n\x1b[38;5;244m$ ${command}\x1b[0m\r\n`));

  try {
    await ptySpawn(
      { id: AGENT_PTY_ID, cwd: cwd ?? undefined, shellCommand: command },
      (chunk) => {
        collected.push(chunk);
        emit(chunk);
      },
      (event) => {
        if (event.t === "exited") finish({ exitCode: event.code, timedOut: false });
      },
    );
  } catch (err) {
    running = false;
    throw err;
  }

  timer = setTimeout(() => {
    // Killed, not left running: a turn hung forever on `npm run dev` is worse than one told
    // the command did not finish. Partial output still goes back; it usually says why.
    void ptyKill(AGENT_PTY_ID).catch(() => {});
    finish({ exitCode: null, timedOut: true });
  }, timeoutMs);

  const result = await finished;
  emit(
    banner(
      result.timedOut
        ? `\x1b[38;5;208m— killed after ${Math.round(timeoutMs / 1000)}s —\x1b[0m\r\n`
        : `\x1b[38;5;244m— exit ${result.exitCode ?? "?"} in ${(result.ms / 1000).toFixed(1)}s —\x1b[0m\r\n`,
    ),
  );
  running = false;
  return result;
}

// --- Processes that outlive the call that started them ----------------------------

/** A command the agent started and did not wait for. `runInAgentTerminal` kills at its
 * timeout, which is wrong for things with no end — a dev server, a watcher, a REPL. */
export interface BackgroundProcess {
  id: string;
  command: string;
  /** False once it has exited on its own or been stopped. */
  running: boolean;
  /** `null` while running, and when it was killed rather than exiting. */
  exitCode: number | null;
  startedAt: number;
}

interface Entry extends BackgroundProcess {
  /** Everything written, so opening the tab late still shows the log. */
  scrollback: Uint8Array[];
  bytes: number;
  /** Written but not yet handed to the model. The cursor lives here, not in the caller: a
   * model tracking its own offset re-reads an hour of watcher log whenever it loses track. */
  pending: Uint8Array[];
  listener: OutputListener | null;
}

const processes = new Map<string, Entry>();
const watchers = new Set<() => void>();
let backgroundCounter = 0;

/** Told whenever a process starts, exits or is stopped, so the pane can redraw its tabs. */
export function watchBackground(notify: () => void): () => void {
  watchers.add(notify);
  return () => watchers.delete(notify);
}

function changed() {
  for (const notify of watchers) notify();
}

/** The processes the agent has started, running or recently finished. */
export function listBackground(): BackgroundProcess[] {
  return [...processes.values()].map(({ id, command, running, exitCode, startedAt }) => ({
    id,
    command,
    running,
    exitCode,
    startedAt,
  }));
}

/** Start a command and return at once. The pty id doubles as the handle. */
export async function startBackground(
  command: string,
  cwd: WirePath | null,
): Promise<BackgroundProcess> {
  backgroundCounter += 1;
  const id = `agent-bg-${backgroundCounter}`;
  const entry: Entry = {
    id,
    command,
    running: true,
    exitCode: null,
    startedAt: Date.now(),
    scrollback: [],
    bytes: 0,
    pending: [],
    listener: null,
  };
  processes.set(id, entry);

  const write = (chunk: Uint8Array) => {
    entry.scrollback.push(chunk);
    entry.bytes += chunk.byteLength;
    while (entry.bytes > SCROLLBACK_LIMIT && entry.scrollback.length > 1) {
      entry.bytes -= entry.scrollback.shift()!.byteLength;
    }
    entry.pending.push(chunk);
    entry.listener?.(chunk);
  };

  write(banner(`\r\n\x1b[38;5;244m$ ${command}\x1b[0m\r\n`));

  try {
    await ptySpawn({ id, cwd: cwd ?? undefined, shellCommand: command }, write, (event) => {
      if (event.t !== "exited") return;
      entry.running = false;
      entry.exitCode = event.code;
      write(banner(`\x1b[38;5;244m— exit ${event.code ?? "?"} —\x1b[0m\r\n`));
      changed();
    });
  } catch (err) {
    processes.delete(id);
    throw err;
  }

  changed();
  return { id, command, running: true, exitCode: null, startedAt: entry.startedAt };
}

/** What a background process has written since the last time this was called. */
export function readBackground(
  id: string,
): { output: string; process: BackgroundProcess } | null {
  const entry = processes.get(id);
  if (!entry) return null;
  const output = decode(entry.pending);
  entry.pending = [];
  const { command, running, exitCode, startedAt } = entry;
  return { output, process: { id, command, running, exitCode, startedAt } };
}

/** Kill a background process. The entry stays with `running: false` — a handle that vanished
 * on stop would turn a second call, or a racing read, into a misleading "no such process". */
export async function stopBackground(id: string): Promise<boolean> {
  const entry = processes.get(id);
  if (!entry) return false;
  if (entry.running) {
    await ptyKill(id).catch(() => {});
    entry.running = false;
  }
  changed();
  return true;
}

/** Stop a background process and drop it entirely — what closing its tab does. Separate from
 * `stopBackground`: that one should leave a handle that still answers. */
export async function forgetBackground(id: string): Promise<void> {
  await stopBackground(id);
  processes.delete(id);
  changed();
}

/** Render a background process's tab, replaying what it has already written. */
export function attachBackground(id: string, next: OutputListener): () => void {
  const entry = processes.get(id);
  if (!entry) return () => {};
  entry.listener = next;
  for (const chunk of entry.scrollback) next(chunk);
  return () => {
    if (entry.listener === next) entry.listener = null;
  };
}

/** Bytes to text the model can read. Escape sequences stripped: a carriage-return progress bar is
 * thousands of tokens for one line. Keeps what a person scrolling back would see. */
function decode(chunks: Uint8Array[]): string {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  const text = new TextDecoder().decode(joined);
  const plain = stripAnsi(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return clamp(plain.trim());
}

/** CSI, OSC and single-character escapes, removed. Not a terminal emulator — cursor movement
 * is not replayed, so redrawn screens leave their intermediate states as extra lines. */
function stripAnsi(text: string): string {
  // Built from its code point rather than written literally: a raw escape byte in
  // source is invisible, and every tool that touches the file is a chance to lose it.
  const ESC = String.fromCharCode(27);
  return (
    text
      // OSC: ESC ] ... terminated by BEL or ESC backslash.
      .replace(new RegExp(`${ESC}\\][^\\u0007${ESC}]*(?:\\u0007|${ESC}\\\\)`, "g"), "")
      // CSI: ESC [ parameters intermediates final.
      .replace(new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g"), "")
      // Two-character escapes.
      .replace(new RegExp(`${ESC}[@-Z\\\\-_]`, "g"), "")
      // A sequence cut in half by a read boundary, which would otherwise show as junk.
      .replace(new RegExp(`${ESC}\\[?[0-?]*$`, "g"), "")
      // Bell, and the backspaces a spinner leaves behind.
      .replace(/[\b]/g, "")
  );
}

/** Keep both ends when there is too much: the head says what was run, the tail carries the
 * error. Only the middle of a long build carries nothing. */
function clamp(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  const half = Math.floor(MAX_OUTPUT / 2);
  const dropped = text.length - MAX_OUTPUT;
  return `${text.slice(0, half)}\n\n… ${dropped} characters omitted …\n\n${text.slice(-half)}`;
}

/** The two pure functions above, for tests. One named object so the import site shows these
 * are exported only to be pinned, not part of the module's API. */
export const __testing = { stripAnsi, clamp };
