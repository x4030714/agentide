/**
 * The agent in a terminal: `agentide run "<prompt>"`.
 *
 * The desktop app is three processes and a webview, and on a machine with 16GB that is
 * sometimes the difference between the agent running and the OS killing something. This is
 * the same agent, the same session, the same providers and memory -- with no window.
 *
 * ## It is the host, in this process
 *
 * The sidecar does not answer its own `ide_*` calls; a host does, over stdio, and in the
 * desktop app that host is the Rust core forwarding to the webview. Rather than spawn a
 * second process and talk to itself, this constructs the `HostLink` with a writer that
 * hands each outbound message straight back: a tool call is answered here and settled with
 * `link.settle`, and events are printed. One process, no protocol on the wire, and the
 * same `Session` the app uses.
 *
 * ## It declares only what it can answer
 *
 * Nine of the fifteen `ide_*` tools are questions for a language server and three are
 * instructions to an editor. There is neither here. Those are not declared at all rather
 * than declared and refused: a tool the model can see and call that always fails is broken
 * forever and silently, and it costs its description in every prompt on the way. What is
 * left is the terminal, which is real -- and `Read`, `Edit` and the rest still come from
 * the SDK's own preset, so this is not a crippled agent, it is one without an IDE attached.
 */

import { spawn } from "node:child_process";
import { clearLine, clearScreenDown, createInterface, cursorTo, moveCursor } from "node:readline";
import type { Interface, Key } from "node:readline";
import { resolve } from "node:path";

import { HostLink } from "./host.ts";
import { ModelCatalogue } from "./models.ts";
import { allCommands, complete, format, lookup } from "./cli-commands.ts";
import { accept, MENU_HEIGHT, menuFor, move, rows } from "./cli-menu.ts";
import { pad, theme, width as visibleWidth } from "./cli-theme.ts";
import type { Theme } from "./cli-theme.ts";
import type { Menu } from "./cli-menu.ts";
import type { JsonObject, SidecarMessage, SlashCommand, ToolResult } from "./protocol.ts";
import { Session } from "./session.ts";

/**
 * The `ide_*` tools a terminal can honestly answer.
 *
 * `ide_run` is the agent's shell and the reason `Bash` is disallowed; the other two read
 * and stop what it started. Everything else needs an editor or a language server.
 */
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

/**
 * Run one command and report it the way `ide_run` does in the app.
 *
 * Through the shell, because that is what the tool promises: the model writes a command
 * line, not an argv. Output is captured rather than streamed to the terminal -- it is the
 * tool's answer, and interleaving it with the assistant's prose would make neither
 * readable.
 */
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
  /**
   * Redraw an open menu. Replaced by `repl` once there is one to redraw.
   *
   * The list arrives a second or two after the prompt appears, and someone who typed `/`
   * inside that window would otherwise sit looking at six commands with no reason to press
   * a key -- the menu would be stale and look final.
   */
  const menuHook = { refresh: () => {} };

  /**
   * The host, as a function.
   *
   * Every message the session would have written to stdout arrives here instead. Tool
   * calls are answered and settled; permission requests are allowed, because a terminal
   * the person is watching and chose to run is not a place to ask -- the app is where
   * approval lives, and this is the deliberate other mode.
   */
  const link: HostLink = new HostLink((line: string) => {
    // Not schema-checked: this line was encoded by the link a microsecond ago, and
    // validating our own output would buy nothing. The wire format is still the wire
    // format -- going through it rather than around it is what keeps this host the same
    // shape as the Rust one.
    void handle(JSON.parse(line) as SidecarMessage);
  });

  async function handle(message: SidecarMessage): Promise<void> {
    switch (message.t) {
      case "tool_call": {
        const result = await answer(message.name, message.args, options.cwd);
        // The call itself is printed from the assistant's own message, so this prints only
        // what came back -- under it, the way the app's transcript nests a result beneath
        // the call it answers. A failure is shown whether or not `--verbose` asked, because
        // a tool that failed is the reason the next thing the model says looks wrong.
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
        // The list lives on a live query, so it lands when the warm-up's query finishes
        // connecting -- and again if the installation pushes a new one mid-session, which
        // it does when skills are discovered in a subdirectory.
        agentCommands = message.commands;
        menuHook.refresh();
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

  /**
   * The assistant's prose, and nothing else unless asked.
   *
   * A bullet in the accent colour opens each block and its continuation lines are indented
   * under it, so a four-paragraph answer reads as one answer rather than as four. Tool
   * calls get the same bullet in dim with their arguments after the name -- the shape the
   * app's transcript uses, and the shape anyone arriving from Claude Code already reads.
   */
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

  /**
   * What the next turn runs with, read fresh each time.
   *
   * Built per turn rather than once, because `/model` and `/provider` change `options`
   * mid-session -- captured at startup they were reported as changed and then ignored,
   * which is the silent-success failure this project keeps paying for.
   */
  const promptOptions = () => ({
    ...(options.model ? { model: options.model } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    // Edits land. There is nobody to review them here, and a terminal that asked would
    // hang on a question with no answer.
    permissionMode: "acceptEdits" as const,
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
    await turn(options.prompt);
    session.dispose();
    process.exit(failed ? 1 : 0);
  }

  // Interactive only, and not awaited. `/` has to offer every command the installation
  // has, and that list only exists on a live query -- so the query is built now, with the
  // same shape the first turn will ask for, instead of the menu being six entries long
  // until a turn has been spent. It costs the CLI spawn that turn would have paid anyway.
  void session.warm(options.cwd, promptOptions());

  await repl(turn, options, session, () => agentCommands, menuHook);
}

/**
 * The interactive mode: `agentide` with nothing after it.
 *
 * One session for the whole conversation, which is the point. The query behind it stays
 * alive between turns -- ~2.5s of CLI startup and every MCP server, paid once -- so the
 * second prompt reaches the model in milliseconds where a fresh process would pay it all
 * again. That is the same reason the app keeps one, and it is worth more here: a terminal
 * is where people ask six short questions in a row.
 */
async function repl(
  turn: (text: string) => Promise<void>,
  options: Options,
  session: Session,
  known: () => SlashCommand[],
  menuHook: { refresh: () => void },
): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${paint.dim("│")} ${paint.accent(">")} `,
    // Tab completes a slash command and nothing else; see `complete`. Kept for the piped
    // case, where there is no live menu to Tab into.
    completer: (line: string) => complete(line, allCommands(known())),
  });
  const menu = attachMenu(rl, () => allCommands(known()));
  menuHook.refresh = menu.refresh;
  const release = captureWarnings(menu.above);
  process.stdout.write(`${banner(options)}\n`);
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
        handleLocal(exact.name, text, options);
        menu.open();
        continue;
      }
      // No exact match means this is a search, not a command: show what it found rather
      // than sending something the agent will reject. With a live menu this is only
      // reached on a name that matched nothing, or when input is piped and there is no
      // menu at all.
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
  session.dispose();
  process.exit(0);
}

/**
 * Send everything written to stderr above the prompt instead of through it.
 *
 * The warnings are worth keeping -- "MCP server github was ignored, ${GITHUB_TOKEN} is not
 * set" is exactly what someone needs to know -- but they arrive seconds after the prompt is
 * drawn, from the warm-up, from a turn, from the SDK. Writing them straight out lands them
 * inside the input box. This is the one place that knows how to move it out of the way.
 *
 * One warning is dropped rather than moved: the SDK's `CAN_USE_TOOL_SHADOWED`. It fires
 * because the CLI auto-approves its three tools on purpose -- there is no one at a terminal
 * to ask -- so it reports a decision rather than a problem, on every single start.
 */
function captureWarnings(above: (text: string) => void): () => void {
  const original = process.stderr.write.bind(process.stderr);
  const shadowed = /CAN_USE_TOOL_SHADOWED|trace-warnings/;
  // The MCP and provider configs are re-read every turn on purpose, so an unset
  // `${GITHUB_TOKEN}` is reported every turn. Said once it is useful; said before every
  // answer it is what the person learns to scroll past.
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

/**
 * The welcome box.
 *
 * It answers the three questions someone opening a terminal agent has -- where am I, what
 * is going to run, and how do I find anything -- and then gets out of the way. Everything
 * in it is a fact about this session, so there is nothing to read twice.
 */
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

/**
 * A glyph, then text whose later lines line up under the first.
 *
 * Without the indent a wrapped paragraph starts hard against the left margin and the
 * bullet stops meaning anything -- it has to mark a block, not a line.
 */
function bullet(glyph: string, text: string): string {
  const [first = "", ...rest] = text.split("\n");
  return [`${glyph} ${first}`, ...rest.map((line) => `  ${line}`)].join("\n");
}

/**
 * The little markdown the model actually uses in a sentence.
 *
 * Only `**bold**` and `` `code` ``, and only because leaving them raw is worse than either
 * rendering or stripping them -- "the repo is on the **master** branch" is the model
 * emphasising a word, and the asterisks are noise it did not intend. Everything else is
 * left alone: this is a terminal, not a markdown renderer, and half-rendering headings and
 * lists would be its own kind of wrong.
 */
function emphasis(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, (_, inner: string) => paint.bold(inner))
    .replace(/`([^`\n]+)`/g, (_, inner: string) => paint.accent(inner));
}

/**
 * A tool's name as the model would say it out loud.
 *
 * `mcp__agentide__ide_run` is how the SDK addresses it and there is no reason to make
 * anyone read the routing. The prefix is stripped, never the name.
 */
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

/**
 * The line above and below the input.
 *
 * The prompt is a box because that is the one piece of Claude Code's layout that does real
 * work: it separates what you are writing from everything already written, which in a
 * terminal that has just printed forty lines of tool output is the difference between
 * finding the cursor and hunting for it.
 */
function rule(kind: "top" | "bottom", terminal: number): string {
  const inner = boxWidth(terminal) - 2;
  return paint.dim(kind === "top" ? `╭${"─".repeat(inner)}╮` : `╰${"─".repeat(inner)}╯`);
}

/**
 * How wide every box is.
 *
 * One function, because the welcome box and the prompt box are read as the same object and
 * two different widths look like a rendering fault rather than a choice. Capped, because a
 * box drawn across a 200-column terminal is a line with a corner on it.
 */
function boxWidth(terminal: number): number {
  return Math.max(24, Math.min(terminal - 1, 100));
}

/**
 * Draw the command menu under the prompt as the line is typed.
 *
 * `_ttyWrite` is readline's own key handler and this wraps it. There is no public hook: a
 * `completer` fires only on Tab, and a `keypress` listener on stdin runs *beside*
 * readline's rather than in front of it, so Up would move the selection and recall history
 * at the same time. Wrapping is the only place a key can be taken before readline sees it.
 * The underscore says it is not public API; it has been stable for a decade and the
 * fallback below covers it being gone.
 *
 * Does nothing unless stdin is a TTY. Piped input has no cursor to draw around, and the
 * REPL's own `/` handling answers there.
 */
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

  /**
   * Everything below the input line: the box's bottom edge, then the menu if it is open.
   *
   * One writer for both, because they share the same arithmetic -- the count of rows
   * written is the count the cursor has to come back up -- and two writers would each be
   * right on their own and wrong together.
   */
  function draw(): void {
    const terminal = out.columns || 100;
    const body: string[] = [rule("bottom", terminal)];
    // A wrapped input line makes every row count below it wrong and the menu ends up drawn
    // over the prompt. Short lines are the only ones that open a menu anyway.
    if (menu && !dismissed && caret() < terminal) {
      body.push(...rows(menu, { terminal: boxWidth(terminal), height: height(), theme: paint }));
    }
    erase();
    // The box's right edge, painted onto the row readline has just finished drawing. It
    // cannot be part of the prompt -- that is a prefix -- and it is skipped once what is
    // typed reaches it, because the text is worth more than the border.
    const edge = boxWidth(terminal) - 1;
    if (caret() < edge) {
      cursorTo(out, edge);
      out.write(paint.dim("│"));
      cursorTo(out, caret());
    }
    // A newline rather than `moveCursor` down: at the bottom of the screen this scrolls,
    // and the input line scrolls with it, so moving back up by the same count still lands
    // on it. `moveCursor` would refuse to scroll and every row would overwrite the last.
    out.write(`\n${body.join("\n")}`);
    moveCursor(out, 0, -body.length);
    cursorTo(out, caret());
    drawn = body.length;
  }

  /**
   * Print something that arrived on its own, above the prompt rather than across it.
   *
   * The warm-up's config warnings land a few seconds after the box is drawn, and a plain
   * write puts them halfway through the input line -- the box's left edge, then a warning,
   * then whatever was being typed, on one row. So the box is taken down, the line is
   * printed, and the box goes back with what was typed still in it.
   */
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

  /**
   * Start a fresh prompt: the box's top edge, the input line, and whatever goes below it.
   *
   * `rl.prompt()` is not called anywhere else in the interactive path. The top edge has to
   * be printed immediately before the line it belongs to, and a bare `rl.prompt()` would
   * leave a box with no lid.
   */
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
        // Tab fills the line and leaves the cursor there; Enter on a command that needs no
        // argument runs it, because choosing it *was* the decision and asking for a second
        // Enter would only be a chance to change your mind about something already read.
        if (key.name !== "tab" && submit) return original.call(rl, "\r", { name: "return" } as Key);
        refresh();
        return;
      }
    }

    // Erased before readline is told, not after. Both of these move the cursor off the
    // input line first -- Enter prints a newline, Ctrl+C prints one and exits -- and by
    // then `clearScreenDown` starts a row too low and leaves the menu's first line behind
    // as garbage under the answer.
    if (key.name === "return" || key.name === "enter" || (key.ctrl && key.name === "c")) {
      erase();
      menu = null;
      dismissed = false;
      original.call(rl, s, key);
      // Readline has just printed the newline, so the cursor is on the row under the input
      // and this closes the box around what was sent. Without it the transcript is a
      // column of lids: every prompt keeps its top edge and loses its bottom one.
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
 * Print the commands, saying when the list is still only half of itself.
 *
 * The caveat is not decoration. Before the first turn this list is six entries the CLI
 * wrote itself, and showing it bare would say the installation has no commands rather
 * than that it has not been asked yet.
 */
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

/**
 * The commands this program answers rather than sending on.
 *
 * Each mutates `options`, which the next turn reads — `/model` here changes what runs, not
 * what a transcript says ran. `/model` and `/provider` with no argument report rather than
 * clear: emptying them by typing the name alone is a way to lose a local backend without
 * being told.
 */
function handleLocal(name: string, input: string, options: Options): void {
  const argument = input.replace(/^\/\S+\s*/, "").trim();
  switch (name) {
    case "help":
      list(allCommands([]), false);
      return;
    case "model":
      if (!argument) return void process.stdout.write(`  ${options.model ?? "default"}\n`);
      options.model = argument;
      process.stdout.write(`  next turns run on ${argument}\n`);
      return;
    case "provider":
      if (!argument) return void process.stdout.write(`  ${options.provider ?? "anthropic"}\n`);
      options.provider = argument;
      process.stdout.write(`  next turns run on ${argument}\n`);
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
