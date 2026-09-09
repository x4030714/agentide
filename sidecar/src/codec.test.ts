/** Codec and mirror tests for the wire protocol. Half of a pair: `src-tauri/src/agent.rs`
 * runs the same fixture through the Rust types, and both must pass. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  encodeLine,
  HostMessageSchema,
  LineDecoder,
  parseHostMessage,
  SidecarMessageSchema,
  type HostMessage,
  type SidecarMessage,
} from "./protocol.ts";

interface Fixture {
  name: string;
  message: Record<string, unknown>;
}

const fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL("../protocol-fixtures.json", import.meta.url)), "utf8"),
) as { hostToSidecar: Fixture[]; sidecarToHost: Fixture[] };

const allFixtures = [...fixtures.hostToSidecar, ...fixtures.sidecarToHost];

/** Validates against the schema, not the raw object: TypeScript types erase, so only the
 * schema notices a field renamed, retyped or dropped on this side. */
function checkAgainstSchema(cases: Fixture[], schema: typeof HostMessageSchema | typeof SidecarMessageSchema) {
  assert.notEqual(cases.length, 0, "no fixtures to check");
  for (const fixture of cases) {
    const parsed = schema.safeParse(fixture.message);
    assert.equal(parsed.success, true, `${fixture.name}: ${parsed.error?.message ?? ""}`);
    // `strictObject` drops nothing and admits nothing, so anything the schema does not
    // describe shows up as a difference here.
    assert.deepEqual(parsed.data, fixture.message, fixture.name);
  }
}

test("host fixtures match the schema", () => {
  checkAgainstSchema(fixtures.hostToSidecar, HostMessageSchema);
});

test("sidecar fixtures match the schema", () => {
  checkAgainstSchema(fixtures.sidecarToHost, SidecarMessageSchema);
});

test("every fixture survives an encode/decode round trip unchanged", () => {
  for (const fixture of allFixtures) {
    const line = encodeLine(fixture.message as unknown as HostMessage | SidecarMessage);
    assert.equal(line.endsWith("\n"), true, fixture.name);
    assert.equal(line.slice(0, -1).includes("\n"), false, `${fixture.name} must be one line`);
    assert.deepEqual(JSON.parse(line), fixture.message, fixture.name);
  }
});

/** Tags read off the discriminator. Derived, not hand-listed: a hand-kept list gets updated
 * in the same edit that adds the variant, so it would never demand a fixture. */
function declaredTags(schema: { options: readonly { shape: { t: { value: string } } }[] }): string[] {
  return schema.options.map((option) => option.shape.t.value).sort();
}

function fixtureTags(cases: Fixture[]): string[] {
  return [...new Set(cases.map((f) => String(f.message.t)))].sort();
}

test("the fixtures cover every message variant", () => {
  assert.deepEqual(
    fixtureTags(fixtures.hostToSidecar),
    declaredTags(HostMessageSchema),
    "a HostMessage variant has no fixture",
  );
  assert.deepEqual(
    fixtureTags(fixtures.sidecarToHost),
    declaredTags(SidecarMessageSchema),
    "a SidecarMessage variant has no fixture",
  );
});

test("host fixtures parse as host messages and unknown tags are rejected", () => {
  for (const fixture of fixtures.hostToSidecar) {
    assert.equal(parseHostMessage(JSON.stringify(fixture.message)).t, fixture.message.t);
  }
  assert.throws(() => parseHostMessage('{"t":"launch_missiles"}'), /unreadable host message/);
  assert.throws(() => parseHostMessage("[1,2,3]"), /unreadable host message/);
  assert.throws(() => parseHostMessage("not json"));
  // A known tag with the wrong shape must fail here rather than inside a handler.
  assert.throws(() => parseHostMessage('{"t":"ping"}'), /unreadable host message/);
  assert.throws(
    () => parseHostMessage('{"t":"interrupt","sessionId":"s","extra":1}'),
    /unreadable host message/,
  );
  assert.throws(
    () => parseHostMessage('{"t":"tool_reply","id":"c","result":{"ok":true}}'),
    /unreadable host message/,
  );
});

/** The whole fixture set as one stream, which is what the decoder actually faces. */
function fixtureStream(): Buffer {
  return Buffer.from(
    allFixtures
      .map((f) => encodeLine(f.message as unknown as HostMessage | SidecarMessage))
      .join(""),
    "utf8",
  );
}

test("a message split across chunk boundaries is reassembled", () => {
  const stream = fixtureStream();
  // Sweep the chunk size so every boundary lands mid-message at least once, including
  // one byte at a time -- the worst case a pipe can hand us.
  for (const size of [1, 2, 3, 7, 13, 64, 1000, stream.length]) {
    const decoder = new LineDecoder();
    const lines: string[] = [];
    for (let at = 0; at < stream.length; at += size) {
      lines.push(...decoder.push(stream.subarray(at, at + size)));
    }
    assert.equal(decoder.flush(), null, `chunk size ${size} left a partial line`);
    assert.equal(lines.length, allFixtures.length, `chunk size ${size}`);
    lines.forEach((line, index) => {
      assert.deepEqual(JSON.parse(line), allFixtures[index]?.message, `chunk size ${size}`);
    });
  }
});

test("a multi-byte character split across chunks is not corrupted", () => {
  // Every character here is 2-4 bytes, so a 1-byte chunker splits inside all of them.
  const message: HostMessage = {
    t: "prompt",
    sessionId: "s-1",
    cwd: "C:/tmp",
    text: "\u00e9\u4e2d\u6587\ud83d\ude80\u00fc",
  };
  const bytes = Buffer.from(encodeLine(message), "utf8");
  const decoder = new LineDecoder();
  const lines: string[] = [];
  for (const byte of bytes) lines.push(...decoder.push(Buffer.from([byte])));
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), message);
});

test("a line longer than the read buffer is reassembled, however it is chunked", () => {
  // 512 KiB of text in one message: far past any plausible pipe read size.
  const message: HostMessage = {
    t: "prompt",
    sessionId: "big",
    cwd: "C:/tmp",
    text: "x".repeat(512 * 1024),
  };
  const stream = Buffer.from(`${encodeLine(message)}${encodeLine({ t: "ping", id: "after" })}`);

  for (const size of [1024, 8192, 65536]) {
    const decoder = new LineDecoder();
    const lines: string[] = [];
    for (let at = 0; at < stream.length; at += size) {
      lines.push(...decoder.push(stream.subarray(at, at + size)));
    }
    assert.equal(lines.length, 2, `chunk size ${size}`);
    assert.deepEqual(JSON.parse(lines[0]!), message, `chunk size ${size}`);
    // The message after the long one must still line up.
    assert.deepEqual(JSON.parse(lines[1]!), { t: "ping", id: "after" }, `chunk size ${size}`);
    assert.equal(decoder.flush(), null);
  }
});

test("the decoder gives up rather than buffering an unbounded line", () => {
  const decoder = new LineDecoder(1024);
  assert.throws(() => decoder.push(Buffer.alloc(4096, 0x61)), /desynchronized/);
  // The carry is dropped, so the next complete line still decodes.
  assert.deepEqual(decoder.push('{"t":"ping","id":"x"}\n'), ['{"t":"ping","id":"x"}']);
});

test("blank lines and CRLF terminators do not become messages", () => {
  const decoder = new LineDecoder();
  const lines = decoder.push('\r\n\n{"t":"ping","id":"a"}\r\n\n{"t":"ping","id":"b"}\n');
  assert.deepEqual(lines, ['{"t":"ping","id":"a"}', '{"t":"ping","id":"b"}']);
});

test("flush returns a trailing line that never got its terminator", () => {
  const decoder = new LineDecoder();
  assert.deepEqual(decoder.push('{"t":"ping","id":"a"}'), []);
  assert.equal(decoder.flush(), '{"t":"ping","id":"a"}');
  assert.equal(decoder.flush(), null);
});
