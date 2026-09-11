/** An account is a directory, not a credential. The tests that matter are about which
 * directory a turn ends up reading, and about a bad file never taking the picker down. */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_KEY,
  accountEnv,
  accountUsed,
  defaultAccount,
  findAccount,
  loadAccounts,
} from "./accounts.ts";

/** A home directory with an optional `accounts.json` in it. */
async function home(contents?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentide-accounts-"));
  if (contents !== undefined) {
    await mkdir(join(root, ".agentide"), { recursive: true });
    await writeFile(join(root, ".agentide", "accounts.json"), contents);
  }
  return root;
}

test("a machine with no accounts.json still offers the login it already has", async () => {
  const accounts = loadAccounts(await home(), {});
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.key, DEFAULT_KEY);
});

test("the default account follows CLAUDE_CONFIG_DIR when the machine sets one", async () => {
  const moved = defaultAccount({ CLAUDE_CONFIG_DIR: "D:/elsewhere" }, "C:/Users/dev");
  assert.equal(moved.configDir, "D:/elsewhere");
  const plain = defaultAccount({}, "C:/Users/dev");
  assert.equal(plain.configDir, join("C:/Users/dev", ".claude"));
});

test("a relative configDir resolves against home, so `.claude-work` means what it looks like", async () => {
  const root = await home(JSON.stringify({ accounts: { work: { configDir: ".claude-work" } } }));
  const work = findAccount(loadAccounts(root, {}), "work");
  assert.equal(work?.configDir, join(root, ".claude-work"));
});

test("an absolute configDir is left alone", async () => {
  const root = await home(JSON.stringify({ accounts: { work: { configDir: "D:/claude-work" } } }));
  assert.equal(findAccount(loadAccounts(root, {}), "work")?.configDir, "D:/claude-work");
});

test("the key names the account when no name is given", async () => {
  const root = await home(JSON.stringify({ accounts: { work: { configDir: "D:/w" } } }));
  assert.equal(findAccount(loadAccounts(root, {}), "work")?.name, "work");
});

test("`default` is reserved, so the machine's own login can always be switched back to", async () => {
  const root = await home(
    JSON.stringify({ accounts: { default: { configDir: "D:/hijacked" } } }),
  );
  const accounts = loadAccounts(root, {});
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.configDir, join(root, ".claude"));
});

test("one broken entry does not take the others with it", async () => {
  const root = await home(
    JSON.stringify({
      accounts: {
        broken: { nonsense: true },
        work: { configDir: "D:/w" },
      },
    }),
  );
  const accounts = loadAccounts(root, {});
  assert.deepEqual(accounts.map((entry) => entry.key), [DEFAULT_KEY, "work"]);
});

test("a file that is not an object at all leaves the default standing", async () => {
  const root = await home("[]");
  assert.deepEqual(loadAccounts(root, {}).map((entry) => entry.key), [DEFAULT_KEY]);
});

test("a disabled account is not offered", async () => {
  const root = await home(
    JSON.stringify({ accounts: { work: { configDir: "D:/w", disabled: true } } }),
  );
  assert.deepEqual(loadAccounts(root, {}).map((entry) => entry.key), [DEFAULT_KEY]);
});

test("an unknown key resolves to nothing rather than to the default", async () => {
  // Silently running a turn under the wrong account is the one outcome worth failing for.
  assert.equal(findAccount(loadAccounts(await home(), {}), "nope"), null);
  assert.equal(findAccount(loadAccounts(await home(), {}), undefined), null);
});

test("the environment names the directory, and nothing else", () => {
  const env = accountEnv({ key: "work", name: "Work", configDir: "D:/w" });
  assert.deepEqual(env, { CLAUDE_CONFIG_DIR: "D:/w" });
});

test("an account is used once its directory holds a credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentide-used-"));
  const account = { key: "work", name: "Work", configDir: root };
  assert.equal(accountUsed(account), false);
  await writeFile(join(root, ".credentials.json"), "{}");
  assert.equal(accountUsed(account), true);
});
