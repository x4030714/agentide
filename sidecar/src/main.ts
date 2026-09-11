/** The agent host sidecar: newline-delimited JSON in on stdin, out on stdout, and nothing else
 * owned here. stdout is the wire, so diagnostics go to stderr; closing stdin means shut down. */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { accountUsed, findAccount, loadAccounts, DEFAULT_KEY, type Account } from "./accounts.ts";
import { account, signOut } from "./auth.ts";
import { HostLink } from "./host.ts";
import { ModelCatalogue } from "./models.ts";
import {
  LineDecoder,
  parseHostMessage,
  type AccountInfo,
  type HostMessage,
} from "./protocol.ts";
import { checkup } from "./doctor.ts";
import { loadProviders, publicProviders } from "./provider-config.ts";
import { Session } from "./session.ts";

const sessions = new Map<string, Session>();
const link = new HostLink((line) => process.stdout.write(line));
/** One per process: the first turn of any session publishes the list for all of them. */
const models = new ModelCatalogue(link);

function log(text: string): void {
  process.stderr.write(`[agent-host] ${text}\n`);
}

function sdkVersion(): string {
  try {
    // The package does not export `./package.json`, so read the manifest beside the entry
    // point. Informational only -- an unknown version is not fatal.
    const require = createRequire(import.meta.url);
    const entry = require.resolve("@anthropic-ai/claude-agent-sdk");
    const manifest = readFileSync(join(dirname(entry), "package.json"), "utf8");
    return (JSON.parse(manifest) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function sessionFor(sessionId: string): Session {
  let session = sessions.get(sessionId);
  if (!session) {
    session = new Session(link, sessionId, models);
    sessions.set(sessionId, session);
  }
  return session;
}

/** One account as the wire carries it. No credential crosses -- an account is a directory,
 * and what is inside it belongs to Claude Code. */
function publicAccount(entry: Account): AccountInfo {
  return {
    key: entry.key,
    name: entry.name,
    configDir: entry.configDir,
    used: accountUsed(entry),
  };
}

function dispatch(message: HostMessage): void {
  switch (message.t) {
    case "prompt":
      // Not awaited: turns are long, and the loop must stay free to deliver the replies
      // this turn is about to ask for. `Session` serializes prompts per session itself.
      void sessionFor(message.sessionId)
        .prompt(message.cwd, message.text, message.options, message.attachments)
        .catch((error: unknown) => log(`turn on ${message.sessionId} failed: ${describe(error)}`));
      return;

    case "permission_reply": {
      const delivered = link.settle(message.id, {
        decision: message.decision,
        updatedInput: message.updatedInput,
        message: message.message,
      });
      if (!delivered) log(`permission reply ${message.id} arrived with nobody waiting`);
      return;
    }

    case "tool_reply":
      if (!link.settle(message.id, message.result)) {
        log(`tool reply ${message.id} arrived with nobody waiting`);
      }
      return;

    case "warm": {
      // Fire and forget: nothing waits for it, and a failure here is not a failed turn --
      // the next prompt prepares again and reports properly.
      void sessionFor(message.sessionId).warm(message.cwd as string, message.options);
      return;
    }
    case "auth": {
      // Re-read every time, like `providers.json`: the file is meant to be edited, and a
      // picker told once would go stale the moment an account was added.
      const accounts = loadAccounts();
      const key = message.account ?? DEFAULT_KEY;
      const profile = findAccount(accounts, key);
      if (!profile) {
        // Named rather than silently falling back: running under the wrong account is the
        // one outcome here worth failing for.
        link.send({
          t: "account",
          account: { loggedIn: false, error: `no account named "${key}" in accounts.json` },
          key,
          accounts: accounts.map(publicAccount),
          });
        return;
      }
      // Both actions answer with the same message: after a sign-out the surface needs the
      // new state, not just word that it happened, or it would draw the old account until
      // something else refreshed it.
      const note = message.action === "logout" ? signOut(profile).message : undefined;
      link.send({
        t: "account",
        account: account(profile),
        key,
        accounts: accounts.map(publicAccount),
        ...(note ? { note } : {}),
      });
      return;
    }
    case "interrupt": {
      const session = sessions.get(message.sessionId);
      if (!session) {
        log(`interrupt for unknown session ${message.sessionId}`);
        return;
      }
      void session.interrupt();
      return;
    }

    case "ping":
      link.send({ t: "pong", id: message.id });
  }
}

function shutdown(code: number): void {
  link.failAll("the IDE disconnected");
  for (const session of sessions.values()) session.dispose();
  sessions.clear();
  process.exit(code);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function main(): void {
  const decoder = new LineDecoder();

  process.stdin.on("data", (chunk: Buffer) => {
    let lines: string[];
    try {
      lines = decoder.push(chunk);
    } catch (error) {
      // The stream is desynchronized; nothing after this point can be trusted.
      log(describe(error));
      shutdown(1);
      return;
    }
    for (const line of lines) {
      try {
        dispatch(parseHostMessage(line));
      } catch (error) {
        // One bad line is the host's bug, not a reason to drop the ones after it.
        log(`ignoring unreadable line: ${describe(error)}`);
      }
    }
  });

  // The host closes stdin to ask for a clean exit; it kills the process only if this
  // does not land. Disposing the sessions closes the SDK's own child processes.
  process.stdin.on("end", () => shutdown(0));
  process.stdin.on("error", (error) => {
    log(`stdin failed: ${describe(error)}`);
    shutdown(1);
  });

  // A broken stdout means the host is gone; there is nowhere left to report it.
  process.stdout.on("error", () => shutdown(0));

  process.on("uncaughtException", (error) => {
    log(`uncaught: ${describe(error)}`);
    shutdown(1);
  });
  process.on("unhandledRejection", (error) => {
    log(`unhandled rejection: ${describe(error)}`);
  });

  link.send({ t: "ready", pid: process.pid, sdkVersion: sdkVersion() });

  // Before any turn, unlike the model catalogue: providers come from a file, not from a live
  // query. That is what lets the first prompt already offer a local model.
  link.send({ t: "providers", providers: publicProviders(loadProviders()) });

  // Said before the first prompt rather than after it fails. The SDK's own answer to a
  // missing credential is "Please run /login", a command only its own TUI has -- so the
  // window has to say what is wrong and what to do about it itself.
  link.send({ t: "readiness", problems: checkup() });
}

main();
