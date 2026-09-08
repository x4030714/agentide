/**
 * The path a person takes -- launch, open a folder, reach a file from the keyboard, send a
 * prompt, watch the agent call a tool. The seams the bugs live in; no unit test sees them.
 *
     node scripts/smoke.mjs           # launch, check, and run one real turn — costs money
     node scripts/smoke.mjs --attach  # use an app already running on the debug port
     node scripts/smoke.mjs --no-turn # skip the agent turn, and its cost, for free
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 9222;
const ATTACH = process.argv.includes("--attach");
const RUN_TURN = !process.argv.includes("--no-turn");

const checks = [];
let child = null;
/** Set by `main`, read by the teardown that removes this run's transcripts. */
let workspace = null;

const VITE_PORT = 1420;

/** PIDs of every running agentide.exe. Empty on anything that is not Windows. */
function appPids() {
  if (process.platform !== "win32") return [];
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq agentide.exe", "/FO", "CSV", "/NH"], {
      encoding: "utf8",
    });
    return [...out.matchAll(/"agentide\.exe","(\d+)"/g)].map((match) => Number(match[1]));
  } catch {
    return [];
  }
}

/** The PID listening on a port, or null. */
function portHolder(port) {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
    const line = out.split(/\r?\n/).find((row) => row.includes(`:${port} `) && row.includes("LISTENING"));
    const pid = line?.trim().split(/\s+/).pop();
    return pid ? Number(pid) : null;
  } catch {
    return null;
  }
}

/**
 * Synchronous on purpose: the signal path exits immediately, and an async spawn would be
 * abandoned before `taskkill` started -- the exact case the handler exists for.
 */
function kill(pid) {
  try {
    execFileSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" });
  } catch {
    /* Gone between listing it and killing it, which is the outcome anyway. */
  }
}

/** Taken before launch, so teardown only kills what this run is responsible for. */
const appsBefore = appPids();
const viteBefore = portHolder(VITE_PORT);

/** The directory name the SDK mangles a workspace path into ends with its last segment. */
function workspaceName(path) {
  return path ? path.split("/").filter(Boolean).pop() : null;
}

/** A tool's answer is multi-line by design; a check's detail column is not. */
function flatten(text) {
  return String(text ?? "").replace(/\s*\n\s*/g, " | ").trim();
}

function record(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  const mark = ok ? "  ok  " : " FAIL ";
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Poll until `fn` returns something truthy, or give up with a readable failure. */
async function until(what, fn, { timeoutMs = 30_000, everyMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last: ${String(last).slice(0, 120)})` : ""}`);
}

// --- A workspace of our own -------------------------------------------------------

// A scratch folder, not whatever the user last had open: a check that turns on someone's
// working directory is not a check, and the agent turn below can touch nothing real.

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "agentide-smoke-"));
  mkdirSync(join(dir, "src"));
  // A real crate, not a loose .rs file: `Cargo.toml` is what makes rust-analyzer start,
  // and the language-server checks below have nothing to ask without it.
  writeFileSync(
    join(dir, "Cargo.toml"),
    ['[package]', 'name = "smoke"', 'version = "0.0.0"', 'edition = "2021"', "", "[dependencies]", ""].join("\n"),
  );
  writeFileSync(join(dir, "src", "main.rs"), MAIN_RS);
  writeFileSync(join(dir, "README.md"), "# smoke\n\nA scratch workspace for scripts/smoke.mjs.\n");
  return dir.split("\\").join("/");
}

/**
 * The fixture the language-server checks are written against. Line numbers are asserted
 * below, and nothing reaches into `std`, which is not indexed without `rust-src`.
 */
const MAIN_RS = [
  "pub trait Greet {", //                1
  "    fn greet(&self) -> String;", //   2
  "}", //                                3
  "", //                                 4
  "pub struct Loud;", //                 5
  "pub struct Quiet;", //                6
  "", //                                 7
  "impl Greet for Loud {", //            8
  "    fn greet(&self) -> String {", //  9
  '        String::from("HEY")', //     10
  "    }", //                           11
  "}", //                               12
  "", //                                13
  "impl Greet for Quiet {", //          14
  "    fn greet(&self) -> String {", // 15
  '        String::from("hey")', //     16
  "    }", //                           17
  "}", //                               18
  "", //                                19
  "fn pick() -> impl Greet {", //       20
  "    Loud", //                        21
  "}", //                               22
  "", //                                23
  "fn main() {", //                     24
  "    let who = pick();", //           25
  '    println!("{}", who.greet());', //26
  "}", //                               27
  "",
].join("\n");

// --- Talking to the window --------------------------------------------------------

class Page {
  #ws;
  #id = 0;
  #pending = new Map();

  static async connect() {
    const target = await until(
      "the app's debug port",
      async () => {
        const response = await fetch(`http://127.0.0.1:${PORT}/json`);
        const pages = (await response.json()).filter((entry) => entry.type === "page");
        // A webview reports its blank starting page too, and that one has no origin --
        // reading `localStorage` there throws SecurityError rather than returning null.
        return pages.find((entry) => entry.url && entry.url !== "about:blank") ?? null;
      },
      { timeoutMs: 180_000, everyMs: 1000 },
    );

    const page = new Page();
    page.#ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      page.#ws.onopen = resolve;
      page.#ws.onerror = reject;
    });
    page.#ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const pending = page.#pending.get(message.id);
      if (!pending) return;
      page.#pending.delete(message.id);
      pending(message.result);
    };
    return page;
  }

  #send(method, params) {
    const id = ++this.#id;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate in the page and return the value. Throws what the page threw. */
  async eval(expression) {
    const result = await this.#send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result?.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "evaluate threw");
    }
    return result?.result?.value;
  }

  reload() {
    return this.#send("Page.reload", { ignoreCache: true });
  }

  /** A real key event on the window, the way the browser delivers one. */
  press(key, code = "") {
    return this.eval(
      `window.dispatchEvent(new KeyboardEvent("keydown", ${JSON.stringify({
        key,
        code,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })})) , "sent"`,
    );
  }

  /** Set a field's value the way typing does, so React's onChange sees it. */
  type(selector, text) {
    return this.eval(`(() => {
      const box = document.querySelector(${JSON.stringify(selector)});
      if (!box) return "missing";
      const proto = box instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
      Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(box, ${JSON.stringify(text)});
      box.dispatchEvent(new Event("input", { bubbles: true }));
      return "typed";
    })()`);
  }

  /** Call an `ide_*` tool the way the agent does, and get its result back. */
  tool(name, args) {
    return this.eval(
      `window.__ideTool(${JSON.stringify(name)}, ${JSON.stringify(args)})`,
    );
  }

  close() {
    this.#ws.close();
  }
}

// --- The checks -------------------------------------------------------------------

async function main() {
  workspace = makeWorkspace();
  console.log(`workspace: ${workspace}\n`);

  if (!ATTACH) {
    // A killed run never reaches teardown, so its Vite is still on 1420 and `tauri dev`
    // dies before it starts. Only a holder this run could have left is cleared.
    const stale = portHolder(VITE_PORT);
    if (stale && stale !== viteBefore) kill(stale);

    // One string, no argv array: with `shell: true` Node warns that arguments are
    // concatenated rather than escaped, and this command has no arguments to escape.
    child = spawn("npm run tauri dev", {
      cwd: process.cwd(),
      env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
      stdio: "ignore",
      shell: true,
      detached: false,
    });
  }

  const page = await Page.connect();
  await until(
    "the page to finish loading",
    () => page.eval(`document.readyState === "complete" && typeof localStorage === "object"`),
    { timeoutMs: 60_000 },
  );

  // Point the app at the scratch workspace and reload into it, rather than clicking
  // through a native folder dialog this script cannot drive.
  await page.eval(
    `localStorage.setItem("agentide.lastWorkspace", ${JSON.stringify(workspace)}), "set"`,
  );
  await page.reload();
  await new Promise((resolve) => setTimeout(resolve, 1500));

  await until("the window to render", () => page.eval(`document.querySelectorAll(".pane").length >= 4`));
  record("the app starts and draws its panes", true);

  const opened = await until("the workspace to open", async () => {
    const name = await page.eval(`document.querySelector(".titlebar-workspace")?.textContent ?? ""`);
    return name.startsWith("agentide-smoke") ? name : null;
  });
  record("it opens a workspace", true, opened);

  const treeRows = await until("the file tree", async () => {
    const rows = await page.eval(`document.querySelectorAll(".tree-row").length`);
    return rows > 0 ? rows : null;
  });
  record("the file tree lists the folder", treeRows >= 2, `${treeRows} rows`);

  // Ctrl+P: the keybinding, `list_files`, and the ranking, in one gesture.
  await page.press("p");
  await until("quick open", () => page.eval(`!!document.querySelector(".quick-open")`));
  await page.type(".quick-input", "mainrs");
  await new Promise((resolve) => setTimeout(resolve, 400));
  const top = await page.eval(`document.querySelector(".quick-row")?.innerText?.replace(/\\s+/g, " ") ?? ""`);
  record("Ctrl+P finds a file by name", top.includes("main.rs"), top || "no result");
  await page.eval(
    `document.querySelector(".quick-input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })), "closed"`,
  );

  // Opening the tree's first file proves the editor mounts and Ctrl+3 has a target. Which
  // file that is depends on the fixture, so the checks below use the name it reports.
  const openedFile = await page.eval(`(() => {
    const row = document.querySelector(".tree-row.is-file");
    if (!row) return "";
    row.click();
    return row.querySelector(".tree-name")?.textContent ?? row.textContent ?? "";
  })()`);
  await until("the editor", () => page.eval(`!!document.querySelector(".monaco-editor")`));
  await page.press("3", "Digit3");
  await new Promise((resolve) => setTimeout(resolve, 600));
  const focused = await page.eval(`!!document.activeElement?.closest(".pane.editor")`);
  record("Ctrl+3 focuses the editor", focused);

  const sidecarError = await page.eval(
    `document.querySelector(".transcript-body .is-error")?.textContent ?? ""`,
  );
  record("the agent host starts", !sidecarError, sidecarError || "no error row");

  // --- The language server ---------------------------------------------------------

  // Straight to the tools, not through the agent, so these are free and run in --no-turn.
  // A wrong capability at initialize fails quietly: an empty list, or an action with no edit.

  const rustFile = `${workspace}/src/main.rs`;

  // rust-analyzer runs `cargo metadata` and indexes before it can answer anything, and on
  // a cold cargo registry that is not instant. Poll rather than sleep.
  const hover = await until(
    "rust-analyzer to answer a hover",
    async () => {
      const result = await page.tool("ide_hover", { path: rustFile, line: 25, column: 9 });
      return result?.ok && (result.text ?? "").includes("impl Greet") ? result.text : null;
    },
    { timeoutMs: 180_000, everyMs: 3000 },
  );
  // Line 25 is `let who = pick();`. The type is written nowhere in the file: it exists
  // only in the server's inference, which is the whole reason the tool is worth having.
  record("ide_hover reports an inferred type", true, flatten(hover));

  const impls = await page.tool("ide_implementations", { path: rustFile, line: 1, column: 11 });
  const implText = impls?.text ?? impls?.error ?? "";
  record(
    "ide_implementations finds both impls",
    Boolean(impls?.ok) && implText.includes("main.rs:8") && implText.includes("main.rs:14"),
    flatten(implText),
  );

  const actions = await page.tool("ide_code_actions", { path: rustFile, line: 5, column: 12 });
  const actionText = actions?.text ?? actions?.error ?? "";
  // The assist list moves between releases, so only its shape is asserted: without
  // `codeActionLiteralSupport` the literals arrive as bare commands with nothing to apply.
  record(
    "ide_code_actions lists actions to apply",
    Boolean(actions?.ok) && /\n1\. \S/.test(actionText),
    flatten(actionText).slice(0, 120),
  );

  // Checked against the file on disk, not the tool's claim: assists arrive without edits,
  // so a build that skipped `codeAction/resolve` reports success and changes nothing.
  const before = readFileSync(`${workspace}/src/main.rs`, "utf8");
  const applied = await page.tool("ide_code_actions", {
    path: rustFile,
    line: 5,
    column: 12,
    apply: 1,
  });
  const after = readFileSync(`${workspace}/src/main.rs`, "utf8");
  record(
    "ide_code_actions applies one and the file changes",
    Boolean(applied?.ok) && after !== before,
    flatten(applied?.text ?? applied?.error).slice(0, 120),
  );

  if (RUN_TURN) {
    // Armed before Enter, because that is where the interval starts: everything up to the
    // first token is harness -- spawning the CLI and the MCP servers, building the prompt.
    await page.eval(`(() => {
      const marks = { sent: 0, init: 0, first: 0 };
      window.__ttft = marks;
      const root = document.querySelector('.transcript-body');
      const observer = new MutationObserver(() => {
        const now = performance.now();
        // A connected chip, not the strip: gated servers paint the strip before the turn
        // starts, so only an is-ok server means init landed and the prompt was built.
        if (!marks.init && document.querySelector('.mcp-server.is-ok')) marks.init = now;
        if (!marks.first && document.querySelector('.t-text, .t-thinking')) marks.first = now;
      });
      observer.observe(document.body, { childList: true, subtree: true });
      void root;
      return 'armed';
    })()`);
    await page.type("textarea.composer-input", "Call ide_open_editors and report exactly what it returned.");
    await page.eval(
      `document.querySelector("textarea.composer-input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })), (window.__ttft.sent = performance.now()), "sent"`,
    );

    const rows = await until(
      "the turn to finish",
      async () => {
        const running = await page.eval(
          `(document.querySelector("textarea.composer-input")?.placeholder ?? "").includes("running")`,
        );
        if (running) return null;
        const text = await page.eval(
          `[...(document.querySelector(".transcript-body")?.children ?? [])].map(r => r.innerText).join(String.fromCharCode(10))`,
        );
        return text.includes("success") || text.includes("error") ? text : null;
      },
      { timeoutMs: 180_000, everyMs: 2000 },
    );

    record("the agent calls a host tool", rows.includes("ide_open_editors"), "ide_open_editors row");
    // The tool's own answer names the file opened above, so this proves the round trip
    // reached the frontend and came back rather than merely being asked for.
    record(
      "the tool's answer reaches the model",
      openedFile !== "" && rows.includes(openedFile),
      `reply mentions ${openedFile || "(nothing was opened)"}`,
    );
    record("the turn completes", rows.includes("success"));

    const timing = await page.eval(`(() => {
      const t = window.__ttft || {};
      const ms = (a, b) => (a && b ? Math.round(b - a) : -1);
      return [ms(t.sent, t.init), ms(t.sent, t.first)].join(',');
    })()`);
    const [toInit, toFirst] = String(timing).split(",").map(Number);
    record(
      "time to first token, and how much of it was harness",
      toFirst > 0,
      toInit > 0
        ? `${toFirst}ms total, ${toInit}ms of it before the model (${Math.round((toInit / toFirst) * 100)}%)`
        : `${toFirst}ms total, init not observed`,
    );

    // The strip comes from init, so it answers "could the model see these tools" -- MCP
    // startup is non-blocking. Reported, not asserted: the server list is the person's.
    const strip = await page.eval(`[...document.querySelectorAll(".mcp-server")]
      .map((row) => row.getAttribute("title"))
      .join(" | ")`);
    record(
      "the MCP strip reports the servers the turn started with",
      typeof strip === "string",
      strip || "(no servers configured)",
    );
  } else {
    console.log("  skip  the agent turn (--no-turn)");
  }

  page.close();
}

/** Everything this run is responsible for, released. Safe to call twice. */
let cleaned = false;
function cleanUp() {
  if (cleaned) return;
  cleaned = true;
  // Killing npm is not enough: `tauri dev` re-parents Vite and agentide.exe, and they
  // outlive the tree. Only PIDs missing from the pre-launch snapshot are killed.
  if (child) {
    try {
      process.platform === "win32"
        ? execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" })
        : child.kill();
    } catch {
      /* Already gone. */
    }
    for (const pid of appPids().filter((pid) => !appsBefore.includes(pid))) kill(pid);
    const holder = portHolder(VITE_PORT);
    if (holder && holder !== viteBefore) kill(holder);
  }

  // The scratch workspace is a real one to the SDK, so a turn leaves a transcript in
  // ~/.claude/projects, at the top of the import list. Nine piled up before anyone looked.
  try {
    const projects = join(homedir(), ".claude", "projects");
    const leaf = workspaceName(workspace);
    for (const entry of readdirSync(projects)) {
      if (leaf && entry.endsWith(leaf)) {
        rmSync(join(projects, entry), { recursive: true, force: true });
      }
    }
  } catch {
    /* No transcripts to clean, or no store at all. Not a failure of the run. */
  }
}

/**
 * `finally` covers a run that finishes or throws, not one that is killed -- and that is the
 * run that leaves Vite on 1420 and agentide.exe on the binary the next build must relink.
 */
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  process.on(signal, () => {
    cleanUp();
    process.exit(130);
  });
}

main()
  .catch((error) => {
    record("smoke run", false, error.message);
  })
  .finally(() => {
    cleanUp();
    const failed = checks.filter((check) => !check.ok);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
    process.exitCode = failed.length > 0 ? 1 : 0;
  });
