/**
 * That a name which is not a model is caught when it is typed, not when a turn runs on it.
 *
 * `/model opus-5` used to be accepted in silence and fail on the next prompt from inside
 * the SDK -- `Model "opus-5" is not a recognized model id` -- which spends a turn and reads
 * as the agent breaking rather than as a typo two prompts ago. That exact case is the
 * first test here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { modelRows, pickModel } from "./cli-models.ts";
import { theme, width } from "./cli-theme.ts";
import type { ModelInfo } from "./protocol.ts";

/** What `supportedModels()` reports, trimmed to the fields a picker uses. */
const MODELS: ModelInfo[] = [
  { value: "default", displayName: "Default (recommended)", description: "Sonnet 5 · routine tasks" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "Efficient for routine tasks" },
  { value: "opus", resolvedModel: "claude-opus-5", displayName: "Opus", description: "Best for everyday, complex tasks" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5", displayName: "Haiku", description: "Fastest for quick answers" },
];

test("the typo that cost a turn is caught, and named", () => {
  // The reported bug, exactly: `opus-5` is not a model id, `opus` is, and they differ by
  // two characters. A refusal that did not say so would leave someone guessing.
  const { chosen, suggestion } = pickModel("opus-5", MODELS);
  assert.equal(chosen, undefined, "a name that is not a model must not be accepted");
  assert.equal(suggestion?.value, "opus");
});

test("a real name is taken", () => {
  assert.equal(pickModel("haiku", MODELS).chosen?.value, "haiku");
});

test("case does not matter", () => {
  // `Opus` and `opus` are the same request, and refusing one of them is a refusal nobody
  // can act on.
  assert.equal(pickModel("Opus", MODELS).chosen?.value, "opus");
});

test("the canonical id finds the alias that carries it", () => {
  // The picker sends `value`, but a person copies `claude-opus-5` out of a log or a config
  // and expects it to work.
  assert.equal(pickModel("claude-opus-5", MODELS).chosen?.value, "opus");
});

test("the display name works too", () => {
  assert.equal(pickModel("Default (recommended)", MODELS).chosen?.value, "default");
});

test("an exact match is never treated as a near one", () => {
  // `sonnet` is a prefix of `claude-sonnet-5`; matching near-first would make the exact
  // name a suggestion and refuse a request that was correct.
  const { chosen, suggestion } = pickModel("sonnet", MODELS);
  assert.equal(chosen?.value, "sonnet");
  assert.equal(suggestion, undefined);
});

test("a prefix suggests what it is the start of", () => {
  assert.equal(pickModel("hai", MODELS).suggestion?.value, "haiku");
});

test("something resembling nothing suggests nothing", () => {
  // A wrong guess is worse than none: it would be offered as the answer to a question the
  // user never asked.
  assert.deepEqual(pickModel("zzzzz", MODELS), {});
});

test("empty picks nothing rather than the first model", () => {
  // `/model` on its own lists; it must never silently switch to whatever is at the top.
  assert.deepEqual(pickModel("   ", MODELS), {});
});

test("every model is listed once, numbered in a stable order", () => {
  // The numbers are what gets typed next, so the order has to survive being printed twice.
  const rows = modelRows(MODELS, "opus");
  assert.equal(rows.length, MODELS.length);
  assert.ok(rows[0]?.includes("1"));
  assert.ok(rows[2]?.includes("Opus"));
  assert.deepEqual(modelRows(MODELS, "opus"), rows);
});

test("the running model is the only one marked", () => {
  const painted = theme({ isTTY: true }, { COLORTERM: "truecolor" });
  const rows = modelRows(MODELS, "opus", painted);
  const marked = rows.filter((row) => row.includes("›"));
  assert.equal(marked.length, 1);
  assert.ok(marked[0]?.includes("Opus"));
});

test("the marker finds the model through its canonical id", () => {
  // `--model claude-haiku-4-5` is how the CLI is often started, and a list that marked
  // nothing would say the choice had not taken effect.
  const rows = modelRows(MODELS, "claude-haiku-4-5", theme({ isTTY: true }, {}));
  assert.ok(rows[3]?.includes("›"), rows[3]);
});

test("nothing is marked when no model was chosen", () => {
  assert.equal(modelRows(MODELS, undefined).filter((row) => row.includes("›")).length, 0);
});

test("no row runs off the terminal", () => {
  const wordy: ModelInfo[] = [
    { value: "x", displayName: "X", description: "a very long description ".repeat(20) },
  ];
  for (const row of modelRows(wordy, "x", theme({ isTTY: true }, {}), 70)) {
    assert.ok(width(row) <= 70, `${width(row)} columns: ${row}`);
  }
});
