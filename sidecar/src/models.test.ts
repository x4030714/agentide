/**
 * The model catalogue: asked once, forwarded narrow, and never able to fail a turn.
 *
 * No SDK and no network here -- `publish` only needs something shaped like a `Query`,
 * and a stub says more about the caching rule than a real one would.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Query } from "@anthropic-ai/claude-agent-sdk";

import { HostLink } from "./host.ts";
import { ModelCatalogue } from "./models.ts";
import { SidecarMessageSchema } from "./protocol.ts";

/** A row as the SDK reports it, mode flags and all. */
const SDK_ROW = {
  value: "sonnet",
  resolvedModel: "claude-sonnet-5",
  displayName: "Sonnet 5",
  description: "Fast, for everyday coding",
  supportsEffort: true,
  supportedEffortLevels: ["low", "medium", "high"],
  supportsAdaptiveThinking: true,
  supportsFastMode: false,
  supportsAutoMode: true,
};

/**
 * Just enough `Query` to publish from.
 *
 * `commands` defaults to an empty list rather than being left off: `publish` asks for
 * both catalogues, and a stub missing one would fail for a reason that has nothing to do
 * with the model list the test is about.
 */
function fakeQuery(
  answer: () => Promise<unknown>,
  commands: () => Promise<unknown> = async () => [],
): { query: Query; calls: () => number } {
  let calls = 0;
  const query = {
    supportedModels: () => {
      calls += 1;
      return answer();
    },
    supportedCommands: commands,
  };
  return { query: query as unknown as Query, calls: () => calls };
}

/**
 * The model lines out of everything that was sent.
 *
 * `publish` sends the command catalogue too, so "nothing was sent" is no longer the same
 * claim as "no model list was sent" -- and it is the second one these tests are about.
 */
function modelLines(lines: string[]): string[] {
  return lines.filter((line) => line.includes(String.raw`"t":"models"`));
}

function collector(): { link: HostLink; lines: string[] } {
  const lines: string[] = [];
  return { link: new HostLink((line) => lines.push(line)), lines };
}

/** Let the `then` handlers inside `publish` run; nothing here awaits a turn. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("the first turn publishes the list and later turns do not ask again", async () => {
  const { link, lines } = collector();
  const { query, calls } = fakeQuery(() => Promise.resolve([SDK_ROW]));
  const catalogue = new ModelCatalogue(link);

  catalogue.publish(query);
  catalogue.publish(query);
  await settle();

  assert.equal(calls(), 1, "asked more than once");
  const models = modelLines(lines);
  assert.equal(models.length, 1, "published the model list more than once");
  const parsed = SidecarMessageSchema.safeParse(JSON.parse(models[0]!));
  assert.equal(parsed.success, true, parsed.error?.message);
  // Narrowed to the wire shape: the mode flags the protocol does not carry are dropped,
  // and `strictObject` would have rejected the message above if they had come through.
  assert.deepEqual(parsed.data, {
    t: "models",
    models: [
      {
        value: "sonnet",
        resolvedModel: "claude-sonnet-5",
        displayName: "Sonnet 5",
        description: "Fast, for everyday coding",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high"],
      },
    ],
  });
});

test("a row without the optional fields does not carry them onto the wire", async () => {
  const { link, lines } = collector();
  const { query } = fakeQuery(() =>
    Promise.resolve([{ value: "opus", displayName: "Opus", description: "Deep work" }]),
  );

  new ModelCatalogue(link).publish(query);
  await settle();

  assert.deepEqual(JSON.parse(lines[0]!), {
    t: "models",
    models: [{ value: "opus", displayName: "Opus", description: "Deep work" }],
  });
});

test("a rejected list sends nothing and does not throw into the turn", async () => {
  const { link, lines } = collector();
  const { query, calls } = fakeQuery(() => Promise.reject(new Error("no CLI")));
  const catalogue = new ModelCatalogue(link);

  catalogue.publish(query);
  await settle();
  // A build where this never works must not ask once per turn.
  catalogue.publish(query);
  await settle();

  assert.equal(calls(), 1);
  assert.deepEqual(modelLines(lines), []);
});

test("a list the SDK does not report as an array is skipped, not forwarded", async () => {
  const { link, lines } = collector();
  const { query } = fakeQuery(() => Promise.resolve(undefined));

  new ModelCatalogue(link).publish(query);
  await settle();

  assert.deepEqual(modelLines(lines), []);
});
