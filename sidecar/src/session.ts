/**
 * One conversation: drives `query()` and turns `SDKMessage`s into protocol events.
 *
 * A session survives across prompts. The SDK's own session id is learned from the first
 * message it produces and fed back as `resume` on the next turn, so the host's session id
 * is a stable handle for the UI while the SDK keeps the real transcript on disk.
 */

import { query, type Options, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { HostLink } from "./host.ts";
import { createIdeServer } from "./ide-tools.ts";
import { createPermissionHandler } from "./permissions.ts";
import type { DoneReason, JsonObject, PromptOptions } from "./protocol.ts";

/** Used when the host does not name one. */
export const DEFAULT_MODEL = "claude-opus-5";

export class Session {
  readonly #link: HostLink;
  readonly #sessionId: string;
  /** Turns run one at a time; a prompt arriving mid-turn queues behind this. */
  #chain: Promise<void> = Promise.resolve();
  /** The SDK's session id, learned from its messages and replayed as `resume`. */
  #resumeId: string | undefined;
  #active: Query | null = null;
  /** Set by `interrupt`, cleared when the turn it applies to reports `done`. */
  #interrupted = false;
  /** Set by `interrupt` and `dispose`; makes queued prompts finish without running. */
  #cancelled = false;

  constructor(link: HostLink, sessionId: string) {
    this.#link = link;
    this.#sessionId = sessionId;
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

    let reason: DoneReason = "success";
    let error: string | undefined;
    const running = query({ prompt: text, options: this.#options(cwd, options) });
    this.#active = running;

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
      resume: this.#resumeId,
      permissionMode: options?.permissionMode,
      allowedTools: options?.allowedTools,
      disallowedTools: options?.disallowedTools,
      maxTurns: options?.maxTurns,
      includePartialMessages: options?.includePartialMessages,
      canUseTool: createPermissionHandler(this.#link, this.#sessionId),
      mcpServers: { ide: createIdeServer(this.#link, this.#sessionId) },
      // The editing agent's own prompt, not a bare model. Without this the built-in
      // Read/Edit/Bash tools arrive with no instructions on how to use them well.
      systemPrompt: { type: "preset", preset: "claude_code" },
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
