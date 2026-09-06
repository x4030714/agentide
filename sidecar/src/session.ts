/**
 * One conversation: drives `query()` and turns `SDKMessage`s into protocol events.
 *
 * A session survives across prompts, and so does the query behind it. `query()` spawns
 * the Claude Code CLI and every MCP server with it -- measured at ~2.5s before the model
 * is reached, plus ~1.8s for each external server -- so calling it per prompt made the
 * sixth turn pay exactly what the first one did, none of it model time. In
 * streaming-input mode one call stays alive and takes its prompts from an async iterable,
 * and that cost is paid once.
 *
 * The conversation is still ours to carry. The SDK's own session id is learned from the
 * first message it produces and fed back as `resume`, because the query has to be rebuilt
 * whenever an option fixed at construction changes, and the rebuilt one must continue the
 * same transcript. `queryFingerprint` is the list of options that means.
 */

import {
  query,
  type McpServerConfig,
  type Options,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { HostLink } from "./host.ts";
import { createIdeServer, IDE_SERVER_NAME, ideToolNames } from "./ide-tools.ts";
import { loadMcpServers } from "./mcp-config.ts";
import { loadMemoryConfig, memorySettings } from "./memory-config.ts";
import { ModelCatalogue } from "./models.ts";
import { createPermissionHandler } from "./permissions.ts";
import type { DoneReason, JsonObject, PromptOptions } from "./protocol.ts";

/** Used when the host does not name one. */
export const DEFAULT_MODEL = "claude-opus-5";

/**
 * What the SDK does when `permissionMode` is unset. Named so that an unset mode and an
 * explicit `default` compare equal -- otherwise the first turn to spell it out would look
 * like a mode change and cost a control request for nothing.
 */
const DEFAULT_PERMISSION_MODE: PermissionMode = "default";

/**
 * How long an interrupt has to close the turn before the query is taken down.
 *
 * An interrupt normally ends the turn with an ordinary result message and leaves the
 * query usable. When it does not, the turn's promise never settles and every prompt
 * queued behind it waits on a turn that cannot end. One spawn is cheaper than a session
 * that silently accepts prompts it will never run.
 */
const INTERRUPT_GRACE_MS = 5_000;

/**
 * Everything a query is built from that it cannot be told about afterwards.
 *
 * `options` is the whole `PromptOptions` on purpose: the fields a live query *can* be
 * retuned for are skipped by `queryFingerprint` rather than kept out of here, so adding a
 * prompt option means deciding once, in one place, which side of the line it falls on.
 */
export interface QueryShape {
  cwd: string;
  /** The transcript this turn must run in. `undefined` starts a new one. */
  conversation: string | undefined;
  /** The inline settings block -- the memory configuration -- or null when it is off. */
  settings: Record<string, unknown> | null;
  options?: PromptOptions;
}

/**
 * The parts of a shape that a running query cannot be told about, as one comparable
 * string. Two turns with the same fingerprint can share a query; a difference is a
 * rebuild, which is a CLI spawn and every MCP server with it.
 *
 * `model`, `permissionMode` and the MCP server set are deliberately absent: `Query` has
 * `setModel`, `setPermissionMode` and `setMcpServers`, so those cost a control request
 * rather than a process. Everything below is read by the CLI as it starts and only takes
 * effect in a new one -- a query kept across such a change would run the turn with the
 * old value while the UI showed the new one, which is the worst of both.
 *
 * `maxTurns` and `includePartialMessages` are here for that reason and not because the
 * plan named them: neither has a setter, so neither can land on a live query.
 *
 * An array rather than an object, so the field order is this function's and not the key
 * order of whatever literal a caller happened to build.
 */
export function queryFingerprint(shape: QueryShape): string {
  const options = shape.options;
  return JSON.stringify([
    shape.cwd,
    shape.conversation ?? null,
    // No default: an unset effort is the SDK's own, and there is no setter for it.
    options?.effort ?? null,
    // Trimmed to match `#options`, which omits an empty append entirely. Otherwise
    // clearing the tuned prompt to whitespace would spawn a CLI to change nothing.
    options?.systemPromptAppend?.trim() || null,
    options?.allowedTools ?? null,
    options?.disallowedTools ?? null,
    options?.maxTurns ?? null,
    options?.includePartialMessages ?? null,
    shape.settings,
  ]);
}

/** How a turn ended, as the consumer loop saw it. */
interface Outcome {
  reason: DoneReason;
  error?: string;
}

/** A running `query()`, and what is needed to decide whether the next turn can use it. */
interface LiveQuery {
  query: Query;
  /** The prompts it has not taken yet. Ending this closes the CLI's stdin. */
  queue: PromptQueue;
  /** What it was built with. `conversation` is refreshed as the SDK reports its id. */
  built: QueryShape;
  /** What `setModel` and `setPermissionMode` were last told. */
  model: string;
  permissionMode: PermissionMode;
  /** The external servers `setMcpServers` was last told, as a comparable string. */
  servers: string;
  /** Its `agentide` server, held so `setMcpServers` can hand the same one back. */
  ide: McpServerConfig;
}

export class Session {
  readonly #link: HostLink;
  readonly #sessionId: string;
  /** Shared with every session: the catalogue belongs to the process, not the turn. */
  readonly #models: ModelCatalogue;
  /** Turns run one at a time; a prompt arriving mid-turn queues behind this. */
  #chain: Promise<void> = Promise.resolve();
  /** The SDK's session id, learned from its messages and replayed as `resume`. */
  #resumeId: string | undefined;
  /** The conversation the host last asked to resume; see `#runTurn` for why it is kept. */
  #resumed: string | undefined;
  /** The query these turns run on, or null when the next prompt has to build one. */
  #live: LiveQuery | null = null;
  /** The turn waiting for its `result`. At most one: `#chain` serializes them. */
  #pending: { live: LiveQuery; settle: (outcome: Outcome) => void } | null = null;
  /** Set by `interrupt`, cleared when the turn it applies to reports `done`. */
  #interrupted = false;
  /** Set by `interrupt` and `dispose`; makes queued prompts finish without running. */
  #cancelled = false;

  constructor(link: HostLink, sessionId: string, models: ModelCatalogue) {
    this.#link = link;
    this.#sessionId = sessionId;
    this.#models = models;
  }

  /** Queue a turn. Resolves when it has finished and its `done` has been sent. */
  prompt(cwd: string, text: string, options?: PromptOptions): Promise<void> {
    this.#chain = this.#chain.then(() => this.#runTurn(cwd, text, options));
    return this.#chain;
  }

  /**
   * Stop the running turn and drop anything queued behind it.
   *
   * Also fails this session's outstanding permission and tool requests: the host is not
   * going to answer questions for a turn the user just cancelled, and leaving them
   * pending would keep the SDK waiting after the interrupt landed.
   */
  async interrupt(): Promise<void> {
    this.#cancelled = true;
    this.#interrupted = true;
    this.#link.failSession(this.#sessionId, "the turn was interrupted");
    const pending = this.#pending;
    // The query outlives the turn now, so a turn in flight is what `#pending` says, not
    // whether a query exists. Interrupting an idle one would abort nothing and put a
    // working session at risk to do it.
    if (!pending) return;
    try {
      await pending.live.query.interrupt();
    } catch (error) {
      // The turn may have ended between the check and the call; that is the outcome we
      // wanted anyway.
      warn(`interrupt on ${this.#sessionId} failed: ${describe(error)}`);
    }

    const timer = setTimeout(() => {
      if (this.#pending !== pending) return;
      // See INTERRUPT_GRACE_MS. The query is not answering for this turn, so it is not
      // trusted with the next one either.
      warn(`the interrupt on ${this.#sessionId} did not end the turn; dropping the query`);
      this.#settle(pending.live, { reason: "interrupted" });
      this.#retire(pending.live);
    }, INTERRUPT_GRACE_MS);
    // A watchdog must not be the reason the process stays alive.
    timer.unref();
  }

  /** Tear down without reporting anything. Used when the host goes away. */
  dispose(): void {
    this.#cancelled = true;
    if (this.#live) this.#retire(this.#live);
  }

  async #runTurn(cwd: string, text: string, options?: PromptOptions): Promise<void> {
    if (this.#cancelled) {
      // Queued behind a turn that was interrupted; report it rather than silently
      // dropping a prompt the user typed.
      this.#cancelled = false;
      this.#interrupted = false;
      this.#link.send({ t: "done", sessionId: this.#sessionId, reason: "interrupted" });
      return;
    }

    // Adopting the id rather than passing it straight through: from here on this session
    // *is* that conversation, so the turn after this one continues it too. Handing the
    // SDK a one-off `resume` would make every following turn start a new branch from the
    // same point, which looks like the resume silently stopped working.
    //
    // Adopted once rather than every turn: the composer keeps sending the picked id for
    // the rest of the session, and re-adopting it would throw away the id learned from
    // the SDK -- which is also what decides whether the live query can be kept, so a
    // resumed session would rebuild on every prompt.
    if (options?.resumeConversation && options.resumeConversation !== this.#resumed) {
      this.#resumed = options.resumeConversation;
      this.#resumeId = options.resumeConversation;
    }

    let outcome: Outcome;
    try {
      // Before the query, not inside it: a server whose application is closed is not
      // started at all, which saves its spawn and keeps a row of failures out of the
      // prompt. The checks run in parallel and are a localhost connect each.
      const external = await loadMcpServers(cwd);
      const memory = loadMemoryConfig();
      // Sent every turn, held-back list empty or not: the empty list is what clears the
      // chips the last turn left in the strip. A server the loader skipped never reaches
      // the SDK's init message, so this is the only report that it was configured at all.
      this.#link.send({ t: "mcp_gated", sessionId: this.#sessionId, servers: external.gated });
      const shape: QueryShape = {
        cwd,
        conversation: this.#resumeId,
        settings: memorySettings(memory),
        options,
      };
      const live = await this.#ensureQuery(shape, external.servers);
      // The only handle the model list can be asked through. Fire and forget: it resolves
      // out of band, and this turn neither waits for it nor fails with it.
      this.#models.publish(live.query);

      outcome = await new Promise<Outcome>((resolve) => {
        // Recorded before the prompt goes in, so a result cannot arrive with nobody
        // listed as waiting for it.
        this.#pending = { live, settle: resolve };
        live.queue.push(userMessage(text));
      });
    } catch (thrown) {
      // Reaching the query is inside the try because a turn whose CLI never started has
      // to report `done` like any other; without it the composer stays disabled on a
      // turn that is never coming back.
      this.#pending = null;
      outcome = { reason: "error", error: describe(thrown) };
    }

    let { reason, error } = outcome;
    if (this.#interrupted) {
      // An interrupted turn ends with a result message like any other; the host asked for
      // it, so say so rather than reporting whatever the SDK called it.
      reason = "interrupted";
      error = undefined;
    }
    this.#interrupted = false;
    this.#cancelled = false;
    this.#link.send({ t: "done", sessionId: this.#sessionId, reason, error });
  }

  /**
   * The query this turn runs on: the live one if it can serve the shape, otherwise a new
   * one.
   *
   * The three things a running query can be told -- model, permission mode, MCP servers
   * -- are applied here rather than counted as differences. When one of those fails the
   * query is dropped and rebuilt instead of running the turn with the previous value:
   * the model or mode the person chose is not something to be quietly wrong about.
   */
  async #ensureQuery(
    shape: QueryShape,
    external: Record<string, McpServerConfig>,
  ): Promise<LiveQuery> {
    const live = this.#live;
    if (!live || queryFingerprint(live.built) !== queryFingerprint(shape)) {
      if (live) this.#retire(live);
      return this.#build(shape, external);
    }

    try {
      await this.#retune(live, external, shape.options);
    } catch (error) {
      warn(`could not retune the query on ${this.#sessionId}: ${describe(error)}`);
      this.#retire(live);
      return this.#build(shape, external);
    }
    return live;
  }

  /** Start a query and the loop that reads it. */
  #build(shape: QueryShape, external: Record<string, McpServerConfig>): LiveQuery {
    // One `agentide` server per query, not per session: the SDK connects the instance it
    // is handed when the query is constructed, and handing a closed query's server to the
    // next one is not a state this has any reason to explore.
    const ide = createIdeServer(this.#link, this.#sessionId);
    const queue = new PromptQueue();
    const running = query({
      prompt: queue.stream(),
      options: this.#options(shape, { ...external, [IDE_SERVER_NAME]: ide }),
    });
    const live: LiveQuery = {
      query: running,
      queue,
      built: shape,
      model: shape.options?.model ?? DEFAULT_MODEL,
      permissionMode: shape.options?.permissionMode ?? DEFAULT_PERMISSION_MODE,
      servers: serverKey(external),
      ide,
    };
    this.#live = live;
    // Not awaited: it runs for the life of the query, across every turn on it. It settles
    // its own failures onto whichever turn is waiting, so nothing here can be left hanging
    // by it.
    void this.#consume(live);
    return live;
  }

  /** Apply the changes a running query accepts. Throws if one of them does not land. */
  async #retune(
    live: LiveQuery,
    external: Record<string, McpServerConfig>,
    options?: PromptOptions,
  ): Promise<void> {
    const model = options?.model ?? DEFAULT_MODEL;
    if (model !== live.model) {
      await live.query.setModel(model);
      live.model = model;
    }

    const permissionMode = options?.permissionMode ?? DEFAULT_PERMISSION_MODE;
    if (permissionMode !== live.permissionMode) {
      await live.query.setPermissionMode(permissionMode);
      live.permissionMode = permissionMode;
    }

    // Re-read every turn so an edit to `mcp.json` lands on the next prompt, which is the
    // contract `loadMcpServers` exists for. Applied only when it actually changed: this
    // connects and disconnects real servers, and a set that did not move must not be
    // paid for again.
    //
    // The IDE's own server goes back in unchanged, because this replaces the whole
    // dynamic set. The SDK leaves an in-process server that is already registered under
    // the same name connected rather than restarting it.
    const servers = serverKey(external);
    if (servers !== live.servers) {
      await live.query.setMcpServers({ ...external, [IDE_SERVER_NAME]: live.ide });
      live.servers = servers;
    }
  }

  /**
   * Forward one query's messages for as long as it lives.
   *
   * This spans turns, which is the point: the iterator belongs to the process, not to the
   * prompt. A turn ends at its `result` -- the same message the reason was always derived
   * from -- and the promise `prompt()` handed out is settled there.
   */
  async #consume(live: LiveQuery): Promise<void> {
    try {
      for await (const message of live.query) {
        this.#remember(live, message);
        this.#link.send({
          t: "event",
          sessionId: this.#sessionId,
          msg: message as unknown as JsonObject,
        });
        if (message.type !== "result") continue;
        const reason = resultReason(message.subtype);
        this.#settle(live, { reason, error: reason === "error" ? message.subtype : undefined });
      }
      // The CLI ended on its own. Nothing further is coming, so a turn waiting on it is
      // told rather than left to wait for a message that cannot arrive.
      this.#settle(live, { reason: "error", error: "the agent process ended" });
    } catch (thrown) {
      this.#settle(live, { reason: "error", error: describe(thrown) });
    } finally {
      this.#retire(live);
    }
  }

  /** Finish the turn waiting on `live`, if it is still the one waiting. */
  #settle(live: LiveQuery, outcome: Outcome): void {
    const pending = this.#pending;
    if (!pending || pending.live !== live) return;
    this.#pending = null;
    pending.settle(outcome);
  }

  /**
   * Close a query and stop using it, so the next prompt builds a fresh one.
   *
   * Safe to call twice and on one that is already gone: every path that gives up on a
   * query ends here, and they overlap -- closing one makes its own consumer loop finish,
   * which comes back through this.
   */
  #retire(live: LiveQuery): void {
    live.queue.close();
    try {
      live.query.close();
    } catch (error) {
      // Already torn down, which is the state being asked for.
      warn(`closing the query on ${this.#sessionId} failed: ${describe(error)}`);
    }
    if (this.#live === live) this.#live = null;
  }

  /**
   * The SDK options. `servers` is passed in rather than read here, because the gate on a
   * server that requires an open application is a network check, and this has to stay
   * synchronous for the shape of the SDK call.
   *
   * Everything here is fixed for the life of the query except `model`, `permissionMode`
   * and `mcpServers`; see `queryFingerprint` and `#retune`.
   */
  #options(shape: QueryShape, servers: Record<string, McpServerConfig>): Options {
    const options = shape.options;
    return {
      cwd: shape.cwd,
      model: options?.model ?? DEFAULT_MODEL,
      // No default: an unset effort is the SDK's own, which is not ours to guess, and a
      // model that does not support the one asked for silently gets the nearest it does.
      effort: options?.effort,
      resume: shape.conversation,
      permissionMode: options?.permissionMode,
      // The IDE tools are added rather than replacing what the host asked for:
      // `allowedTools` is an auto-approve list, not a restriction, so this widens nothing
      // else. See `ideToolNames` for why these do not need a prompt.
      allowedTools: [...(options?.allowedTools ?? []), ...ideToolNames()],
      /**
       * `Bash` is taken away, and `ide_run` replaces it.
       *
       * The SDK's own `Bash` runs the command in a process nobody can see and hands back
       * the output once it is over. PRODUCT.md's third principle is that every command
       * the agent runs has a visible home in the UI, and "you can read the log
       * afterwards" is not that: whether a build is compiling or hung is exactly the part
       * only visible while it runs.
       *
       * Removed rather than left as a second option, because a model offered both will
       * sometimes pick the invisible one, and a rule that holds most of the time is not
       * one the user can rely on when deciding whether to watch.
       */
      disallowedTools: [...(options?.disallowedTools ?? []), "Bash"],
      maxTurns: options?.maxTurns,
      includePartialMessages: options?.includePartialMessages,
      canUseTool: createPermissionHandler(this.#link, this.#sessionId),
      // Keyed by `IDE_SERVER_NAME`, not a literal: the key is what the model sees in
      // `mcp__<key>__<tool>`, so a key that drifts from the server's own name is the
      // same class of bug as the one that made these tools invisible for three phases.
      //
      // The person's own servers merge underneath. Precedence runs project over user
      // over nothing, and the IDE's key is written last so no file can displace it --
      // `loadMcpServers` already refuses that name, and this is the second lock on the
      // one failure that has cost this project the most. The user-level file is why the
      // loader exists: a decompiler or a 3D editor belongs to the person, not to one
      // repository, and there was previously nowhere to say so once.
      //
      // This is not the only source. With `strictMcpConfig` unset the SDK also loads a
      // workspace `.mcp.json`, user settings and plugins on its own, so a server can
      // appear here that neither file below mentions.
      mcpServers: servers,
      // The editing agent's own prompt, not a bare model. Without this the built-in
      // Read/Edit/Bash tools arrive with no instructions on how to use them well.
      //
      // `append` rather than a replacement: the preset carries the tool-use discipline
      // and is retuned per model release, so replacing it would mean owning that
      // forever. An empty append is omitted entirely rather than sent as "".
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        ...(options?.systemPromptAppend?.trim()
          ? { append: options.systemPromptAppend }
          : {}),
      },
      // Deliberately no `env`: setting it *replaces* the subprocess environment, and this
      // process was started with the user's, which is where ANTHROPIC_API_KEY or an
      // existing Claude Code login lives. The sidecar never reads or forwards a key.
      /**
       * The agent's memory, and who may write to it.
       *
       * Passed inline rather than written into the person's `~/.claude/settings.json`:
       * this is agentide's choice of vault, and it has no business changing how their
       * Claude Code behaves everywhere else.
       *
       * The memory system itself is the SDK's -- the recall supervisor, the note
       * format, the writer. See `memory-config.ts` for why the directory is a vault.
       */
      ...(shape.settings ? { settings: shape.settings as Options["settings"] } : {}),
      stderr: (data) => process.stderr.write(data),
    };
  }

  /** Learn the SDK's session id so the next turn continues this conversation. */
  #remember(live: LiveQuery, message: SDKMessage): void {
    const id = (message as { session_id?: unknown }).session_id;
    if (typeof id !== "string" || id === "") return;
    // Only from the query still serving this session. A retired one goes on delivering
    // whatever it had buffered, and taking a session id from a query nobody is using
    // would aim the next turn at the wrong transcript.
    if (this.#live !== live) return;
    this.#resumeId = id;
    // The query is demonstrably on this transcript, so a turn that wants this
    // conversation can keep using it. Without this the id learned on the first turn would
    // read as a `resume` the query was not built with, and the second turn would spawn a
    // CLI to continue what it was already continuing.
    live.built.conversation = id;
  }
}

/**
 * The prompts a live query has not taken yet.
 *
 * `query()` reads its input from an async iterable and closes the CLI's stdin when that
 * iterable ends, so this one ends only when the query is being torn down -- a queue that
 * drained to empty and stopped would end the session instead of waiting for the next
 * prompt. A prompt pushed while nothing is waiting sits here until the consumer returns.
 */
class PromptQueue {
  #waiting: SDKUserMessage[] = [];
  #wake: (() => void) | null = null;
  #closed = false;

  push(message: SDKUserMessage): void {
    this.#waiting.push(message);
    this.#wake?.();
  }

  close(): void {
    this.#closed = true;
    this.#wake?.();
  }

  async *stream(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.#waiting.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = null;
    }
  }
}

/**
 * One prompt in the shape the CLI reads off its stdin.
 *
 * The same shape the SDK writes for a string prompt, `session_id: ""` and all: the
 * streaming path forwards this object verbatim, so anything spelled differently here is a
 * difference the CLI sees.
 */
function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    session_id: "",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  };
}

/**
 * The external MCP servers as one comparable string, for deciding whether `setMcpServers`
 * has anything to do. Keys sorted, because the merge order of two config files is not a
 * reason to restart a server.
 */
function serverKey(servers: Record<string, McpServerConfig>): string {
  return JSON.stringify(Object.entries(servers).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function resultReason(subtype: string): DoneReason {
  if (subtype === "success") return "success";
  if (subtype === "error_max_turns") return "max_turns";
  return "error";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warn(text: string): void {
  process.stderr.write(`[agent-host] ${text}\n`);
}
