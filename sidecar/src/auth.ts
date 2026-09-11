/**
 * Who is signed in, and the two ways to change that.
 *
 * `doctor.ts` answers the cheap question -- is there a credential file -- because it runs on
 * every startup and must not cost a spawn. This answers the real one by asking the binary:
 * `claude auth status` knows the account, the plan and whether the token still works, none of
 * which a file's existence can tell you. One spawn, and only when someone opens the account
 * surface or acts on it.
 */

import { spawnSync } from "node:child_process";

import { accountEnv, type Account as Profile } from "./accounts.ts";
import { claudeBinary } from "./doctor.ts";

/** Long enough for a cold binary on a slow disk, short enough not to hang the UI on one. */
const STATUS_MS = 15_000;
/** Signing out is a network round trip as well as a file delete. */
const LOGOUT_MS = 30_000;

/** What the account surface draws. Everything but `loggedIn` is missing on some auth methods. */
export interface Account {
  loggedIn: boolean;
  /** `claude.ai` for a subscription, `console` for API billing. */
  method?: string;
  email?: string;
  organization?: string;
  /** `pro`, `max`, `team` -- whatever the account actually has. */
  plan?: string;
  /** Why the answer is not trustworthy, when the binary could not be asked at all. */
  error?: string;
  /** What to run in a terminal to sign in. Carried with the account so the window never
   * has to resolve the binary itself. */
  loginCommand?: string;
}

/**
 * The environment one account's binary runs under.
 *
 * Spread over `process.env`, never in place of it: a bare `CLAUDE_CONFIG_DIR` would drop
 * `PATH` and the binary would not start. `undefined` means the machine's own directory,
 * which is the environment we already have.
 */
function envFor(profile: Profile | undefined): NodeJS.ProcessEnv {
  return profile ? { ...process.env, ...accountEnv(profile) } : process.env;
}

/** A field of `claude auth status --json`, when it is a non-empty string. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The account, from the binary that owns the credential.
 *
 * Never throws: every failure -- no binary, a spawn error, JSON that changed shape -- comes
 * back as signed out with a reason. An account panel that crashes the pane it lives in is
 * worse than one that says it does not know.
 */
export function account(profile?: Profile): Account {
  const binary = claudeBinary();
  if (!binary) {
    return { loggedIn: false, error: "the bundled Claude Code binary is missing" };
  }
  // Quoted: the default install path has a space in it on every Windows machine.
  const loginCommand = loginCommandFor(binary, profile);
  const done = spawnSync(binary, ["auth", "status", "--json"], {
    encoding: "utf8",
    timeout: STATUS_MS,
    windowsHide: true,
    env: envFor(profile),
  });
  if (done.error) return { loggedIn: false, error: done.error.message, loginCommand };

  try {
    const parsed = JSON.parse(done.stdout) as Record<string, unknown>;
    return {
      loggedIn: parsed.loggedIn === true,
      method: text(parsed.authMethod),
      email: text(parsed.email),
      organization: text(parsed.orgName),
      plan: text(parsed.subscriptionType),
      loginCommand,
    };
  } catch {
    // A non-zero exit with no JSON is the ordinary signed-out answer, not a fault.
    return { loggedIn: false, loginCommand };
  }
}

/** The sign-in command for one account, as a terminal would need it. Shared so the field on
 * `Account` and the standalone `loginCommand` can never disagree. */
function loginCommandFor(binary: string, profile: Profile | undefined): string {
  if (!profile) return `"${binary}" auth login`;
  return `set "CLAUDE_CONFIG_DIR=${profile.configDir}" && "${binary}" auth login`;
}

/** What the outcome of signing out was, in words the surface can show as-is. */
export interface Outcome {
  ok: boolean;
  message: string;
}

/**
 * Sign out, machine-wide.
 *
 * This is not scoped to agentide: it drops the credential the person's own Claude Code uses
 * too. Every caller confirms first -- the CLI asks, the window asks -- because nothing here
 * can put it back, and the way back is a browser round trip.
 */
export function signOut(profile?: Profile): Outcome {
  const binary = claudeBinary();
  if (!binary) {
    return { ok: false, message: "the bundled Claude Code binary is missing" };
  }
  const done = spawnSync(binary, ["auth", "logout"], {
    encoding: "utf8",
    timeout: LOGOUT_MS,
    windowsHide: true,
    env: envFor(profile),
  });
  if (done.error) return { ok: false, message: done.error.message };
  if (done.status !== 0) {
    // Its own complaint beats ours: it knows whether this was a network failure or a
    // credential that was already gone.
    const said = (done.stderr || done.stdout || "").trim().split("\n")[0];
    return { ok: false, message: said || `claude auth logout exited ${done.status}` };
  }
  return { ok: true, message: "signed out" };
}

/**
 * The command that signs in, for a caller that owns a terminal.
 *
 * Not run here: signing in is a device code to read and a browser to click through, so it
 * needs a terminal a person can see. The CLI hands over its own; the window runs this in a
 * terminal tab. Quoted because the default install path has a space in it.
 */
export function loginCommand(profile?: Profile): string | null {
  const binary = claudeBinary();
  return binary ? loginCommandFor(binary, profile) : null;
}
