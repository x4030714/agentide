/**
 * One conversation: drives `query()` and turns `SDKMessage`s into protocol events.
 *
 * A session survives across prompts. The SDK's own session id is learned from the first
 * message it produces and fed back as `resume` on the next turn, so the host's session id
 * is a stable handle for the UI while the SDK keeps the real transcript on disk.
 */

import { query, type Options, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { HostLink } from "./host.ts";
import { createIdeServer, IDE_SERVER_NAME, ideToolNames } from "./ide-tools.ts";
import { ModelCatalogue } from "./models.ts";
import { createPermissionHandler } from "./permissions.ts";
import type { DoneReason, JsonObject, PromptOptions } from "./protocol.ts";

/** Used when the host does not name one. */
export const DEFAULT_MODEL = "claude-opus-5";

export class Session {
  readonly #link: HostLink;
  readonly #sessionId: string;
  /** Shared with every session: the catalogue belongs to the process, not the turn. */
  readonly #models: ModelCatalogue;
  /** Turns run one at a time; a prompt arriving mid-turn queues behind this. */
  #chain: Promise<void> = Promise.resolve();
  /** The SDK's session id, learned from its messages and replayed as `resume`. */
  #resumeId: string | undefined;
  #active: Query | null = null;
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
    const active = this.#active;
    if (!active) return;
    try {
      await active.interrupt();
    } catch (error) {
      // The turn may have ended between the check and the call; that is the outcome we
      // wanted anyway.
      warn(`interrupt on ${this.#sessionId} failed: ${describe(error)}`);
    }
  }

  /** Tear down without reporting anything. Used when the host goes away. */
  dispose(): void {
    this.#cancelled = true;
    this.#active?.close();
    this.#active = null;
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
    if (options?.resumeConversation) this.#resumeId = options.resumeConversation;

    let reason: DoneReason = "success";
    let error: string | undefined;
    const running = query({ prompt: text, options: this.#options(cwd, options) });
    this.#active = running;
    // The only handle the model list can be asked through. Fire and forget: it resolves
    // out of band, and this turn neither waits for it nor fails with it.
    this.#models.publish(running);

    try {
      for await (const message of running) {
        this.#remember(message);
        this.#link.send({
          t: "event",
          sessionId: this.#sessionId,
          msg: message as unknown as JsonObject,
        });
        if (message.type === "result") {
          reason = resultReason(message.subtype);
          if (reason === "error") error = message.subtype;
        }
      }
    } catch (thrown) {
      reason = "error";
      error = describe(thrown);
    } finally {
      this.#active = null;
    }

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

  #options(cwd: string, options?: PromptOptions): Options {
    return {
      cwd,
      model: options?.model ?? DEFAULT_MODEL,
      // No default: an unset effort is the SDK's own, which is not ours to guess, and a
      // model that does not support the one asked for silently gets the nearest it does.
      effort: options?.effort,
      resume: this.#resumeId,
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
      mcpServers: { [IDE_SERVER_NAME]: createIdeServer(this.#link, this.#sessionId) },
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
      stderr: (data) => process.stderr.write(data),
    };
  }

  /** Learn the SDK's session id so the next turn continues this conversation. */
  #remember(message: SDKMessage): void {
    const id = (message as { session_id?: unknown }).session_id;
    if (typeof id === "string" && id !== "") this.#resumeId = id;
  }
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
