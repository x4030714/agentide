/** `/resume` offers this workspace's conversations and nobody else's. The directory name
 * is a lossy mangling of the path, so the check against a record's own `cwd` is load-bearing. */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ago, listConversations, mangle, transcriptDir } from "./conversations.ts";

/** One transcript, written the way the SDK writes them: one JSON record per line. */
async function transcript(
  home: string,
  cwd: string,
  id: string,
  records: object[],
): Promise<string> {
  const dir = transcriptDir(cwd, home);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return file;
}

function prompt(text: string, cwd: string): object {
  return {
    type: "user",
    cwd,
    sessionId: "ignored",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agentide-resume-"));
}

test("the workspace path is mangled the way the SDK does it", () => {
  // The same vector `conversations.rs` pins. Both files have to agree or the CLI looks in
  // a directory the app never writes to and reports no conversations at all.
  assert.equal(mangle("C:\\Users\\tung\\Desktop\\agentide"), "C--Users-tung-Desktop-agentide");
  assert.equal(mangle("/home/x/y.z"), "-home-x-y-z");
});

test("a workspace with no conversations lists nothing rather than failing", () => {
  // The ordinary first run. A thrown error here would make `/resume` look broken on the
  // one day it has the least to say.
  return home().then(async (root) => {
    assert.deepEqual(await listConversations("C:/nowhere", 10, root), []);
  });
});

test("conversations come back newest first, with their opening prompt", async () => {
  const root = await home();
  const cwd = "C:/work/proj";
  await transcript(root, cwd, "aaa", [prompt("older question", cwd)]);
  await transcript(root, cwd, "bbb", [prompt("newer question", cwd)]);
  // mtime is what orders them, and two files written in the same millisecond do not sort.
  const { utimes } = await import("node:fs/promises");
  await utimes(join(transcriptDir(cwd, root), "aaa.jsonl"), new Date(1000), new Date(1000));
  await utimes(join(transcriptDir(cwd, root), "bbb.jsonl"), new Date(9000), new Date(9000));

  const found = await listConversations(cwd, 10, root);
  assert.deepEqual(
    found.map((entry) => entry.id),
    ["bbb", "aaa"],
  );
  assert.equal(found[0]?.opening, "newer question");
});

test("a transcript belonging to another workspace is not offered", async () => {
  // `C:/a.b` and `C:/a/b` mangle identically; the record's own cwd is the only thing
  // stopping a resume into another project's conversation.
  const root = await home();
  const cwd = "C:/a/b";
  await transcript(root, cwd, "mine", [prompt("my question", cwd)]);
  await transcript(root, cwd, "theirs", [prompt("their question", "C:/a.b")]);

  const found = await listConversations(cwd, 10, root);
  assert.deepEqual(
    found.map((entry) => entry.id),
    ["mine"],
  );
});

test("a session opened and abandoned is not offered", async () => {
  // Nothing was asked, so there is nothing to continue. A row for it would be a row with
  // no label that resumes an empty conversation.
  const root = await home();
  const cwd = "C:/work/empty";
  await transcript(root, cwd, "blank", [{ type: "system", cwd, subtype: "init" }]);
  assert.deepEqual(await listConversations(cwd, 10, root), []);
});

test("a string message reads the same as a list of blocks", async () => {
  // Both shapes appear in real transcripts; reading only one silently blanks the label.
  const root = await home();
  const cwd = "C:/work/shapes";
  await transcript(root, cwd, "plain", [
    { type: "user", cwd, message: { role: "user", content: "just a string" } },
  ]);
  const found = await listConversations(cwd, 10, root);
  assert.equal(found[0]?.opening, "just a string");
});

test("a corrupt line does not lose the conversation after it", async () => {
  // Transcripts are appended to while a turn runs, so a half-written last line is normal.
  const root = await home();
  const cwd = "C:/work/torn";
  const dir = transcriptDir(cwd, root);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "torn.jsonl"),
    `{"type":"user","cwd":"${cwd}",\n${JSON.stringify(prompt("survived", cwd))}\n`,
  );
  const found = await listConversations(cwd, 10, root);
  assert.equal(found[0]?.opening, "survived");
});

test("the limit is applied before any file is opened", async () => {
  const root = await home();
  const cwd = "C:/work/many";
  for (let index = 0; index < 5; index += 1) {
    await transcript(root, cwd, `c${index}`, [prompt(`question ${index}`, cwd)]);
  }
  assert.equal((await listConversations(cwd, 2, root)).length, 2);
});

test("a long opening is cut, so one row stays one row", async () => {
  const root = await home();
  const cwd = "C:/work/long";
  await transcript(root, cwd, "wordy", [prompt("x".repeat(500), cwd)]);
  const found = await listConversations(cwd, 10, root);
  assert.ok((found[0]?.opening.length ?? 0) <= 160);
});

test("how long ago reads as a person would say it", () => {
  const now = Date.now();
  assert.equal(ago(now - 5_000, now), "just now");
  assert.equal(ago(now - 120_000, now), "2m ago");
  assert.equal(ago(now - 7_200_000, now), "2h ago");
  assert.equal(ago(now - 172_800_000, now), "2d ago");
  assert.ok(ago(now - 86_400_000 * 90, now).endsWith("mo ago"));
});

test("a harness-written record is not mistaken for the question", async () => {
  // Local-command output arrives as a `user` message wrapped in `<local-command-caveat>`.
  // Labelling the row with it shows a paragraph of boilerplate where the question goes.
  const root = await home();
  const cwd = "C:/work/wrapped";
  await transcript(root, cwd, "wrapped", [
    prompt("<local-command-caveat>Caveat: the messages below were generated…", cwd),
    prompt("the real question", cwd),
  ]);
  const found = await listConversations(cwd, 10, root);
  assert.equal(found[0]?.opening, "the real question");
});
