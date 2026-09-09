/** A fresh install must be told what is missing before it spends a turn finding out. The
 * SDK's own answer names `/login`, a command only its own TUI has. */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { checkup, onPath, ready, signedIn } from "./doctor.ts";

async function home(withCredentials: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentide-doctor-"));
  if (withCredentials) {
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(join(root, ".claude", ".credentials.json"), "{}");
  }
  return root;
}

test("a machine that has never run Claude Code is not signed in", async () => {
  assert.equal(signedIn({}, await home(false)), false);
});

test("credentials on disk count", async () => {
  assert.equal(signedIn({}, await home(true)), true);
});

test("an API key counts, with no credentials file anywhere", async () => {
  // How this runs in CI and in a container, where nobody does a browser flow.
  assert.equal(signedIn({ ANTHROPIC_API_KEY: "sk-x" }, await home(false)), true);
  assert.equal(signedIn({ ANTHROPIC_AUTH_TOKEN: "t" }, await home(false)), true);
});

test("CLAUDE_CONFIG_DIR moves where the credentials are looked for", async () => {
  // Set, the whole directory moves — looking in `~/.claude` would report a signed-in
  // machine as signed out.
  const root = await home(true);
  assert.equal(signedIn({ CLAUDE_CONFIG_DIR: join(root, ".claude") }, "C:/nowhere"), true);
});

test("not signed in blocks a turn, and says what to type", async () => {
  const problems = checkup({ PATH: "" }, await home(false), false);
  const auth = problems.find((problem) => problem.title.includes("Not signed in"));
  assert.ok(auth, "a fresh machine must be told");
  assert.equal(auth?.severity, "blocked");
  assert.ok(auth?.fix.includes("/login"), auth?.fix);
  assert.equal(ready(problems), false);
});

test("a missing git is a warning, not a wall", async () => {
  // No checkpoints means no undo, which is worth saying loudly — but it must not stop
  // someone using the agent to read a codebase.
  const problems = checkup({ PATH: "" }, await home(true), false);
  const git = problems.find((problem) => problem.title.startsWith("git is not"));
  assert.equal(git?.severity, "degraded");
  assert.ok(git?.fix.length);
});

test("a missing language server is a warning too", async () => {
  const problems = checkup({ PATH: "" }, await home(true), false);
  assert.equal(
    problems.find((problem) => problem.title.includes("rust-analyzer"))?.severity,
    "degraded",
  );
});

test("degraded problems still leave the machine ready", async () => {
  // The whole point of the two levels: no git and no rust-analyzer is a worse agentide,
  // not a broken one, and refusing to run would be the wrong call.
  const problems = checkup({ PATH: "", ANTHROPIC_API_KEY: "sk-x" }, await home(false), false);
  assert.ok(problems.length > 0, "git and rust-analyzer are both missing here");
  assert.equal(ready(problems), true);
});

test("a configured local backend counts instead of a login", async () => {
  // Telling someone running Qwen on their own GPU to go and sign in to Anthropic is
  // simply wrong: that turn needs no credential at all.
  const problems = checkup({ PATH: "" }, await home(false), true);
  assert.equal(problems.find((problem) => problem.title.includes("Not signed in")), undefined);
  assert.equal(ready(problems), true);
});

test("PATH is read for real", () => {
  // The check has to be able to find something, or every machine reports missing tools.
  assert.equal(onPath("node"), true);
  assert.equal(onPath("definitely-not-a-real-program-xyz"), false);
});
