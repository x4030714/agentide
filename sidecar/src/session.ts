/** One conversation: drives `query()` and turns `SDKMessage`s into protocol events. The query
 * outlives the prompt -- a spawn is ~2.5s plus ~1.8s per MCP server -- so `resume` carries it. */

import {
  query,
  type McpServerConfig,
  type Options,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { accountEnv, findAccount, loadAccounts, type Account } from "./accounts.ts";
import { advancedOptions } from "./advanced.ts";
import { HostLink } from "./host.ts";
import { createIdeServer, IDE_SERVER_NAME, ideToolNames } from "./ide-tools.ts";
import { loadMcpServers } from "./mcp-config.ts";
import { contextSettings, loadCompactWindow } from "./context-config.ts";
import { loadMemoryConfig, memorySettings } from "./memory-config.ts";
import {
  findProvider,
  loadProviders,
  providerEnv,
  publicProviders,
  waitForProvider,
  type Provider,
} from "./provider-config.ts";
import { ModelCatalogue } from "./models.ts";
import { createPermissionHandler } from "./permissions.ts";
import type { Attachment, DoneReason, JsonObject, PromptOptions } from "./protocol.ts";

/** Used when the host does not name one. */
export const DEFAULT_MODEL = "claude-opus-5";

/** What the SDK does when `permissionMode` is unset. Named so unset and an explicit `default`
 * compare equal, instead of costing a control request the first time it is spelled out. */
const DEFAULT_PERMISSION_MODE: PermissionMode = "default";

/** How long an interrupt has to close the turn before the query is taken down. An interrupt that
 * never lands leaves the turn unsettled and every queued prompt behind it; a spawn is cheaper. */
const INTERRUPT_GRACE_MS = 5_000;

/** Two minutes: generous for a 30B laid out in memory, short enough that a missing engine or
 * bad model path reports instead of hanging. */
const PROVIDER_LOAD_MS = 120_000;

/** Everything a query is built from. Holds the whole `PromptOptions` and lets `queryFingerprint`
 * skip the retunable fields, so a new option is classified in exactly one place. */
export interface QueryShape {
  cwd: string;
  /** The transcript this turn must run in. `undefined` starts a new one. */
  conversation: string | undefined;
  /** The inline settings block -- the memory configuration -- or null when it is off. */
  settings: Record<string, unknown> | null;
  /** The backend this turn runs against, or null for Anthropic. Resolved, not a key: editing a
   * provider's URL without renaming it must rebuild the query too. */
  provider: Provider | null;
  /** Which Claude account this turn runs under, or null for the machine's own login.
   * Resolved for the same reason as the provider: repointing an account's directory without
   * renaming it has to rebuild the query. */
  account: Account | null;
  options?: PromptOptions;
}

/** Same fingerprint, same query; a difference is a CLI spawn. Absent means the `Query` has a
 * setter for it; present means the CLI only reads it at startup. An array, so order is ours. */
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
    // No setter for `agents`, `hooks` or `thinking`: the CLI reads all three at startup, so
    // switching into or out of Advanced is a spawn rather than a retune.
    options?.promptProfile ?? null,
    shape.settings,
    // By value: the backend is environment the CLI reads once at startup, so a live query
    // cannot move between backends. The token is in because rotating a key must rebuild too.
    shape.provider
      ? [shape.provider.key, shape.provider.baseUrl, shape.provider.token]
      : null,
    // By value, and for the same reason: `CLAUDE_CONFIG_DIR` is read once when the CLI
    // starts and there is no setter, so a live query cannot move between accounts.
    shape.account ? [shape.account.key, shape.account.configDir] : null,
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

/** The turn `prompt()` is waiting on. At most one per session: `#chain` serializes them. */
interface Pending {
  /** Null while the query is still being prepared. A turn is recorded before the config read
   * and the retune, so a Stop in that window has something to cancel. */
  live: LiveQuery | null;
  settle: (outcome: Outcome) => void;
}

/** How a query is started. One implementation, the SDK's; the seam exists so tests can drive
 * interrupts, retirement and a mid-turn death, none of which a real CLI does on demand. */
export type StartQuery = typeof query;

/** The sessions that own a CLI. Nothing in the protocol ends a conversation, so the first
 * prompt of a session takes over from the last -- otherwise every "New" leaks a process tree. */
const started = new Set<Session>();

export class Session {
  readonly #link: HostLink;
  readonly #sessionId: string;
  /** Shared with every session: the catalogue belongs to the process, not the turn. */
  readonly #models: ModelCatalogue;
  /** How `#build` reaches the SDK; see `StartQuery`. */
  readonly #start: StartQuery;
  /** The `ide_*` tools this host can answer, undefined for all. The CLI has no editor and no
   * language server; declaring those anyway buys the model a dozen ways to fail. */
  readonly #answers: readonly string[] | undefined;
  /** Turns run one at a time; a prompt arriving mid-turn queues behind this. */
  #chain: Promise<void> = Promise.resolve();
  /** The SDK's session id, learned from its messages and replayed as `resume`. */
  #resumeId: string | undefined;
  /** The conversation the host last asked to resume; see `#runTurn` for why it is kept. */
  #resumed: string | undefined;
  /** The query these turns run on, or null when the next prompt has to build one. */
  #live: LiveQuery | null = null;
  /** The turn waiting for its `result`. At most one: `#chain` serializes them. */
  #pending: Pending | null = null;
  /** Set by `interrupt`, cleared when the turn it applies to reports `done`. */
  #interrupted = false;
  /** Set by `interrupt` and `dispose`; makes queued prompts finish without running. */
  #cancelled = false;
  /** Set by `dispose`. Unlike `#cancelled` this is final: the session is over. */
  #disposed = false;

  constructor(
    link: HostLink,
    sessionId: string,
    models: ModelCatalogue,
    start: StartQuery = query,
    answers?: readonly string[],
  ) {
    this.#link = link;
    this.#sessionId = sessionId;
    this.#models = models;
    this.#start = start;
    this.#answers = answers;
  }

  /** Queue a turn. Resolves when it has finished and its `done` has been sent. */
  prompt(
    cwd: string,
    text: string,
    options?: PromptOptions,
    attachments?: Attachment[],
  ): Promise<void> {
    this.#claim();
    this.#chain = this.#chain.then(() => this.#runTurn(cwd, text, options, attachments));
    return this.#chain;
  }

  /** Stop the running turn and drop what is queued behind it. Also fails outstanding permission
   * and tool requests, which nobody will answer and which would outlive the interrupt. */
  async interrupt(): Promise<void> {
    this.#cancelled = true;
    this.#interrupted = true;
    this.#link.failSession(this.#sessionId, "the turn was interrupted");
    const pending = this.#pending;
    // A turn in flight is what `#pending` says, not whether a query exists -- the query
    // outlives the turn, and interrupting an idle one risks it for nothing.
    if (!pending) return;

    const live = pending.live;
    if (!live) {
      // Stopped mid-assembly: nothing to interrupt, so the turn ends here and `#runTurn`
      // finds it settled before pushing the prompt.
      this.#pending = null;
      pending.settle({ reason: "interrupted" });
      return;
    }

    // Armed before the request, not after. `Query.request()` sets no timer, so a live CLI
    // that never answers hangs the await below and the watchdog is never registered.
    const timer = setTimeout(() => {
      if (this.#pending !== pending) return;
      // See INTERRUPT_GRACE_MS. The query is not answering for this turn, so it is not
      // trusted with the next one either.
      warn(`the interrupt on ${this.#sessionId} did not end the turn; dropping the query`);
      this.#settle(live, { reason: "interrupted" });
      this.#retire(live);
    }, INTERRUPT_GRACE_MS);
    // A watchdog must not be the reason the process stays alive.
    timer.unref();

    try {
      await live.query.interrupt();
    } catch (error) {
      // The turn may have ended between the check and the call; that is the outcome we
      // wanted anyway.
      warn(`interrupt on ${this.#sessionId} failed: ${describe(error)}`);
    }
  }

  /** Tear down without reporting anything: the host went away, or a newer conversation took
   * this session's place. */
  dispose(): void {
    this.#cancelled = true;
    this.#disposed = true;
    started.delete(this);
    // Nothing is left to answer what this session asked, and the SDK would otherwise wait
    // out the fifteen-minute backstop for a reply that is not coming.
    this.#link.failSession(this.#sessionId, "the conversation was closed");
    if (this.#live) this.#retire(this.#live);
  }

  /** Take over from the previous session; see `started`. On the first prompt, not in the
   * constructor: a session that is never prompted has no CLI to hand over. */
  #claim(): void {
    if (this.#disposed || started.has(this)) return;
    for (const previous of started) previous.dispose();
    started.add(this);
  }

  /** Build the query and ask what the installation offers, without running a turn: only a live
   * `Query` exposes `supportedCommands()`. Terminal only -- desktop would spawn a CLI per New. */
  warm(cwd: string, options?: PromptOptions): Promise<void> {
    this.#claim();
    this.#chain = this.#chain.then(async () => {
      if (this.#disposed || this.#cancelled) return;
      try {
        await this.#prepare(cwd, options);
      } catch (error) {
        // Not a failed turn -- the next prompt prepares again. Said out loud anyway, or a
        // short menu reads as the feature rather than the backend.
        warn(`could not read what this installation offers: ${describe(error)}`);
      }
    });
    return this.#chain;
  }

  /** Everything a turn needs before its text goes in. Shared with `warm`, which must build the
   * identical shape: one field of drift and the first prompt retires it and respawns. */
  async #prepare(cwd: string, options?: PromptOptions): Promise<LiveQuery> {
    // Before the query, not inside it: a server whose application is closed is never
    // started, saving its spawn. The checks are one localhost connect each, in parallel.
    const external = await loadMcpServers(cwd);
    const memory = loadMemoryConfig();
    // Re-read per turn, so an edit lands on the next prompt. Resolved here, not in the host:
    // `${VAR}` is expanded here and the token must not cross into the webview.
    const providers = loadProviders();
    // Sent every turn, not only at startup: the file is re-read every turn, so a backend
    // added while the app was open reaches the picker on the next prompt.
    this.#link.send({ t: "providers", providers: publicProviders(providers) });
    const provider = findProvider(providers, options?.provider);
    if (options?.provider && !provider) {
      // Named and not found is a refusal, not a fallback: falling through to Anthropic on a
      // misspelled key is a silent success, and a billed one.
      throw new Error(`no provider named "${options.provider}" in ~/.agentide/providers.json`);
    }
    if (provider) {
      // Only wait on a backend we launched: it is loading off disk. One we did not is
      // either up already or the person's to start, and a minute of silence helps nobody.
      const grace = provider.start ? PROVIDER_LOAD_MS : 0;
      if (!(await waitForProvider(provider, grace))) {
        // Claude Code does not fall back to the cloud on a dead `ANTHROPIC_BASE_URL`; it
        // fails naming neither provider nor port. This is that error, said usefully.
        throw new Error(
          `${provider.key} is not answering on ${provider.host}:${provider.port}` +
            (provider.start ? ` -- it was started but did not come up` : ` -- start it first`),
        );
      }
    }
    // Sent every turn, empty or not -- the empty list clears the strip. A skipped server
    // never reaches the SDK's init message, so this is the only report it exists.
    this.#link.send({ t: "mcp_gated", sessionId: this.#sessionId, servers: external.gated });
    // Resolved here rather than in `#options`, so an unknown key fails the turn with a name
    // instead of quietly running it under whichever account the machine last used.
    const account = options?.account ? findAccount(loadAccounts(), options.account) : null;
    if (options?.account && !account) {
      throw new Error(`no account named "${options.account}" in ~/.agentide/accounts.json`);
    }
    const shape: QueryShape = {
      cwd,
      conversation: this.#resumeId,
      // Memory and the compaction window travel in one inline block; both are startup-only
      // and both belong in `queryFingerprint`, which `settings` already is.
      settings: { ...(memorySettings(memory) ?? {}), ...contextSettings(loadCompactWindow()) },
      provider,
      account,
      options,
    };
    const live = await this.#ensureQuery(shape, external.servers);
    // The only handle the model list can be asked through. Fire and forget -- no turn waits
    // on it or fails with it.
    this.#models.publish(live.query);
    return live;
  }

  async #runTurn(
    cwd: string,
    text: string,
    options?: PromptOptions,
    attachments?: Attachment[],
  ): Promise<void> {
    if (this.#disposed) return;
    if (this.#cancelled) {
      // Queued behind a turn that was interrupted; report it rather than silently
      // dropping a prompt the user typed.
      this.#cancelled = false;
      this.#interrupted = false;
      this.#done("interrupted");
      return;
    }

    // Adopted, not passed through: a one-off `resume` branches afresh every turn. Adopted
    // once, or re-adopting would discard the SDK's id and rebuild on every prompt.
    if (options?.resumeConversation && options.resumeConversation !== this.#resumed) {
      this.#resumed = options.resumeConversation;
      this.#resumeId = options.resumeConversation;
    }

    let settle!: (outcome: Outcome) => void;
    const finished = new Promise<Outcome>((resolve) => {
      settle = resolve;
    });
    // In flight from here, before the awaits below: Stop is live the moment the prompt is
    // submitted, and an unrecorded turn swallows it and lands the model's edits anyway.
    const pending: Pending = { live: null, settle };
    this.#pending = pending;

    let outcome: Outcome;
    try {
      const live = await this.#prepare(cwd, options);

      // Unless a Stop landed during preparation. The query is kept -- built and idle -- but
      // the cancelled text must not reach the model.
      if (this.#pending === pending) {
        pending.live = live;
        live.queue.push(userMessage(text, attachments));
      }
      outcome = await finished;
    } catch (thrown) {
      // Preparation is inside the try: a turn whose CLI never started still has to report
      // `done`, or the composer stays disabled forever.
      if (this.#pending === pending) this.#pending = null;
      outcome = { reason: "error", error: describe(thrown) };
    }

    let { reason, error } = outcome;
    if (this.#interrupted) {
      // An interrupted turn still ends with an ordinary result; the host asked for this, so
      // say so rather than repeating whatever the SDK called it.
      reason = "interrupted";
      error = undefined;
      // Swept again: the CLI runs on until the interrupt lands, and anything it asked for
      // in that window would leave a permission card answerable for fifteen minutes.
      this.#link.failSession(this.#sessionId, "the turn was interrupted");
    }
    this.#interrupted = false;
    this.#cancelled = false;
    this.#done(reason, error);
  }

  /** Report the end of a turn, silently once disposed: the pane ends whatever turn it is
   * showing on any `done`, so a late one from an abandoned conversation closes the wrong turn. */
  #done(reason: DoneReason, error?: string): void {
    if (this.#disposed) return;
    this.#link.send({ t: "done", sessionId: this.#sessionId, reason, error });
  }

  /** The live query if it can serve the shape, otherwise a new one. A retune that fails rebuilds
   * rather than runs: the model or mode someone picked must not be quietly wrong. */
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
    // The CLI can exit inside the await above and the consumer retires the query; handing
    // that one back pushes the prompt into a closed queue and the turn never ends.
    if (this.#live !== live) return this.#build(shape, external);
    return live;
  }

  /** Start a query and the loop that reads it. */
  #build(shape: QueryShape, external: Record<string, McpServerConfig>): LiveQuery {
    // One `agentide` server per query: the SDK connects the instance it was constructed with.
    // Loaded on Anthropic, deferred locally -- the prompt cache decides; see `alwaysLoad`.
    const ide = createIdeServer(this.#link, this.#sessionId, this.#answers, !shape.provider);
    const queue = new PromptQueue();
    const running = this.#start({
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
    // Not awaited: it runs for the life of the query and settles its own failures onto
    // whichever turn is waiting.
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

    // Applied only on a real change -- this connects and disconnects live servers. The IDE's
    // own goes back in because the call replaces the whole set; the SDK leaves it connected.
    const servers = serverKey(external);
    if (servers !== live.servers) {
      await live.query.setMcpServers({ ...external, [IDE_SERVER_NAME]: live.ide });
      live.servers = servers;
    }
  }

  /** Forward one query's messages for as long as it lives -- the iterator belongs to the
   * process, not the prompt. A turn ends at its `result`, which is where `prompt()` settles. */
  async #consume(live: LiveQuery): Promise<void> {
    try {
      for await (const message of live.query) {
        // A retired query keeps delivering: the SDK's stream shifts a queued message before
        // checking closed, and a buffered `result` would close whatever turn is running now.
        if (this.#live !== live) continue;
        this.#remember(live, message);
        this.#link.send({
          t: "event",
          sessionId: this.#sessionId,
          msg: message as unknown as JsonObject,
        });
        if (message.type !== "result") continue;
        // Measured now, when the turn's whole history is in the window. Fire and forget: a
        // failed measurement costs a number in the status bar, never the turn.
        void this.#publishContext(live);
        const reason = resultReason(message.subtype);
        this.#settle(live, { reason, error: reason === "error" ? message.subtype : undefined });
      }
      // The CLI ended on its own; a turn waiting on it is told rather than left waiting for
      // a message that cannot arrive.
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

  /** Close a query so the next prompt builds a fresh one. Safe to call twice: closing one ends
   * its consumer loop, which comes back through here. */
  #retire(live: LiveQuery): void {
    live.queue.close();
    try {
      live.query.close();
    } catch (error) {
      // Already torn down, which is the state being asked for.
      warn(`closing the query on ${this.#sessionId} failed: ${describe(error)}`);
    }
    if (this.#live === live) this.#live = null;
    // For the paths that dropped a query without knowing a turn was on it. The deliberate
    // ones settle first and find nothing left here.
    this.#settle(live, { reason: "error", error: "the agent process was closed" });
  }

  /** The SDK options, fixed for the query's life except `model`, `permissionMode` and
   * `mcpServers`. `servers` arrives ready because gating is async and this cannot be. */
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
      // Added, not replacing: `allowedTools` is an auto-approve list, not a restriction. See
      // `ideToolNames` for why these need no prompt.
      allowedTools: [...(options?.allowedTools ?? []), ...ideToolNames(this.#answers)],
      /** `Bash` is taken away and `ide_run` replaces it: the SDK's own runs invisibly, and a
       * model offered both will sometimes pick the invisible one. */
      disallowedTools: [...(options?.disallowedTools ?? []), "Bash"],
      maxTurns: options?.maxTurns,
      includePartialMessages: options?.includePartialMessages,
      /**
       * The whole of a subagent's conversation, not just its calls.
       *
       * Off, the SDK forwards a subagent's `tool_use` and `tool_result` blocks and nothing
       * else -- enough for a heartbeat, not enough to read. The transcript draws each
       * delegated run as its own conversation, and without this that conversation is a list
       * of file reads with no reasoning between them and no report at the end: you can see
       * that an agent worked and not what it concluded.
       *
       * Here rather than in Advanced mode's bundle, though that is the mode with the roster.
       * It spends no tokens and changes nothing the model does -- the text was generated
       * either way, and this only decides whether the host is told. Gated on the mode, the
       * run view would be empty of reasoning in the other three, which is a surface that
       * cannot be relied on.
       */
      forwardSubagentText: true,
      canUseTool: createPermissionHandler(this.#link, this.#sessionId),
      // The IDE's key is written last so no config file can displace it. Not the only source:
      // with `strictMcpConfig` unset the SDK also loads `.mcp.json`, settings and plugins.
      mcpServers: servers,
      // The editing agent's preset, appended to rather than replaced: it carries the tool-use
      // discipline and is retuned per model release. An empty append is omitted, not sent as "".
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        ...(options?.systemPromptAppend?.trim()
          ? { append: options.systemPromptAppend }
          : {}),
      },
      /** Spread over `process.env`, never in place of it -- `env` replaces the subprocess
       * environment whole. Both of these are read by the CLI at startup, which is why both
       * are in `queryFingerprint`. */
      ...(shape.provider || shape.account
        ? {
            env: {
              ...process.env,
              ...(shape.provider ? providerEnv(shape.provider) : {}),
              ...(shape.account ? accountEnv(shape.account) : {}),
            },
          }
        : {}),
      /** The agent's memory, and who may write to it. Inline rather than in the person's
       * `~/.claude/settings.json`: this must not change their Claude Code everywhere else. */
      ...(shape.settings ? { settings: shape.settings as Options["settings"] } : {}),
      /** Advanced mode's subagents, thinking budget and hooks. Last, so what it adds is
       * plainly the mode's and not tangled into the options every turn gets. */
      ...(options?.promptProfile === "advanced"
        ? advancedOptions((text) => this.#note(text))
        : {}),
      stderr: (data) => process.stderr.write(data),
    };
  }

  /**
   * A line for the transcript that no SDK message would produce.
   *
   * Sent as an `event` in the SDK's own shape rather than as a new wire message: the
   * transcript already turns a `system` message into a row, and a second path into that
   * surface would be a second thing to keep in step with it.
   */
  #note(text: string): void {
    if (this.#disposed) return;
    this.#link.send({
      t: "event",
      sessionId: this.#sessionId,
      msg: { type: "system", subtype: "agentide_note", text },
    });
  }

  /**
   * How much of the window this conversation now occupies.
   *
   * Asked of the live query after every result, because nothing else says. A conversation
   * on a million-token model grew to 925k tokens with no sign of it anywhere in the window,
   * and every tool call was re-reading all of it. `max` is the window the SDK measures
   * against -- the compaction window when one is set -- so the percentage means "how close
   * to being compacted", which is the useful question.
   */
  async #publishContext(live: LiveQuery): Promise<void> {
    try {
      const usage = await live.query.getContextUsage();
      if (this.#live !== live || this.#disposed) return;
      this.#link.send({
        t: "context",
        sessionId: this.#sessionId,
        tokens: Math.max(0, Math.round(usage.totalTokens)),
        max: Math.max(1, Math.round(usage.rawMaxTokens)),
      });
    } catch {
      /* A retired query, or a CLI too old to answer. The status bar keeps its last figure. */
    }
  }

  /** Learn the SDK's session id so the next turn continues this conversation. */
  #remember(live: LiveQuery, message: SDKMessage): void {
    const id = (message as { session_id?: unknown }).session_id;
    if (typeof id !== "string" || id === "") return;
    // Only from the query still serving this session: a retired one keeps delivering, and
    // its session id would aim the next turn at the wrong transcript.
    if (this.#live !== live) return;
    this.#resumeId = id;
    // The query is demonstrably on this transcript. Without this the id learned on turn one
    // reads as a `resume` it was not built with, and turn two spawns a CLI for nothing.
    live.built.conversation = id;
  }
}

/** The prompts a live query has not taken yet. Ends only on teardown: `query()` closes the
 * CLI's stdin when its iterable ends, so draining to empty would end the session. */
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

/** One prompt in the shape the CLI reads off its stdin, `session_id: ""` and all: the streaming
 * path forwards this object verbatim, so any difference here is one the CLI sees. */
/**
 * The prompt as content blocks: the text, plus whatever was attached to it.
 *
 * Images become `image` blocks, which is the only way a model sees one. Files become a line
 * of text naming the path -- deliberately not the file's contents. The model already has
 * `Read` and the `ide_*` tools, and inlining a source file would put every byte of it into
 * the prompt on this turn *and every later turn of the conversation*, where a tool call
 * costs it once. The exception is an image, which no tool can hand back usefully.
 *
 * The text goes last. An instruction after its attachments reads as being about them.
 */
function promptContent(text: string, attachments: Attachment[] | undefined) {
  const blocks: NonNullable<SDKUserMessage["message"]["content"]> = [];
  const files: string[] = [];

  for (const attachment of attachments ?? []) {
    if (attachment.kind === "image") {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: attachment.mediaType, data: attachment.data },
      });
    } else {
      files.push(attachment.path);
    }
  }

  if (files.length > 0) {
    blocks.push({
      type: "text",
      text:
        files.length === 1
          ? `Attached file: ${files[0]}`
          : `Attached files:\n${files.map((path) => `- ${path}`).join("\n")}`,
    });
  }
  // An empty prompt is legitimate when something is attached: "look at this" is the image.
  if (text !== "" || blocks.length === 0) blocks.push({ type: "text", text });
  return blocks;
}

function userMessage(text: string, attachments?: Attachment[]): SDKUserMessage {
  return {
    type: "user",
    session_id: "",
    message: { role: "user", content: promptContent(text, attachments) },
    parent_tool_use_id: null,
  };
}

/** The external MCP servers as one comparable string, for deciding whether `setMcpServers` has
 * anything to do. Keys sorted: config merge order is no reason to restart a server. */
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
