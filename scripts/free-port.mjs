/**
 * Kill a Vite left holding the dev port, before starting another one.
 *
 * `strictPort` is on because Tauri's `devUrl` names 1420 exactly, so a stale listener does
 * not move the server -- it fails the launch. And the stale listener is the normal case, not
 * a rare one: killing `npm run tauri dev` reliably leaves its Vite child running, so the
 * next launch dies on a port its own previous run never released. That failure names the
 * port and nothing else, which is why it has cost this project an afternoon more than once.
 *
 * Only ever kills a `node`: anything else on 1420 is someone else's, and taking it out to
 * start a dev server is not a trade this script gets to make on its own.
 */

import { execFileSync } from "node:child_process";

const PORT = Number(process.argv[2] ?? 1420);

/** The PIDs listening on `PORT`, however this platform reports them. */
function listeners() {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" });
      const pids = new Set();
      for (const line of out.split("\n")) {
        // `LISTENING` only: an outbound connection *to* 1420 is a client, not the squatter.
        if (!line.includes("LISTENING")) continue;
        // The PID is the last column, not a fixed one: an IPv6 row carries the same fields
        // in wider columns, and counting from the left picked up "LISTENING" as the pid.
        const fields = line.trim().split(/\s+/);
        const local = fields[1];
        const pid = fields[fields.length - 1];
        if (local?.endsWith(`:${PORT}`) && /^\d+$/.test(pid ?? "")) pids.add(pid);
      }
      return [...pids];
    }
    const out = execFileSync("lsof", ["-ti", `tcp:${PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    return out.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    // Nothing listening: both tools exit non-zero when they match nothing.
    return [];
  }
}

/** What a PID is running, lowercased, or "" when it cannot be told. */
function nameOf(pid) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        encoding: "utf8",
      });
      return (out.split(",")[0] ?? "").replace(/"/g, "").trim().toLowerCase();
    }
    return execFileSync("ps", ["-p", pid, "-o", "comm="], { encoding: "utf8" }).trim().toLowerCase();
  } catch {
    return "";
  }
}

function kill(pid) {
  if (process.platform === "win32") execFileSync("taskkill", ["/PID", pid, "/F"], { stdio: "ignore" });
  else process.kill(Number(pid), "SIGKILL");
}

for (const pid of listeners()) {
  const name = nameOf(pid);
  if (!name.startsWith("node")) {
    // Reported, not killed. Vite will fail on the port next and say so; this line is what
    // explains why.
    console.log(`port ${PORT} is held by ${name || "an unknown process"} (${pid}) — left alone`);
    continue;
  }
  try {
    kill(pid);
    console.log(`freed port ${PORT} — killed a stale ${name} (${pid})`);
  } catch (error) {
    console.log(`could not free port ${PORT}: ${error.message}`);
  }
}
