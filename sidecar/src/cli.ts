/** The agent in a terminal, no window. This process is also the host: the `HostLink` writer
 * loops straight back, and only the three `ide_*` tools a terminal can answer are declared. */

import { spawn, spawnSync } from "node:child_process";
import { clearLine, clearScreenDown, createInterface, cursorTo, moveCursor } from "node:readline";
import type { Interface, Key } from "node:readline";
import { resolve } from "node:path";

import { HostLink } from "./host.ts";
import { ModelCatalogue } from "./models.ts";
import { allCommands, complete, format, lookup } from "./cli-commands.ts";
import { ago, listConversations } from "./conversations.ts";
import { checkup, claudeBinary, ready, signedIn } from "./doctor.ts";
import type { Problem } from "./doctor.ts";
import { CLOUD, modelRows, pickModel, pickProvider, providerRows } from "./cli-picks.ts";
import type { PastConversation } from "./conversations.ts";
import { accept, MENU_HEIGHT, menuFor, move, rows } from "./cli-menu.ts";
import { pad, theme, width as visibleWidth } from "./cli-theme.ts";
import type { Theme } from "./cli-theme.ts";
import type { Menu } from "./cli-menu.ts";
import type {
  JsonObject,
  ModelInfo,
  ProviderInfo,
  SidecarMessage,
  SlashCommand,
  ToolResult,
} from "./protocol.ts";
import { guard, release as standDown } from "./reaper.ts";
import { Session } from "./session.ts";

/** The `ide_*` tools a terminal can honestly answer. `ide_run` is the agent's shell and the
 * reason `Bash` is disallowed; everything else needs an editor or a language server. */
const CLI_TOOLS = ["ide_run", "ide_terminal_read", "ide_terminal_stop"] as const;

/** How long a command may run before it is killed, matching the app's own default. */
const RUN_TIMEOUT_MS = 120_000;

interface Options {
  /** Empty for the interactive mode: `agentide` on its own opens a prompt. */
  prompt: string;
  cwd: string;
  model?: string;
  provider?: string;
  /** Print every tool call and its result, not just the assistant's prose. */
  verbose: boolean;
  /** A past conversation to continue, chosen with `/resume`. */
  resume?: string;
}

function usage(): never {
  process.stderr.write(
    [
      "agentide run — the agent, without the window",
      "",
      "  agentide                         open a prompt and keep the session",
      "  agentide <prompt>                run one turn and exit",
      "  --cwd <path>                     run it somewhere else",
      "  --model <id>                     a model id, e.g. claude-opus-5",
      "  --provider <key>                 a backend from ~/.agentide/providers.json",
      "  --verbose                        show tool calls as they happen",
      "",
      "Reads the same ~/.agentide config as the app: mcp.json, providers.json, memory.json,",
      "system.md. Anything it changes is changed for real -- there is no checkpoint here,",
      "because checkpoints are the Rust core's and this does not run it.",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const words: string[] = [];
  const options: Partial<Options> = { verbose: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--verbose" || arg === "-v") options.verbose = true;
    else if (arg === "--cwd") options.cwd = argv[(index += 1)];
    else if (arg === "--model") options.model = argv[(index += 1)];
    else if (arg === "--provider") options.provider = argv[(index += 1)];
    else if (arg === "--help" || arg === "-h") usage();
    else if (arg?.startsWith("-")) usage();
    else if (arg !== undefined) words.push(arg);
  }
  // Everything not a flag is the prompt, so quoting it is optional. None of it at all is
  // the interactive mode rather than a mistake.
  const prompt = words.join(" ").trim();
  return {
    prompt,
    cwd: resolve(options.cwd ?? process.cwd()).replace(/\\/g, "/"),
    ...(options.model ? { model: options.model } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    verbose: options.verbose ?? false,
  };
}

/** Run one command the way `ide_run` does in the app. Through the shell, because the model
 * writes a command line and not an argv; output is captured, since it is the tool's answer. */
function runCommand(command: string, cwd: string): Promise<ToolResult> {
  return new Promise((settle) => {
    const started = Date.now();
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    let output = "";
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const timer = setTimeout(() => {
      child.kill();
      settle({
        ok: false,
        error: `Killed after ${RUN_TIMEOUT_MS / 1000}s: the command did not finish within its timeout.\n${output || "(nothing)"}`,
      });
    }, RUN_TIMEOUT_MS);
    timer.unref();

    child.on("error", (error) => {
      clearTimeout(timer);
      settle({ ok: false, error: `cannot run: ${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const head = `exit ${code ?? "?"} in ${((Date.now() - started) / 1000).toFixed(1)}s`;
      const body = output || "(no output)";
      settle(code === 0 ? { ok: true, text: `${head}\n${body}` } : { ok: false, error: `${head}\n${body}` });
    });
  });
}

/** Answer one `ide_*` call. Anything outside `CLI_TOOLS` should never reach here. */
async function answer(name: string, args: JsonObject, cwd: string): Promise<ToolResult> {
  if (name === "ide_run") {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command) return { ok: false, error: "`command` is required." };
    if (args.background === true) {
      // Deliberately refused rather than faked. A background process needs somewhere to
      // live and something to read it later, and this process exits when the turn does.
      return {
        ok: false,
        error: "background commands need the app; this is a one-shot terminal.",
      };
    }
    return runCommand(command, cwd);
  }
  return { ok: false, error: `${name} is not available without the app.` };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  /** Settled by each turn's `done` message. Re-made per turn; see `turn`. */
  let finished: (() => void) | null = null;
  let finishedTurn: Promise<void> = Promise.resolve();
  let failed = false;
  /** What the installation offers, once the warm-up has asked it. See `cli-commands.ts`. */
  let agentCommands: SlashCommand[] = [];
  /** The models it can run, from the same warm-up. See `cli-picks.ts`. */
  let agentModels: ModelInfo[] = [];
  /** The backends `providers.json` configures, re-sent on every turn as the file is re-read. */
  let agentProviders: ProviderInfo[] = [];
  /** Redraw an open menu; replaced by `repl` once there is one. The command list lands a second
   * or two late, and a menu opened before then would sit there stale and look final. */
  const menuHook = { refresh: () => {} };

  /** The host, as a function: everything the session would write to stdout lands here. Permission
   * requests are allowed outright -- approval lives in the app, and this is the other mode. */
  const link: HostLink = new HostLink((line: string) => {
    // Not schema-checked -- the link encoded this a microsecond ago. Still routed through the
    // wire format, which is what keeps this host the same shape as the Rust one.
    void handle(JSON.parse(line) as SidecarMessage);
  });

  async function handle(message: SidecarMessage): Promise<void> {
    switch (message.t) {
      case "tool_call": {
        const result = await answer(message.name, message.args, options.cwd);
        // The call is printed from the assistant's own message, so this prints only what came
        // back. Failures show without `--verbose`: they explain the model's next reply.
        if (options.verbose || !result.ok) {
          const body = result.ok ? result.text : result.error;
          process.stdout.write(`${paint.dim(`  ⎿  ${firstLines(body, 4)}`)}\n`);
        }
        link.settle(message.id, result);
        return;
      }
      case "permission_request": {
        link.settle(message.id, { decision: "allow" });
        return;
      }
      case "commands": {
        // Lands when the warm-up's query connects, and again mid-session when the
        // installation pushes a new list -- it does that on skills found in a subdirectory.
        agentCommands = message.commands;
        menuHook.refresh();
        return;
      }
      case "providers": {
        // Sent every turn, not once: `providers.json` is re-read each time, so a backend
        // added while this was open reaches the list on the next prompt.
        agentProviders = message.providers;
        return;
      }
      case "models": {
        // Asked with the command list, for the same reason: both describe the installation
        // rather than the turn.
        agentModels = message.models;
        return;
      }
      case "event": {
        print(message.msg);
        return;
      }
      case "done": {
        if (message.reason === "error") {
          process.stderr.write(`\n${message.error ?? "the turn failed"}\n`);
          failed = true;
        }
        finished?.();
        return;
      }
      default:
        return;
    }
  }

  /** The assistant's prose, and nothing else unless asked. One bullet per block with the rest
   * indented under it, so four paragraphs read as one answer -- the app's shape, and Claude Code's. */
  function print(msg: JsonObject): void {
    if (msg.type !== "assistant") return;
    const content = (msg.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      const part = block as { type?: string; text?: string; name?: string; input?: JsonObject };
      if (part.type === "text" && part.text?.trim()) {
        process.stdout.write(`${bullet(paint.accent("●"), emphasis(part.text.trim()))}\n`);
      } else if (part.type === "tool_use") {
        process.stdout.write(`${paint.dim(`● ${plainName(part.name)}${brief(part.input)}`)}\n`);
      }
    }
  }

  const session = new Session(link, "cli", new ModelCatalogue(link), undefined, CLI_TOOLS);
  // Ctrl+C, a closed terminal and an unhandled throw all used to leave `claude.exe` and every
  // MCP server it started running. See `reaper.ts` for the one case this still cannot cover.
  guard(() => session.dispose());

  /** What the next turn runs with, built per turn: `/model` and `/provider` edit `options`
   * mid-session, and captured at startup they were reported as changed and then ignored. */
  const promptOptions = () => ({
    ...(options.model ? { model: options.model } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.resume ? { resumeConversation: options.resume } : {}),
    // Edits land. There is nobody to review them here, and a terminal that asked would
    // hang on a question with no answer.
    permissionMode: "acceptEdits" as const,
    // Deliberately not `includePartialMessages`: deltas split `**bold**` across writes and
    // put raw asterisks back on screen. The window streams instead.
  });

  /** One turn, and the wait for its `done`. */
  async function turn(text: string): Promise<void> {
    finishedTurn = new Promise<void>((settle) => {
      finished = settle;
    });
    await session.prompt(options.cwd, text, promptOptions());
    await finishedTurn;
  }

  if (options.prompt) {
    // The one-shot path prints no banner, so a fresh install would meet only the SDK's
    // "Please run /login" with no way to act on it.
    const problems = checkup();
    if (!ready(problems)) {
      report(problems, false);
      process.stderr.write("run `agentide` on its own and type /login\n");
      process.exit(1);
    }
    await turn(options.prompt);
    standDown();
    session.dispose();
    process.exit(failed ? 1 : 0);
  }

  // Interactive only, not awaited: the command list exists only on a live query, so build it
  // now with the shape the first turn will ask for rather than a six-entry menu.
  void session.warm(options.cwd, promptOptions());

  await repl(turn, options, session, () => agentCommands, menuHook, () => agentModels, () => agentProviders);
}

/** The interactive mode: `agentide` with nothing after it. One session for the whole
 * conversation, so the ~2.5s CLI startup and its MCP servers are paid once, not per prompt. */
async function repl(
  turn: (text: string) => Promise<void>,
  options: Options,
  session: Session,
  known: () => SlashCommand[],
  menuHook: { refresh: () => void },
  models: () => ModelInfo[],
  providers: () => ProviderInfo[],
): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${paint.dim("│")} ${paint.accent(">")} `,
    // Tab completes a slash command and nothing else; kept for the piped case, where there
    // is no live menu to Tab into.
    completer: (line: string) => complete(line, allCommands(known())),
  });
  /** What `/resume` last printed, so `/resume 3` means that third row. */
  const recent: PastConversation[] = [];
  const menu = attachMenu(rl, () => allCommands(known()));
  menuHook.refresh = menu.refresh;
  const release = captureWarnings(menu.above);
  process.stdout.write(`${banner(options)}\n`);
  // Said before the first prompt rather than after it fails: someone who has just
  // installed this has no way to know they are not signed in, and the SDK's own answer --
  // "Please run /login" -- names a command that only its own TUI has.
  const problems = checkup();
  report(problems, false);
  if (problems.length > 0) process.stdout.write("\n");
  menu.open();

  for await (const line of rl) {
    const text = line.trim();
    if (!text) {
      menu.open();
      continue;
    }
    if (text.startsWith("/")) {
      const commands = allCommands(known());
      const { exact, matches } = lookup(text, commands);
      if (exact?.name === "exit") break;
      if (exact && "local" in exact) {
        await handleLocal(exact.name, text, options, recent, models(), providers());
        menu.open();
        continue;
      }
      // No exact match is a search, not a command. Only reached on a name that matched
      // nothing, or on piped input where there is no menu.
      if (!exact) {
        list(matches, known().length === 0);
        menu.open();
        continue;
      }
      // An exact command the agent published. Send it as written; it interprets its own.
    }
    if (text === "exit" || text === "quit") break;
    // Closed while the turn runs: a prompt drawn under streaming output reads as though
    // the answer arrived after it.
    rl.pause();
    try {
      await turn(text);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.stdout.write("\n");
    rl.resume();
    menu.open();
  }

  menuHook.refresh = () => {};
  release();
  menu.detach();

  rl.close();
  standDown();
  session.dispose();
  process.exit(0);
}

/** Move stderr above the prompt, since a warning written straight out lands inside the input
 * box. `CAN_USE_TOOL_SHADOWED` is dropped: auto-approval here is the decision, not a problem. */
function captureWarnings(above: (text: string) => void): () => void {
  const original = process.stderr.write.bind(process.stderr);
  const shadowed = /CAN_USE_TOOL_SHADOWED|trace-warnings/;
  // The configs are re-read every turn, so the same warning would repeat before every
  // answer -- which is what people learn to scroll past.
  const said = new Set<string>();
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    if (shadowed.test(text)) return true;
    if (said.has(text)) return true;
    said.add(text);
    above(paint.dim(text.replace(/\n+$/, "")));
    // The callback, if the caller passed one. Nothing here is waiting on drain.
    const done = rest.find((argument) => typeof argument === "function");
    if (typeof done === "function") (done as () => void)();
    return true;
  }) as typeof process.stderr.write;
  return () => {
    process.stderr.write = original;
  };
}

/** The welcome box: where am I, what is going to run, how do I find anything. Facts about this
 * session only, so there is nothing to read twice. */
function banner(options: Options): string {
  const terminal = process.stdout.columns || 80;
  const inner = boxWidth(terminal) - 2;
  const backend = options.provider ? `${options.provider} · ${options.model ?? "its default"}` : (options.model ?? "default model");
  const lines = [
    `${paint.accent("✻")} ${paint.bold("agentide")} ${paint.dim("— the agent, without the window")}`,
    "",
    `${paint.dim("cwd")}    ${short(options.cwd, inner - 9)}`,
    `${paint.dim("model")}  ${backend}`,
    "",
    paint.dim("/ for commands · ↑↓ to pick · exit to leave"),
  ];
  const edge = paint.dim("│");
  return [
    rule("top", terminal),
    ...lines.map((line) => `${edge} ${pad(line, inner - 2)} ${edge}`),
    rule("bottom", terminal),
    "",
  ].join("\n");
}

/** A path from its end, which is the half that says where you are. */
function short(path: string, room: number): string {
  return path.length <= room ? path : `…${path.slice(path.length - room + 1)}`;
}

/** How the whole CLI is coloured. Decided once: the terminal does not change mid-run. */
const paint: Theme = theme(process.stdout);

/** A glyph, then text whose later lines line up under the first: without the indent the bullet
 * marks a line rather than a block. */
function bullet(glyph: string, text: string): string {
  const [first = "", ...rest] = text.split("\n");
  return [`${glyph} ${first}`, ...rest.map((line) => `  ${line}`)].join("\n");
}

/** Only `**bold**` and `` `code` ``, the markdown a model uses mid-sentence. Everything else is
 * left raw: this is a terminal, and half-rendering headings and lists is its own kind of wrong. */
function emphasis(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, (_, inner: string) => paint.bold(inner))
    .replace(/`([^`\n]+)`/g, (_, inner: string) => paint.accent(inner));
}

/** A tool's name without the SDK's routing: `mcp__agentide__ide_run` becomes `ide_run`. The
 * prefix is stripped, never the name. */
function plainName(name: string | undefined): string {
  return (name ?? "tool").replace(/^mcp__[^_]+__/, "");
}

/** The head of a tool's answer: enough to see what happened, not the whole of it. */
function firstLines(text: string | undefined, limit: number): string {
  const lines = (text ?? "").trim().split("\n");
  const head = lines.slice(0, limit).join("\n     ");
  return lines.length > limit ? `${head}\n     … ${lines.length - limit} more lines` : head;
}

/** A tool's arguments, short enough to sit on the call. */
function brief(input: JsonObject | undefined): string {
  const command = input?.command ?? input?.file_path ?? input?.path ?? input?.pattern;
  if (typeof command !== "string") return "";
  const flat = command.replace(/\s+/g, " ").trim();
  return `(${flat.length > 60 ? `${flat.slice(0, 59)}…` : flat})`;
}

/** The line above and below the input. The box is the one piece of Claude Code's layout that
 * does real work: after forty lines of tool output it is how you find the cursor. */
function rule(kind: "top" | "bottom", terminal: number): string {
  const inner = boxWidth(terminal) - 2;
  return paint.dim(kind === "top" ? `╭${"─".repeat(inner)}╮` : `╰${"─".repeat(inner)}╯`);
}

/** One width for every box -- two of them differing reads as a rendering fault. Capped, because
 * a box across a 200-column terminal is a line with a corner on it. */
function boxWidth(terminal: number): number {
  return Math.max(24, Math.min(terminal - 1, 100));
}

/** Draws the menu by wrapping readline's private `_ttyWrite`: `completer` only fires on Tab and a
 * `keypress` listener runs beside readline, so Up would both move the selection and recall history. */
function attachMenu(
  rl: Interface,
  commands: () => SlashCommand[],
): { detach: () => void; refresh: () => void; open: () => void; above: (text: string) => void } {
  const out = process.stdout;
  const editor = rl as Interface & { _ttyWrite?: (s: string, key: Key) => void };
  const original = editor._ttyWrite;
  if (!process.stdin.isTTY || !out.isTTY || typeof original !== "function") {
    // No cursor to draw around. The prompt is still printed, just without its box.
    return {
      detach: () => {},
      refresh: () => {},
      open: () => rl.prompt(),
      above: (text) => void out.write(text.endsWith("\n") ? text : `${text}\n`),
    };
  }

  let menu: Menu | null = null;
  /** Rows currently drawn below the input line, so they can be erased exactly. */
  let drawn = 0;
  /** Set by Escape, cleared by the next edit: a dismissed menu must stay dismissed. */
  let dismissed = false;
  /** True while this function is driving readline, so its writes do not recurse. */
  let echoing = false;

  const line = (): string => (rl as unknown as { line: string }).line;
  // The prompt is coloured, so its escapes are bytes the cursor never moves over. Readline
  // measures it the same way; `String.length` here would put the caret four columns right.
  const caret = (): number =>
    visibleWidth(rl.getPrompt()) + (rl as unknown as { cursor: number }).cursor;

  function erase(): void {
    if (drawn === 0) return;
    // Down one, wipe everything below, come back. `clearScreenDown` from the row under the
    // input is exactly the menu and nothing else, because nothing else is ever there.
    moveCursor(out, 0, 1);
    cursorTo(out, 0);
    clearScreenDown(out);
    moveCursor(out, 0, -1);
    cursorTo(out, caret());
    drawn = 0;
  }

  /** Everything below the input line: bottom edge, then the menu. One writer for both, because
   * rows written is rows the cursor comes back up, and two writers would disagree. */
  function draw(): void {
    const terminal = out.columns || 100;
    const body: string[] = [rule("bottom", terminal)];
    // A wrapped input line makes every row count below it wrong and the menu ends up drawn
    // over the prompt. Short lines are the only ones that open a menu anyway.
    if (menu && !dismissed && caret() < terminal) {
      body.push(...rows(menu, { terminal: boxWidth(terminal), height: height(), theme: paint }));
    }
    erase();
    // The right edge, painted onto the row readline just drew -- it cannot be part of the
    // prompt, which is a prefix. Skipped once the text reaches it.
    const edge = boxWidth(terminal) - 1;
    if (caret() < edge) {
      cursorTo(out, edge);
      out.write(paint.dim("│"));
      cursorTo(out, caret());
    }
    // A newline, not `moveCursor` down: at the bottom of the screen this scrolls and the input
    // line scrolls with it. `moveCursor` refuses to scroll and every row overwrites the last.
    out.write(`\n${body.join("\n")}`);
    moveCursor(out, 0, -body.length);
    cursorTo(out, caret());
    drawn = body.length;
  }

  /** Print something that arrived on its own, above the prompt rather than across it: a plain
   * write lands halfway through the input line. The box comes down and goes back, text intact. */
  function above(text: string): void {
    erase();
    // The input line and the top rule, in that order: `clearLine` only clears the row the
    // cursor is on, and the rule is the row before it.
    cursorTo(out, 0);
    clearLine(out, 0);
    moveCursor(out, 0, -1);
    cursorTo(out, 0);
    clearLine(out, 0);
    out.write(text.endsWith("\n") ? text : `${text}\n`);
    out.write(`${rule("top", out.columns || 100)}\n`);
    // `true` keeps what was typed: it refreshes the line instead of starting a new one.
    rl.prompt(true);
    draw();
  }

  /** Start a fresh prompt: top edge, input line, everything below. The only `rl.prompt()` in the
   * interactive path -- the edge must print immediately before its line or the box has no lid. */
  function open(): void {
    out.write(`${rule("top", out.columns || 100)}\n`);
    rl.prompt();
    menu = null;
    dismissed = false;
    drawn = 0;
    draw();
  }

  /** Rows to offer, never more than the terminal can hold above the prompt. */
  function height(): number {
    return Math.max(1, Math.min(MENU_HEIGHT, (out.rows || 24) - 3));
  }

  function refresh(): void {
    menu = menuFor(line(), commands());
    draw();
  }

  /** Replace what is typed, through readline, so its own state stays true. */
  function replace(text: string): void {
    echoing = true;
    try {
      // Both halves: Ctrl+U clears to the left of the cursor and Ctrl+K to the right, and
      // a menu opened with the cursor mid-line would otherwise leave the tail behind.
      rl.write(null, { ctrl: true, name: "u" });
      rl.write(null, { ctrl: true, name: "k" });
      rl.write(text);
    } finally {
      echoing = false;
    }
  }

  editor._ttyWrite = (s: string, key: Key = {} as Key): void => {
    if (echoing) return original.call(rl, s, key);

    if (menu && !dismissed) {
      if (key.name === "up" || key.name === "down") {
        menu = move(menu, key.name === "down" ? 1 : -1, height());
        draw();
        return;
      }
      if (key.name === "escape") {
        dismissed = true;
        erase();
        return;
      }
      if (key.name === "tab" || key.name === "return" || key.name === "enter") {
        const { line: chosen, submit } = accept(menu);
        erase();
        menu = null;
        replace(chosen);
        // Tab fills the line; Enter runs a command that needs no argument, because
        // choosing it was already the decision.
        if (key.name !== "tab" && submit) return original.call(rl, "\r", { name: "return" } as Key);
        refresh();
        return;
      }
    }

    // Erased before readline is told: both move the cursor off the input line first, and
    // `clearScreenDown` would then start a row too low and orphan the menu's top line.
    if (key.name === "return" || key.name === "enter" || (key.ctrl && key.name === "c")) {
      erase();
      menu = null;
      dismissed = false;
      original.call(rl, s, key);
      // Readline has just printed the newline, so this closes the box around what was
      // sent. Without it the transcript is a column of lids with no floors.
      if (key.name !== "c") out.write(`${rule("bottom", out.columns || 100)}\n`);
      return;
    }

    original.call(rl, s, key);
    // Any edit un-dismisses: Escape hides the menu for the line as it stands, not for the
    // rest of the session.
    if (key.name !== "escape") dismissed = false;
    refresh();
  };

  return {
    refresh,
    open,
    above,
    detach: () => {
      erase();
      editor._ttyWrite = original;
    },
  };
}

/**
 * Hand the terminal to the real `claude` binary so the browser flow can run.
 *
 * Spawned with the terminal inherited rather than piped: signing in is a device code the
 * person reads and a browser they use, and a captured stdio would show neither. This
 * blocks until they are done, which is correct — there is nothing to do until they are.
 */
function signIn(): void {
  if (signedIn()) {
    process.stdout.write(`  ${paint.accent("already signed in")}\n`);
    process.stdout.write(paint.dim("  /login again only if you want to switch account\n"));
    return;
  }
  const binary = claudeBinary();
  if (!binary) {
    process.stdout.write(paint.danger("  the bundled Claude Code binary is missing\n"));
    process.stdout.write(paint.dim("  reinstall agentide; the installer ships it\n"));
    return;
  }
  process.stdout.write(paint.dim("  handing over to Claude Code to sign in…\n"));
  const done = spawnSync(binary, ["/login"], { stdio: "inherit", windowsHide: false });
  if (done.error) {
    process.stdout.write(paint.danger(`  could not start it: ${done.error.message}\n`));
    return;
  }
  process.stdout.write(
    signedIn()
      ? `  ${paint.accent("signed in")} — the next turn will run\n`
      : paint.dim("  still not signed in; /login again, or set ANTHROPIC_API_KEY\n"),
  );
}

/** Print what is wrong with this machine. `all` also prints the clean bill of health. */
function report(problems: readonly Problem[], all: boolean): void {
  if (problems.length === 0) {
    if (all) process.stdout.write(`  ${paint.accent("ready")} — nothing missing\n`);
    return;
  }
  for (const problem of problems) {
    const mark = problem.severity === "blocked" ? paint.danger("✗") : paint.dim("!");
    process.stdout.write(`  ${mark} ${problem.title}\n`);
    process.stdout.write(`    ${paint.dim(problem.fix)}\n`);
  }
}

/** `/provider` lists the backends; a number or a key picks one. An unknown key is refused
 * here rather than a turn later, and `anthropic` is a row so there is a way back. */
function chooseProvider(
  argument: string,
  options: Options,
  providers: readonly ProviderInfo[],
): void {
  if (!argument) {
    process.stdout.write(
      `${providerRows(providers, options.provider, paint, process.stdout.columns || 100).join("\n")}\n`,
    );
    process.stdout.write(paint.dim("  /provider <n> or /provider <key> to switch\n"));
    return;
  }

  const rows = [CLOUD, ...providers.map((provider) => provider.key)];
  const picked = Number(argument);
  const named = Number.isInteger(picked) ? rows[picked - 1] : undefined;
  if (Number.isInteger(picked) && !named) {
    process.stdout.write(paint.dim(`  there is no ${picked}; the list has ${rows.length}\n`));
    return;
  }

  if (named) return void switchTo(named, options);

  const { chosen, suggestion } = pickProvider(argument, providers);
  if (chosen) return void switchTo(chosen === CLOUD ? CLOUD : chosen.key, options);
  const near = suggestion
    ? ` Did you mean ${paint.accent(suggestion === CLOUD ? CLOUD : suggestion.key)}?`
    : "";
  process.stdout.write(
    `  ${paint.danger(`"${argument}" is not a backend in ~/.agentide/providers.json.`)}${near}\n`,
  );
  process.stdout.write(paint.dim("  /provider on its own lists them\n"));
}

/** Set the backend, or clear it, which is what choosing the cloud means. */
function switchTo(key: string, options: Options): void {
  if (key === CLOUD) {
    delete options.provider;
    process.stdout.write(`  next turns run on ${paint.accent(CLOUD)}\n`);
    return;
  }
  options.provider = key;
  process.stdout.write(`  next turns run on ${paint.accent(key)}\n`);
}

/** `/model` lists; a number or a name picks one. An unknown name is refused here, not a
 * turn later from inside the SDK. Before the catalogue lands, names are taken on trust. */
function chooseModel(
  argument: string,
  options: Options,
  models: readonly ModelInfo[],
): void {
  if (!argument) {
    if (models.length === 0) {
      process.stdout.write(`  ${options.model ?? "default model"}\n`);
      process.stdout.write(paint.dim("  the model list arrives a moment after startup\n"));
      return;
    }
    process.stdout.write(`${modelRows(models, options.model, paint, process.stdout.columns || 100).join("\n")}\n`);
    process.stdout.write(paint.dim("  /model <n> or /model <id> to switch\n"));
    return;
  }

  // A bare number is a row from the list just printed; the numbers are why the list is
  // never reordered.
  const picked = Number(argument);
  if (Number.isInteger(picked) && models.length > 0) {
    const entry = models[picked - 1];
    if (!entry) {
      process.stdout.write(paint.dim(`  there is no ${picked}; the list has ${models.length}\n`));
      return;
    }
    options.model = entry.value;
    process.stdout.write(`  next turns run on ${paint.accent(entry.displayName)}\n`);
    return;
  }

  if (models.length === 0) {
    options.model = argument;
    process.stdout.write(`  next turns run on ${argument}\n`);
    return;
  }

  const { chosen, suggestion } = pickModel(argument, models);
  if (chosen) {
    options.model = chosen.value;
    process.stdout.write(`  next turns run on ${paint.accent(chosen.displayName)}\n`);
    return;
  }
  const near = suggestion ? ` Did you mean ${paint.accent(suggestion.value)}?` : "";
  process.stdout.write(
    `  ${paint.danger(`"${argument}" is not a model this installation has.`)}${near}\n`,
  );
  process.stdout.write(paint.dim("  /model on its own lists them\n"));
}

/** `/resume` lists; `/resume 3` continues the third. Two steps because the id is a UUID,
 * and the list is kept between them so the number still means the row it named. */
async function resume(
  argument: string,
  options: Options,
  recent: PastConversation[],
): Promise<void> {
  if (!argument) {
    const found = await listConversations(options.cwd);
    recent.length = 0;
    recent.push(...found);
    if (found.length === 0) {
      process.stdout.write(paint.dim("  no past conversations in this folder\n"));
      return;
    }
    const width = String(found.length).length;
    for (const [index, entry] of found.entries()) {
      const number = paint.accent(String(index + 1).padStart(width));
      const when = paint.dim(ago(entry.updatedMs).padEnd(8));
      process.stdout.write(`  ${number}  ${when}  ${entry.opening}\n`);
    }
    process.stdout.write(paint.dim(`  /resume <n> to continue one of these\n`));
    return;
  }

  const picked = Number(argument);
  // A number is a row from the list just printed; anything else is taken as an id, so a
  // conversation named by something other than this menu still works.
  if (!Number.isInteger(picked)) {
    options.resume = argument;
    process.stdout.write(paint.dim(`  continuing ${argument}\n`));
    return;
  }
  if (recent.length === 0) {
    process.stdout.write(paint.dim("  run /resume on its own first, to see the list\n"));
    return;
  }
  const entry = recent[picked - 1];
  if (!entry) {
    process.stdout.write(paint.dim(`  there is no ${picked}; the list has ${recent.length}\n`));
    return;
  }
  options.resume = entry.id;
  process.stdout.write(`  ${paint.dim("continuing")} ${entry.opening}\n`);
}

/** Print the commands, and say when the list is still only half of itself — before the
 * warm-up answers it is six the CLI wrote, which bare would read as all there is. */
function list(matches: readonly SlashCommand[], beforeFirstTurn: boolean): void {
  if (matches.length === 0) {
    process.stdout.write("  nothing matches that\n");
    return;
  }
  process.stdout.write(`${format(matches, process.stdout.columns || 100).join("\n")}\n`);
  if (beforeFirstTurn) {
    process.stdout.write("  (the installation's own commands arrive with the first turn)\n");
  }
}

/** The commands this program answers itself. Each mutates `options`, which the next turn
 * reads; with no argument they report rather than clear. */
async function handleLocal(
  name: string,
  input: string,
  options: Options,
  recent: PastConversation[],
  models: readonly ModelInfo[],
  providers: readonly ProviderInfo[],
): Promise<void> {
  const argument = input.replace(/^\/\S+\s*/, "").trim();
  switch (name) {
    case "help":
      list(allCommands([]), false);
      return;
    case "resume":
      await resume(argument, options, recent);
      return;
    case "login":
      signIn();
      return;
    case "doctor":
      report(checkup(), true);
      return;
    case "model":
      chooseModel(argument, options, models);
      return;
    case "provider":
      chooseProvider(argument, options, providers);
      return;
    case "cwd":
      if (argument) options.cwd = resolve(options.cwd, argument).replace(/\\/g, "/");
      process.stdout.write(`  ${options.cwd}\n`);
      return;
    case "verbose":
      options.verbose = !options.verbose;
      process.stdout.write(`  tool calls ${options.verbose ? "shown" : "hidden"}\n`);
      return;
    default:
      return;
  }
}

void main();
