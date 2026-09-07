/**
 * The session's sequencing, driven end to end against a fake query.
 *
 * Every case here is a bug this file has actually had, and all of them live in the order
 * of operations rather than in a value: a watchdog armed after the await it guards, a Stop
 * that arrives while the query is still being retuned, a query that dies inside that same
 * await, a retired query still delivering what it had buffered. None of it is reachable on
 * demand through a real CLI -- you would have to arrange for one to stop answering -- which
 * is why `Session` takes its `query()` as a parameter. See `StartQuery`.
 *
 * The fake is deliberately faithful about one thing: its stream hands out a buffered
 * message before it looks at the closed flag, because that is what the SDK's does and it
 * is the whole reason `#consume` checks whose query a message came from.
 */

import type {
  Options,
  PermissionMode,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

import { HostLink } from "./host.ts";
import { ModelCatalogue } from "./models.ts";
import type { PromptOptions } from "./protocol.ts";
import { Session, type StartQuery } from "./session.ts";

/**
 * No real configuration. `loadMcpServers` and `loadMemoryConfig` read `~/.agentide`, so
 * without this the tests would run against whatever this machine has configured -- and
 * gate ports for it. Both `HOME` and `USERPROFILE` because `homedir()` reads one on
 * Windows and the other everywhere else.
 */
const EMPTY_HOME = mkdtempSync(join(tmpdir(), "agentide-home-"));
process.env.HOME = EMPTY_HOME;
process.env.USERPROFILE = EMPTY_HOME;

/** The id the fake reports, which the session adopts as its `resume`. */
const SDK_ID = "sdk-session-1";

/** Comfortably past `INTERRUPT_GRACE_MS`, which is not exported and should not be. */
const PAST_THE_GRACE_MS = 30_000;

/** A `Query`, minus the CLI. Records what the session asked of it. */
class FakeQuery {
  readonly options: Options;
  /** The prompt texts that reached it, in order. */
  readonly prompts: string[] = [];
  /** What `setModel` and `setPermissionMode` were told. */
  readonly models: string[] = [];
  readonly permissionModes: PermissionMode[] = [];
  /** The server names each `setMcpServers` was given. */
  readonly serverSets: string[][] = [];
  closed = false;
  interrupts = 0;
  /** True once its stream has returned, so a test can wait for the drain to finish. */
  drained = false;
  /** Makes `interrupt()` never settle: the one case `INTERRUPT_GRACE_MS` exists for. */
  hangOnInterrupt = false;

  #outbox: SDKMessage[] = [];
  #wake: (() => void) | null = null;
  #ended = false;
  /** Held by `stallRetune` to catch a turn inside `setModel`. */
  #stall: { entered: () => void; released: Promise<void> } | null = null;

  constructor(props: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) {
    this.options = props.options ?? {};
    // A real query reads its prompts as they arrive; the recorded order is what the
    // session actually let through.
    if (typeof props.prompt !== "string") void this.#readPrompts(props.prompt);
  }

  async #readPrompts(prompts: AsyncIterable<SDKUserMessage>): Promise<void> {
    for await (const prompt of prompts) {
      const blocks = prompt.message.content as Array<{ text?: string }>;
      this.prompts.push(blocks[0]?.text ?? "");
    }
  }

  /** Deliver a message now, as a running CLI would. */
  emit(message: Record<string, unknown>): void {
    this.#outbox.push(message as unknown as SDKMessage);
    this.#wake?.();
  }

  /**
   * Queue a message without waking the reader, so it is delivered on the next drain --
   * which is how a message written before a takeover arrives after it.
   */
  buffer(message: Record<string, unknown>): void {
    this.#outbox.push(message as unknown as SDKMessage);
  }

  /** End the turn the way the CLI does. */
  finish(subtype = "success"): void {
    this.emit({ type: "result", subtype, session_id: SDK_ID });
  }

  /** The CLI exits and its stream ends. */
  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  /** Stall the next `setModel`. `entered` resolves once the session is inside it. */
  stallRetune(): { entered: Promise<void>; release: () => void } {
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#stall = { entered, released };
    return { entered: enteredPromise, release };
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
    for (;;) {
      const next = this.#outbox.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#ended || this.closed) {
        this.drained = true;
        return;
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = null;
    }
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
    if (this.hangOnInterrupt) await new Promise<void>(() => {});
  }

  async setModel(model: string): Promise<void> {
    const stall = this.#stall;
    this.#stall = null;
    if (stall) {
      stall.entered();
      await stall.released;
    }
    this.models.push(model);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionModes.push(mode);
  }

  async setMcpServers(servers: Record<string, unknown>): Promise<void> {
    this.serverSets.push(Object.keys(servers).sort());
  }

  async supportedModels(): Promise<unknown[]> {
    return [];
  }

  async supportedCommands(): Promise<unknown[]> {
    return [];
  }

  close(): void {
    this.closed = true;
    this.#wake?.();
  }
}

interface Harness {
  session: Session;
  cwd: string;
  /** Every query the session built, in order. */
  queries: FakeQuery[];
  /** What it sent the host, decoded. */
  sent: Array<Record<string, unknown>>;
}

/**
 * A session wired to fakes. The cwd is a fresh empty directory, so no workspace config is
 * read either.
 */
function harness(t: { after: (fn: () => void) => void }): Harness {
  const queries: FakeQuery[] = [];
  const sent: Array<Record<string, unknown>> = [];
  const link = new HostLink((line) => {
    sent.push(JSON.parse(line) as Record<string, unknown>);
  });
  const start = ((props: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: Options;
  }) => {
    const fake = new FakeQuery(props);
    queries.push(fake);
    return fake as unknown as Query;
  }) as StartQuery;

  const session = new Session(link, "host-session-1", new ModelCatalogue(link), start);
  // `started` is module-level and a session that keeps its place in it would be disposed
  // by the next test's first prompt, which is a confusing way to fail.
  t.after(() => {
    session.dispose();
  });
  return { session, cwd: mkdtempSync(join(tmpdir(), "agentide-cwd-")), queries, sent };
}

/**
 * Wait for something the session does across real I/O -- it reads two config files before
 * it reaches the query, so draining microtasks is not enough.
 */
async function until(what: string, ready: () => boolean): Promise<void> {
  for (let tick = 0; tick < 2000; tick += 1) {
    if (ready()) return;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  assert.fail(`waited for ${what} and it never happened`);
}

/** The query a prompt landed in, once it has. */
async function queryHolding(h: Harness, text: string): Promise<FakeQuery> {
  await until(`the prompt "${text}" to reach a query`, () =>
    h.queries.some((query) => query.prompts.includes(text)),
  );
  return h.queries.find((query) => query.prompts.includes(text))!;
}

/** One whole turn: prompt in, the query answers, `done` reported. */
async function runTurn(h: Harness, text: string, options?: PromptOptions): Promise<FakeQuery> {
  const turn = h.session.prompt(h.cwd, text, options);
  const query = await queryHolding(h, text);
  query.finish();
  await turn;
  return query;
}

function dones(h: Harness): Array<{ reason: unknown; error: unknown }> {
  return h.sent
    .filter((message) => message.t === "done")
    .map((message) => ({ reason: message.reason, error: message.error }));
}

test("a turn keeps the query it ran on, so the next one pays nothing for it", async (t) => {
  const h = harness(t);
  const first = await runTurn(h, "the first prompt");
  const second = await runTurn(h, "the second prompt");

  assert.equal(first, second, "the second turn built a query it did not need");
  assert.deepEqual(first.prompts, ["the first prompt", "the second prompt"]);
  assert.deepEqual(
    dones(h).map((done) => done.reason),
    ["success", "success"],
  );
});

test("a Stop while the query is being retuned does not let the prompt through", async (t) => {
  const h = harness(t);
  const query = await runTurn(h, "the first prompt", { model: "claude-opus-5" });

  // A model change is a setter, so this turn keeps the query -- and waits on the CLI to
  // answer. Everything from here to the push takes real time, and a turn not yet recorded
  // as pending is a Stop that gets swallowed: the prompt would go in afterwards, the model
  // would run the whole turn and land its edits, and only then would it report interrupted.
  const stall = query.stallRetune();
  const turn = h.session.prompt(h.cwd, "the prompt the user cancelled", {
    model: "claude-sonnet-5",
  });
  await stall.entered;
  await h.session.interrupt();
  stall.release();
  await turn;

  assert.deepEqual(
    dones(h).map((done) => done.reason),
    ["success", "interrupted"],
  );
  assert.deepEqual(
    query.prompts,
    ["the first prompt"],
    "the cancelled prompt reached the model anyway",
  );
  assert.equal(h.queries.length, 1, "the query is built and idle; the next turn can have it");
  assert.ok(!query.closed, "a cancelled turn is no reason to drop a working query");
});

test("an interrupt the query never answers still ends the turn", async (t) => {
  const h = harness(t);
  const turn = h.session.prompt(h.cwd, "a turn that will not stop");
  const query = await queryHolding(h, "a turn that will not stop");

  // `Query.request()` sets no timer of its own and settles only on a matching control
  // response, a failed write or `cleanup()`. A CLI that is alive and simply never answers
  // leaves the interrupt hanging, and the watchdog has to be armed before that await --
  // armed after it, it is never armed at all, and the turn never ends: the pane keeps
  // Stop, New and the composer disabled until the app is restarted.
  query.hangOnInterrupt = true;
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    void h.session.interrupt();
    mock.timers.tick(PAST_THE_GRACE_MS);
  } finally {
    mock.timers.reset();
  }
  await turn;

  assert.deepEqual(
    dones(h).map((done) => done.reason),
    ["interrupted"],
  );
  assert.ok(query.closed, "a query that would not answer is not trusted with the next turn");
});

test("a new conversation takes the CLI over rather than leaving one resident", async (t) => {
  const first = harness(t);
  await runTurn(first, "in the first conversation");

  // What "New Conversation" does: a fresh session id, prompted. Nothing in the protocol
  // says the old one is over, so the new one has to say it -- otherwise every press leaves
  // a resident CLI behind, plus every external MCP server that CLI spawned.
  const second = harness(t);
  await runTurn(second, "in the second conversation");

  assert.ok(first.queries[0]!.closed, "the conversation that was left behind still owns a CLI");
  assert.ok(!second.queries[0]!.closed, "the conversation in front of the user lost its CLI");
});

test("what a retired query had buffered is not drawn into the conversation after it", async (t) => {
  const first = harness(t);
  const query = await runTurn(first, "in the first conversation");

  // Written before the takeover and delivered after it. Forwarded, it draws a row in
  // whatever turn is running now; a buffered `result` would close that turn early and
  // suppress the real boundary when it arrives.
  query.buffer({
    type: "assistant",
    session_id: SDK_ID,
    message: { content: [{ type: "text", text: "a stray thought" }] },
  });
  query.buffer({ type: "result", subtype: "success", session_id: SDK_ID });

  const second = harness(t);
  await runTurn(second, "in the second conversation");
  await until("the retired query to drain", () => query.drained);

  assert.ok(
    !JSON.stringify(first.sent).includes("a stray thought"),
    "a message from the conversation the user left was forwarded",
  );
  assert.deepEqual(
    dones(first).map((done) => done.reason),
    ["success"],
    "the retired query's buffered result closed a turn a second time",
  );
});

test("a query that dies while it is being retuned is not the one the turn runs on", async (t) => {
  const h = harness(t);
  const first = await runTurn(h, "the first prompt", { model: "claude-opus-5" });

  const stall = first.stallRetune();
  const turn = h.session.prompt(h.cwd, "the second prompt", { model: "claude-sonnet-5" });
  await stall.entered;
  // The CLI exits inside the await. The consumer loop retires the query, so handing that
  // one back would push the prompt into a closed queue whose stream has already returned:
  // the turn would wait for a result nobody is going to produce.
  first.end();
  await until("the dead query to be retired", () => first.drained);
  stall.release();

  const second = await queryHolding(h, "the second prompt");
  assert.notEqual(second, first, "the prompt went into a query that had already exited");
  second.finish();
  await turn;

  assert.equal(h.queries.length, 2);
  assert.deepEqual(
    dones(h).map((done) => done.reason),
    ["success", "success"],
  );
  assert.equal(
    second.options.resume,
    SDK_ID,
    "the replacement started a new transcript instead of continuing this one",
  );
});
