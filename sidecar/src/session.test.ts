/**
 * The rule that decides whether a turn keeps the running CLI or spawns a new one.
 *
 * A field on the wrong side of the line either costs ~2.5s of spawn on every turn, or
 * runs the turn with an option the person already changed. Each test below is one field
 * and which of those two it would be.
 *
 * The sequencing around this rule -- what happens when a query dies, is interrupted, or is
 * taken over by a newer conversation -- is in `session-lifecycle.test.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { PromptOptions } from "./protocol.ts";
import type { Provider } from "./provider-config.ts";
import { queryFingerprint, type QueryShape } from "./session.ts";

/** A turn's shape, with one thing about it changed. */
function shape(change: Partial<QueryShape> = {}, options: Partial<PromptOptions> = {}): QueryShape {
  return {
    cwd: "C:/work/agentide",
    conversation: "sdk-session-1",
    settings: {
      autoMemoryEnabled: true,
      autoMemoryDirectory: "C:/Users/dev/agentide-vault",
    },
    provider: null,
    ...change,
    options: {
      model: "claude-opus-5",
      effort: "high",
      permissionMode: "default",
      systemPromptAppend: "the tuned prompt",
      ...options,
    },
  };
}

test("a second turn with nothing changed keeps the running query", () => {
  assert.equal(queryFingerprint(shape()), queryFingerprint(shape()));
});

test("a different model is a setter, not a spawn", () => {
  assert.equal(queryFingerprint(shape()), queryFingerprint(shape({}, { model: "claude-sonnet-5" })));
});

test("a different permission mode is a setter, not a spawn", () => {
  assert.equal(
    queryFingerprint(shape()),
    queryFingerprint(shape({}, { permissionMode: "acceptEdits" })),
  );
});

test("a different effort rebuilds, because no setter reaches it", () => {
  assert.notEqual(queryFingerprint(shape()), queryFingerprint(shape({}, { effort: "low" })));
});

test("dropping the effort rebuilds rather than leaving the last one running", () => {
  assert.notEqual(queryFingerprint(shape()), queryFingerprint(shape({}, { effort: undefined })));
});

test("a different workspace rebuilds", () => {
  assert.notEqual(queryFingerprint(shape()), queryFingerprint(shape({ cwd: "C:/work/other" })));
});

test("a different conversation rebuilds, because resume is read once at startup", () => {
  assert.notEqual(
    queryFingerprint(shape()),
    queryFingerprint(shape({ conversation: "sdk-session-2" })),
  );
});

test("the first conversation of a session rebuilds against no conversation at all", () => {
  assert.notEqual(
    queryFingerprint(shape({ conversation: undefined })),
    queryFingerprint(shape({ conversation: "sdk-session-1" })),
  );
});

test("an edited tuned prompt rebuilds, since the preset append is fixed at startup", () => {
  assert.notEqual(
    queryFingerprint(shape()),
    queryFingerprint(shape({}, { systemPromptAppend: "the tuned prompt, edited" })),
  );
});

test("an append of only whitespace is the same as no append", () => {
  // `#options` omits an empty append entirely, so the CLI is given the same thing either
  // way -- and spawning one to hand it the same thing would be the whole cost for none of
  // the benefit.
  assert.equal(
    queryFingerprint(shape({}, { systemPromptAppend: undefined })),
    queryFingerprint(shape({}, { systemPromptAppend: "   \n " })),
  );
});

test("a moved memory vault rebuilds, because settings go in at construction", () => {
  assert.notEqual(
    queryFingerprint(shape()),
    queryFingerprint(
      shape({ settings: { autoMemoryEnabled: true, autoMemoryDirectory: "D:/vault" } }),
    ),
  );
});

test("memory switched off rebuilds", () => {
  assert.notEqual(queryFingerprint(shape()), queryFingerprint(shape({ settings: null })));
});

test("a changed auto-approve list rebuilds, since allowedTools is not settable", () => {
  assert.notEqual(
    queryFingerprint(shape()),
    queryFingerprint(shape({}, { allowedTools: ["Read"] })),
  );
});

test("a changed maxTurns rebuilds", () => {
  assert.notEqual(queryFingerprint(shape()), queryFingerprint(shape({}, { maxTurns: 4 })));
});

test("turning on partial messages rebuilds", () => {
  assert.notEqual(
    queryFingerprint(shape()),
    queryFingerprint(shape({}, { includePartialMessages: true })),
  );
});

/** A configured backend, as `provider-config.ts` resolves one. */
function backend(change: Partial<Provider> = {}): Provider {
  return {
    key: "qwen-local",
    baseUrl: "http://127.0.0.1:8080",
    token: "agentide",
    host: "127.0.0.1",
    port: 8080,
    models: [{ id: "qwen3-coder-30b", name: "Qwen3 Coder 30B", supportsEffort: false }],
    detached: false,
    ...change,
  };
}

test("moving to a local backend rebuilds, because the CLI reads its URL once at startup", () => {
  assert.notEqual(queryFingerprint(shape()), queryFingerprint(shape({ provider: backend() })));
});

test("moving back to Anthropic rebuilds too", () => {
  assert.notEqual(
    queryFingerprint(shape({ provider: backend() })),
    queryFingerprint(shape({ provider: null })),
  );
});

test("the same backend twice keeps the query", () => {
  assert.equal(
    queryFingerprint(shape({ provider: backend() })),
    queryFingerprint(shape({ provider: backend() })),
  );
});

test("editing a provider's URL rebuilds, even under the same name", () => {
  // Compared by value, not by key: a query kept here would go on talking to the old
  // address while the picker showed the new one.
  assert.notEqual(
    queryFingerprint(shape({ provider: backend() })),
    queryFingerprint(shape({ provider: backend({ baseUrl: "http://127.0.0.1:1234" }) })),
  );
});

test("rotating the token rebuilds, since it is read at startup as well", () => {
  assert.notEqual(
    queryFingerprint(shape({ provider: backend() })),
    queryFingerprint(shape({ provider: backend({ token: "sk-new" }) })),
  );
});

test("a different model on the same backend is still a setter", () => {
  // `setModel` reaches a live query; the backend is what does not.
  assert.equal(
    queryFingerprint(shape({ provider: backend() })),
    queryFingerprint(shape({ provider: backend() }, { model: "qwen3-coder-7b" })),
  );
});

test("resumeConversation is not read directly; the conversation field carries it", () => {
  // The session adopts the id into `conversation` once and then follows the SDK's own
  // session id. Reading the option here as well would rebuild on every turn of a resumed
  // session, because the composer keeps sending the id it was given.
  assert.equal(
    queryFingerprint(shape()),
    queryFingerprint(shape({}, { resumeConversation: "some-old-conversation" })),
  );
});
