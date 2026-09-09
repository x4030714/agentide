/**
 * Take the CLI's children down with it.
 *
 * The desktop app has `src-tauri/src/reaper.rs` and a Windows job object; the CLI is a Node
 * process and can make no such thing. So this covers the paths where Windows still runs our
 * code -- Ctrl+C, a `taskkill` without `/F`, an unhandled throw, and the terminal going away
 * -- by killing the whole tree from our own pid down.
 *
 * What it cannot cover is `taskkill /F` on this process, where no handler runs at all. That
 * is the case the app needs a job object for, and the reason `reaper.rs` exists rather than
 * an exit handler. Here it leaks a `claude.exe` and whatever MCP servers it started.
 */

import { execFileSync } from "node:child_process";

/** Set once the tree has been killed, so a second signal does not spawn a second taskkill. */
let reaped = false;

/**
 * Kill this process and everything under it.
 *
 * `/T` is the point: the SDK spawns `claude.exe`, which spawns every configured MCP server,
 * and none of those are ours to enumerate. Including our own pid is deliberate -- we are
 * exiting anyway, and it is the only spelling of "this tree" Windows takes.
 */
function killTree(): void {
  if (reaped) return;
  reaped = true;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(process.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      // The process group, which a POSIX shell gives us for free.
      process.kill(-process.pid, "SIGTERM");
    }
  } catch {
    // Already gone, or taskkill is missing. Nothing here is worth failing an exit over.
  }
}

/**
 * Install the handlers. `dispose` is the session's own shutdown, run first so a turn ends
 * cleanly when there is time for it.
 *
 * `release` undoes it, for the ordinary exit path -- which wants no `taskkill` at all,
 * because the SDK closes the CLI's stdin and it shuts itself down.
 */
export function guard(dispose: () => void): void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"];

  const onSignal = () => {
    try {
      dispose();
    } catch {
      /* going down regardless */
    }
    killTree();
  };
  const onThrow = (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    onSignal();
  };

  for (const signal of signals) process.on(signal, onSignal);
  process.on("uncaughtException", onThrow);
  process.on("unhandledRejection", onThrow);

  remove = () => {
    for (const signal of signals) process.off(signal, onSignal);
    process.off("uncaughtException", onThrow);
    process.off("unhandledRejection", onThrow);
  };
}

/** Module-level so the exit paths can reach it: they are in `repl`, not where `guard` ran. */
let remove: (() => void) | null = null;

/** Stand down. The caller is leaving on its own terms and its children go with it. */
export function release(): void {
  remove?.();
  remove = null;
}
