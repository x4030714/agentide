/**
 * More than one Claude account on one machine.
 *
 * There is no per-account credential store to write: Claude Code keeps exactly one, in
 * `CLAUDE_CONFIG_DIR` (`~/.claude` unless that is set). So an account here is not a
 * credential -- it is a *directory*, and switching accounts is switching which directory the
 * turn's CLI reads. Nothing in this file holds a token, and signing in is still the browser
 * doing it, once per directory.
 *
 * The consequence worth knowing: that directory holds conversation history and settings as
 * well as the credential. Switching accounts also switches what `/resume` can see. That is
 * arguably right -- it is that account's history -- but it is a bigger switch than the word
 * "account" suggests, so the surfaces say so.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import { issues, readJson, warn } from "./config-file.ts";

/** Beside `providers.json`, `mcp.json` and `memory.json`: one directory to remember. */
const CONFIG_PATH = join(".agentide", "accounts.json");

/** The key every account entry reserves for the machine's existing login. */
export const DEFAULT_KEY = "default";

const AccountSchema = z.strictObject({
  /** What the picker shows. Defaults to the key, which is usually already a name. */
  name: z.string().min(1).optional(),
  /**
   * The `CLAUDE_CONFIG_DIR` this account signs in under. Relative paths resolve against the
   * home directory, so `.claude-work` means what it looks like.
   */
  configDir: z.string().min(1),
  disabled: z.boolean().optional(),
});

export interface Account {
  /** The key in the file. Stable, and what the wire and `queryFingerprint` carry. */
  key: string;
  name: string;
  /** Absolute, resolved. This is the value that goes on the environment. */
  configDir: string;
}

/**
 * The machine's existing login, as an entry.
 *
 * Always present and never configured, so the picker has something to switch *back* to. Its
 * directory is what the CLI already uses, which means selecting it sets `CLAUDE_CONFIG_DIR`
 * to the value it would have had anyway.
 */
export function defaultAccount(env: NodeJS.ProcessEnv = process.env, home = homedir()): Account {
  return {
    key: DEFAULT_KEY,
    name: "Default",
    configDir: env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"),
  };
}

/** Every account the file names, the machine's own first. A bad entry is skipped, not fatal. */
export function loadAccounts(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): Account[] {
  const accounts = [defaultAccount(env, home)];
  const parsed = readJson(join(home, CONFIG_PATH), "accounts");
  if (parsed === null) return accounts;

  const file = z
    .object({ accounts: z.record(z.string(), z.unknown()).optional() })
    .safeParse(parsed);
  if (!file.success) {
    warn(`${CONFIG_PATH}: ${issues(file.error)}; its accounts were skipped`);
    return accounts;
  }

  for (const [key, value] of Object.entries(file.data.accounts ?? {})) {
    if (key === DEFAULT_KEY) {
      // Reserved, because the picker must always be able to get back to the login the
      // machine had before agentide was installed.
      warn(`accounts.json: "${key}" is reserved and was ignored`);
      continue;
    }
    const entry = AccountSchema.safeParse(value);
    if (!entry.success) {
      warn(`accounts.json: "${key}" was ignored -- ${issues(entry.error)}`);
      continue;
    }
    if (entry.data.disabled) continue;

    const configured = entry.data.configDir;
    accounts.push({
      key,
      name: entry.data.name ?? key,
      configDir: isAbsolute(configured) ? configured : join(home, configured),
    });
  }
  return accounts;
}

/** The account a key names, or null. An unknown key is not the default: silently running a
 * turn under the wrong account is the one outcome worth failing for. */
export function findAccount(accounts: Account[], key: string | undefined): Account | null {
  if (!key) return null;
  return accounts.find((account) => account.key === key) ?? null;
}

/**
 * Spread over `process.env` by the caller, never in place of it -- `Options.env` replaces the
 * subprocess environment whole.
 *
 * The default account sets the variable to the directory it would have used anyway rather
 * than omitting it: an explicit value is what makes a switch *back* take effect, where
 * leaving it unset would inherit whatever the last one set.
 */
export function accountEnv(account: Account): Record<string, string> {
  return { CLAUDE_CONFIG_DIR: account.configDir };
}

/** Whether this account has ever been signed in -- the directory exists and holds a
 * credential. Cheap: `auth status` per account would be one spawn per row. */
export function accountUsed(account: Account): boolean {
  return existsSync(join(account.configDir, ".credentials.json"));
}
