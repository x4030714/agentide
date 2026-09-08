/** The agent host sidecar: newline-delimited JSON in on stdin, out on stdout, and nothing else
 * owned here. stdout is the wire, so diagnostics go to stderr; closing stdin means shut down. */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { HostLink } from "./host.ts";
import { ModelCatalogue } from "./models.ts";
import { LineDecoder, parseHostMessage, type HostMessage } from "./protocol.ts";
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

function dispatch(message: HostMessage): void {
  switch (message.t) {
    case "prompt":
      // Not awaited: turns are long, and the loop must stay free to deliver the replies
      // this turn is about to ask for. `Session` serializes prompts per session itself.
      void sessionFor(message.sessionId)
        .prompt(message.cwd, message.text, message.options)
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
}

main();
