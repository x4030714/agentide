import { ptyKill, ptySpawn } from "./bridge";
import type { WirePath } from "./protocol";

/**
 * The agent's terminal: a real pty the user can watch, running one command at a time.
 *
 * ## Why a process per command, and not a shell to type into
 *
 * The obvious design is to keep an interactive shell open and write command lines into
 * it. It is also the one that does not work: a pty is a byte stream with no notion of a
 * command ending, so knowing when to stop reading -- and what the exit code was -- means
 * appending a sentinel (`cmd; echo __done_$?`) and scanning the output for it. That
 * breaks on anything interactive, mixes the shell's prompt and echo into what the model
 * reads, and gives a wrong answer whenever the command prints the sentinel itself.
 *
 * Spawning the shell fresh per command removes the whole problem. The pty already reports
 * a real exit code when the child exits, so completion and status are facts rather than
 * inferences, and the output is the command's own with no prompt around it.
 *
 * What it costs is shell state between commands: no persistent `cd`, no exported
 * variables. That is a fair trade and arguably the safer half -- `cd` inside one command
 * still works, and an agent cannot leave the terminal somewhere the user did not expect.
 *
 * ## Why it is a separate terminal from the user's
 *
 * The user's shell has a person typing into it. Sharing one means their keystrokes land
 * in the middle of the agent's command and vice versa. This session is beside theirs,
 * visible in its own tab, and only the agent writes to it.
 */

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

/**
 * Who is rendering the agent's terminal, if anyone.
 *
 * A module-level listener rather than a prop: the pane that draws this comes and goes
 * with a tab, and the session has to outlive it. A command run while the tab has never
 * been opened still runs, and still ends up in the scrollback the pane replays.
 */
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

/**
 * Run one command in the agent's terminal and wait for it to finish.
 *
 * Serialised: two commands at once would interleave in one terminal and neither output
 * could be attributed. The second waits rather than being refused, because a model that
 * gets "busy" back will usually just try again.
 */
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
    // Killed rather than left running: a turn waiting forever on `npm run dev` is worse
    // than one told the command did not finish. The partial output still goes back,
    // because it is usually the part that says why.
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

/**
 * A command the agent started and did not wait for.
 *
 * `runInAgentTerminal` kills anything still alive at its timeout, which is right for a
 * build and wrong for everything that is supposed to keep running: a dev server, a
 * watcher, a REPL. Those are not slow commands, they are commands with no end, and
 * reporting one as "did not finish within its timeout" is reporting the wrong thing.
 *
 * Each gets its own pty and its own tab, so it stays visible in the sense PRODUCT.md
 * means -- a person can watch a dev server's log while it runs, which is exactly when it
 * is worth watching.
 */
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
  /**
   * Written but not yet handed to the model.
   *
   * The cursor lives here rather than being passed in by the caller, because the useful
   * question is always "what is new since I last looked". A model that had to track an
   * offset would re-read the whole log whenever it lost track, which on a watcher that
   * has been up for an hour is the single most expensive mistake it could make.
   */
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

/**
 * Kill a background process.
 *
 * The entry stays in the map with `running: false`. A handle that vanished the moment it
 * was stopped would turn a second call, or a read racing the stop, into "no such
 * process", which reads as the handle having been wrong all along.
 */
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

/**
 * Stop a background process and drop it entirely.
 *
 * What closing its tab does. Separate from `stopBackground` because the model stopping a
 * dev server and the person closing the tab are different intents: the first should leave
 * a handle that still answers, the second is saying they are done looking at it.
 */
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

/**
 * Bytes to text the model can read.
 *
 * Escape sequences are stripped, because a progress bar that redraws itself with `\r` and
 * colour codes is thousands of tokens describing one line the user already saw. What is
 * kept is what a person would see if they scrolled back: the characters, not the
 * choreography.
 */
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

/**
 * CSI, OSC and the single-character escapes, removed.
 *
 * Deliberately not a general terminal emulator: this does not replay cursor movement, so
 * a program that draws by moving the cursor leaves its intermediate states in the text.
 * That is the honest failure -- extra lines the model can read past -- rather than
 * silently reconstructing a screen that might be wrong.
 */
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

/**
 * Keep both ends when there is too much.
 *
 * The head says what was run and how it started; the tail carries the error and the
 * summary. It is the middle of a long build that carries nothing, so that is what goes.
 */
function clamp(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  const half = Math.floor(MAX_OUTPUT / 2);
  const dropped = text.length - MAX_OUTPUT;
  return `${text.slice(0, half)}\n\n… ${dropped} characters omitted …\n\n${text.slice(-half)}`;
}

/**
 * The two pure functions above, for tests.
 *
 * Exported through one named object rather than individually, so it is obvious at the
 * import site that these are reachable only because they are worth pinning -- not part of
 * how the rest of the app talks to this module.
 */
export const __testing = { stripAnsi, clamp };
