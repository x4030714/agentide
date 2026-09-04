import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

import { LspClient, clientCapabilities } from "../src/lib/lsp-client";
import type { Json } from "../src/lib/lsp-client";
import { uriToPath } from "../src/lib/lsp-session";
import { toFileUri } from "../src/lib/protocol";
import type { WirePath } from "../src/lib/protocol";

/**
 * Drives the real rust-analyzer through the real client, with Node doing the framing that
 * Rust does in the app. Not part of the suite — it needs a toolchain and takes a minute.
 *
 *   npx vitest run --include '.review-tmp/**\/*.test.ts' --exclude 'node_modules/**'
 *
 * What it proves that a unit test cannot: that our capabilities are accepted, that a
 * diagnostic comes back addressed to a URI we can match, and that hover and completion
 * return the shapes the Monaco converters assume.
 */

const ROOT = "C:/Users/tung/Desktop/agentide/src-tauri" as WirePath;
const FILE = `${ROOT}/src/lsp.rs` as WirePath;

it(
  "answers a real rust-analyzer session",
  async () => {
    const child = spawn("rust-analyzer", [], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    const log: string[] = [];
    const diagnostics: Array<{ uri: string; count: number }> = [];
    // Quiescence, not "the first token ended": rust-analyzer opens several progress
    // tokens and the fast ones finish in milliseconds. Waiting on one of those is how
    // this test probed a server that had not looked at the crate yet.
    const open = new Set<string>();
    let seen = 0;
    let settle: NodeJS.Timeout | null = null;
    let ready: (() => void) | null = null;
    const indexed = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const checkQuiescent = () => {
      if (settle) clearTimeout(settle);
      if (seen > 0 && open.size === 0) settle = setTimeout(() => ready?.(), 3000);
    };

    const client = new LspClient(
      (message) => {
        const body = Buffer.from(JSON.stringify(message), "utf8");
        child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
        child.stdin.write(body);
      },
      {
        onNotification: (method, params) => {
          if (method === "textDocument/publishDiagnostics") {
            diagnostics.push({
              uri: String(params.uri),
              count: (params.diagnostics as unknown[]).length,
            });
          }
          if (method === "$/progress") {
            const token = String(params.token ?? "");
            const value = params.value as Json;
            if (value?.kind === "begin") {
              seen += 1;
              open.add(token);
            } else if (value?.kind === "end") {
              open.delete(token);
            }
            checkQuiescent();
          }
        },
        onLog: (line) => log.push(line),
      },
    );

    // The same `Content-Length` framing `src-tauri/src/lsp.rs` implements.
    let buffer = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const split = buffer.indexOf("\r\n\r\n");
        if (split < 0) return;
        const header = buffer.subarray(0, split).toString("ascii");
        const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? 0);
        if (buffer.length < split + 4 + length) return;
        const body = buffer.subarray(split + 4, split + 4 + length).toString("utf8");
        buffer = buffer.subarray(split + 4 + length);
        client.receive(JSON.parse(body) as Json);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => log.push(chunk.toString("utf8")));

    const init = await client.request<{ capabilities?: Json }>("initialize", {
      processId: null,
      clientInfo: { name: "agentide", version: "0.1.0" },
      rootUri: toFileUri(ROOT),
      workspaceFolders: [{ uri: toFileUri(ROOT), name: "src-tauri" }],
      capabilities: clientCapabilities(),
    });
    client.initialized = true;
    client.notify("initialized", {});
    expect(init.capabilities).toBeTruthy();
    expect(init.capabilities?.hoverProvider).toBeTruthy();
    expect(init.capabilities?.completionProvider).toBeTruthy();

    const text = readFileSync(FILE, "utf8");
    client.notify("textDocument/didOpen", {
      textDocument: { uri: toFileUri(FILE), languageId: "rust", version: 1, text },
    });

    await Promise.race([indexed, new Promise((r) => setTimeout(r, 180_000))]);

    // Where in the file `pub fn` appears, so the probe lands on a real symbol.
    const lines = text.split("\n");
    const line = lines.findIndex((entry) => /pub (async )?fn \w/.test(entry));
    expect(line).toBeGreaterThan(-1);
    const character = lines[line].indexOf("fn ") + 4;

    const hover = await client.request<Json>("textDocument/hover", {
      textDocument: { uri: toFileUri(FILE) },
      position: { line, character },
    });
    // A function name is not a completion context, so ask somewhere one exists: an empty
    // statement position in a function body. Sent as a `didChange` so this also exercises
    // full-text sync -- the server has to be answering about the text we just pushed, not
    // about what is on disk.
    const probe = [text, "fn __agentide_probe() {", "    ", "}", ""].join("\n");
    client.notify("textDocument/didChange", {
      textDocument: { uri: toFileUri(FILE), version: 2 },
      contentChanges: [{ text: probe }],
    });
    const probeLine = probe.split("\n").length - 3;
    const completion = await client.request<Json>("textDocument/completion", {
      textDocument: { uri: toFileUri(FILE) },
      position: { line: probeLine, character: 4 },
    });

    const report = {
      hoverContents: hover?.contents ? Object.keys(hover.contents as Json) : null,
      hoverIsMarkup:
        typeof (hover?.contents as Json)?.kind === "string"
          ? (hover?.contents as Json).kind
          : Array.isArray(hover?.contents)
            ? "array"
            : typeof hover?.contents,
      completionShape: Array.isArray(completion) ? "array" : Object.keys(completion ?? {}),
      completionCount: Array.isArray(completion)
        ? completion.length
        : ((completion?.items as unknown[]) ?? []).length,
      completionSample: (Array.isArray(completion)
        ? completion
        : ((completion?.items as Json[]) ?? [])
      )
        .slice(0, 5)
        .map((item) => `${item.label} (kind ${item.kind})`),
      diagnosticUris: [...new Set(diagnostics.map((entry) => entry.uri))].slice(0, 3),
      diagnosticsMatchOurPath: diagnostics.some(
        (entry) => uriToPath(entry.uri) === FILE || uriToPath(entry.uri).startsWith(ROOT),
      ),
      stderrTail: log.slice(-3),
    };
    console.log(JSON.stringify(report, null, 2));

    expect(hover).toBeTruthy();
    expect(report.completionCount).toBeGreaterThan(0);
    // The point of the whole URI exercise: what comes back resolves to a path we hold.
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(report.diagnosticsMatchOurPath).toBe(true);

    client.notify("exit");
    child.kill();
  },
  240_000,
);
