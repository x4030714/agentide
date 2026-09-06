/**
 * Where the vault lands, and what a bad config file costs.
 *
 * Real files in a temporary tree rather than a stubbed `fs`, for the same reason
 * `mcp-config.test.ts` uses one: the module is a file read plus a fallback, so a fake
 * filesystem would only prove the fake behaves.
 *
 * The other half of these cases is the settings object. It is what the SDK is handed and
 * the only thing standing between a memory write and an unprompted edit in Review mode,
 * and nothing downstream would notice if the ask rules stopped naming the vault.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { loadMemoryConfig, memorySettings } from "./memory-config.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * A home directory, with `.agentide/memory.json` in it when text is given.
 *
 * `null` means the file is absent, which is the normal case: the default is meant to
 * work for someone who never writes one.
 */
function home(text: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "agentide-memory-"));
  roots.push(root);
  mkdirSync(join(root, ".agentide"), { recursive: true });
  if (text !== null) writeFileSync(join(root, ".agentide", "memory.json"), text, "utf8");
  return root;
}

/** The home path as the loader spells one back: forward slashes, no trailing slash. */
function slashed(path: string): string {
  return path.split("\\").join("/");
}

/**
 * Run with stderr collected instead of printed.
 *
 * Two cases turn on the warning -- a config that was silently ignored is the failure this
 * module is written to avoid -- and letting the rest through would bury the runner's own
 * output. Synchronous, because the loader is: there is no window in which a warning could
 * escape a restored `write`.
 */
function capture<T>(body: () => T): { value: T; stderr: string } {
  const original = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: body(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

test("a machine with no config file still has a vault", () => {
  const dir = home(null);
  const { value, stderr } = capture(() => loadMemoryConfig(dir));

  assert.deepEqual(value, { vault: `${slashed(dir)}/agentide-vault`, enabled: true });
  // Absence is the normal case, not a misconfiguration.
  assert.equal(stderr, "");
});

test("a vault the file names is used instead of the default", () => {
  const dir = home(JSON.stringify({ vault: "D:/notes/second-brain" }));

  assert.equal(loadMemoryConfig(dir).vault, "D:/notes/second-brain");
});

test("a ~/ in the configured path resolves against the home the loader was given", () => {
  // `~` is what someone writes by hand, and it is the SDK's own spelling -- but the app
  // reads this path too, to seed the folder and to keep the editor off it, and neither of
  // those can pass a tilde to the filesystem.
  const dir = home(JSON.stringify({ vault: "~/Documents/vault" }));

  assert.equal(loadMemoryConfig(dir).vault, `${slashed(dir)}/Documents/vault`);
});

test("a backslashed path comes back forward-slashed, like every other path here", () => {
  const dir = home(JSON.stringify({ vault: "D:\\notes\\vault\\" }));

  assert.equal(loadMemoryConfig(dir).vault, "D:/notes/vault");
});

test("memory turned off tells the SDK so and grants nothing", () => {
  const dir = home(JSON.stringify({ enabled: false }));
  const config = loadMemoryConfig(dir);

  assert.equal(config.enabled, false);
  // No directory and no ask rules: an off switch that still handed out a write rule for
  // the vault would be an off switch in name only.
  assert.deepEqual(memorySettings(config), { autoMemoryEnabled: false });
});

test("a config that is not valid JSON costs the override, not the turn", () => {
  const dir = home('{ "vault": ,, }');
  const { value, stderr } = capture(() => loadMemoryConfig(dir));

  assert.equal(value.vault, `${slashed(dir)}/agentide-vault`);
  assert.equal(value.enabled, true);
  assert.match(stderr, /memory\.json/);
});

test("a config of the wrong shape says so rather than being ignored", () => {
  // Silently falling back would leave someone editing a file that does nothing, which is
  // the same bug as a skipped MCP entry that warns about nothing.
  const dir = home(JSON.stringify({ vault: 42 }));
  const { value, stderr } = capture(() => loadMemoryConfig(dir));

  assert.equal(value.vault, `${slashed(dir)}/agentide-vault`);
  assert.match(stderr, /default vault/);
});

test("the vault is named in both ask rules, since a note is written either way", () => {
  // Write for a new note, Edit for an amended one. Covering only Write would let the
  // memory system revise an existing note without ever prompting.
  const settings = memorySettings({ vault: "C:/Users/tung/agentide-vault", enabled: true });

  assert.deepEqual(settings, {
    autoMemoryEnabled: true,
    autoMemoryDirectory: "C:/Users/tung/agentide-vault",
    permissions: {
      ask: [
        "Write(C:/Users/tung/agentide-vault/**)",
        "Edit(C:/Users/tung/agentide-vault/**)",
      ],
    },
  });
});

test("an edit to the config is picked up without restarting the process", () => {
  const dir = home(JSON.stringify({ vault: "D:/first" }));
  assert.equal(loadMemoryConfig(dir).vault, "D:/first");

  writeFileSync(join(dir, ".agentide", "memory.json"), JSON.stringify({ vault: "D:/second" }), "utf8");
  // Nothing is cached, on purpose: this is read once a turn, and a moved vault should
  // land on the next prompt rather than the next launch.
  assert.equal(loadMemoryConfig(dir).vault, "D:/second");
});
