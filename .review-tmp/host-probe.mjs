/**
 * Plays the Rust host: launches the built sidecar exactly as `agent.rs` does, sends one
 * prompt, answers whatever it asks, and prints every tool call and all of its stderr.
 *
 * This is the same path the app takes, minus the window -- so a difference between this
 * and the app is the app's fault, and a match here is the truth about the SDK.
 */

import { spawn } from "node:child_process";

const CWD = "C:/Users/tung/Desktop/agentide";
const prompt = process.argv[2] ?? "List the ide_ tools you can call, by exact name.";

const child = spawn("node", ["sidecar/dist/main.js"], {
  cwd: CWD,
  stdio: ["pipe", "pipe", "pipe"],
});

child.stderr.on("data", (chunk) => process.stderr.write(`[stderr] ${chunk}`));

let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let cut;
  while ((cut = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, cut);
    buffer = buffer.slice(cut + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

function handle(message) {
  switch (message.t) {
    case "ready":
      console.log(`ready: pid ${message.pid}, sdk ${message.sdkVersion}`);
      send({ t: "prompt", sessionId: "s-1", cwd: CWD, text: prompt });
      return;

    case "tool_call":
      // The thing being tested: does an ide_* call ever arrive here at all?
      console.log(`>>> TOOL CALL ${message.name} ${JSON.stringify(message.args)}`);
      send({
        t: "tool_reply",
        id: message.id,
        result: { ok: true, text: `stub answer for ${message.name}` },
      });
      return;

    case "permission_request":
      console.log(`permission: ${message.tool}`);
      send({ t: "permission_reply", id: message.id, decision: "allow" });
      return;

    case "event": {
      const msg = message.msg;
      if (msg.type === "system" && msg.subtype === "init") {
        const tools = msg.tools ?? [];
        console.log("mcp_servers:", JSON.stringify(msg.mcp_servers ?? null));
        console.log("ide tools in prompt:", JSON.stringify(tools.filter((t) => String(t).includes("ide_"))));
        console.log("tool count:", tools.length);
        console.log("ALL:", tools.join(" "));
      }
      if (msg.type === "assistant") {
        for (const block of msg.message?.content ?? []) {
          if (block.type === "text" && block.text.trim()) {
            console.log("say:", block.text.trim().slice(0, 400));
          }
          if (block.type === "tool_use") console.log("uses:", block.name);
        }
      }
      return;
    }

    case "done":
      console.log(`done: ${message.reason}${message.error ? ` (${message.error})` : ""}`);
      child.stdin.end();
      setTimeout(() => process.exit(0), 500);
  }
}

setTimeout(() => {
  console.log("TIMEOUT");
  child.kill();
  process.exit(1);
}, 180_000).unref();
