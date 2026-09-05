/**
 * The end-to-end check: does the app actually work?
 *
 * Every other test in this repository covers a piece. This covers the path a person
 * takes -- launch, open a folder, see the files, reach one from the keyboard, send a
 * prompt, watch the agent call a tool and answer. Those seams are exactly where the
 * bugs in this project have lived: an MCP server whose tools never reached the model,
 * a bundle Node refused to load, a keybinding killed by a throw in its own guard. Not
 * one of them would have failed a unit test.
 *
 *   node scripts/smoke.mjs           # launch the app, run the checks, report
 *   node scripts/smoke.mjs --attach  # use an app already running on the debug port
 *   node scripts/smoke.mjs --no-turn # skip the agent turn (and its cost)
 *
 * This spends money by default: one short turn against the user's own Claude
 * credentials. `--no-turn` covers everything up to the agent and costs nothing, which
 * is the right mode for a quick "did I break the shell".
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 9222;
const ATTACH = process.argv.includes("--attach");
const RUN_TURN = !process.argv.includes("--no-turn");

const checks = [];
let child = null;

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
//
// Not whatever folder the user last had open: a check that passes or fails depending on
// someone's working directory is not a check. A scratch folder also means the agent turn
// below cannot touch anything real.

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
 * The fixture the language-server checks are written against.
 *
 * Deliberately shaped: a trait with two implementations (so `ide_implementations` has a
 * right answer and a wrong one -- references would also return the two `impl` lines *and*
 * the bound on line 1), a function whose return type is inferred rather than written (so
 * hover reports something the text does not contain), and no `std` beyond `println!`,
 * because `rust-src` is not installed on this machine and anything reaching into `std`
 * would fail for a reason that has nothing to do with the tools.
 *
 * Line numbers are asserted below, so edits here mean edits there.
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
  const workspace = makeWorkspace();
  console.log(`workspace: ${workspace}\n`);

  if (!ATTACH) {
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

  // Opening it proves the editor mounts and Ctrl+3 has something to focus.
  // Whichever file the tree lists first -- directories sort above files, so which one
  // that is depends on the fixture. The assertion below uses what was actually opened
  // rather than assuming, which is the difference between a check and a coin flip.
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
  //
  // These call the tools directly rather than through the agent, so they cost nothing and
  // run in --no-turn. What they cover is the part no unit test reaches: the capabilities
  // we send at initialize decide the *shape* of what comes back, and a wrong one there
  // does not fail loudly -- it produces an empty list, or an action with no edit, which
  // reads as "nothing to do here" all the way to the model.

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
  // Not asserting a particular action: rust-analyzer's assist list moves between releases.
  // What must hold is that actions arrive as literals with titles at all -- the failure
  // this guards is `codeActionLiteralSupport` going missing, which turns the list into
  // bare commands and every one of them into "has no edit to apply".
  record(
    "ide_code_actions lists actions to apply",
    Boolean(actions?.ok) && /\n1\. \S/.test(actionText),
    flatten(actionText).slice(0, 120),
  );

  // Applying is the half that can silently do nothing: rust-analyzer sends its assists
  // without edits and computes one only when asked, so a build that skipped
  // `codeAction/resolve` would report success here and change no file at all. The check
  // is therefore against the file on disk, not against the tool's own claim.
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
    // Where the turn's latency actually goes. Armed before the prompt is sent, because
    // the interval that matters starts at Enter: everything up to the first token is
    // harness -- spawning the CLI, spawning and connecting each MCP server, building
    // the prompt -- and none of it is the model thinking.
    await page.eval(`(() => {
      const marks = { sent: 0, init: 0, first: 0 };
      window.__ttft = marks;
      const root = document.querySelector('.transcript-body');
      const observer = new MutationObserver(() => {
        const now = performance.now();
        // The MCP strip is written from the init message, so its arrival is the moment
        // the prompt was built and the harness handed over.
        if (!marks.init && document.querySelector('.mcp-strip')) marks.init = now;
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

    // The MCP strip is written from the init message, which is the moment the turn's
    // prompt was built. That is the only place the answer to "could the model see
    // these tools" is visible: MCP startup is non-blocking, so a server can be
    // running and useful by the time the turn ends and still have contributed nothing
    // to the prompt the model was given. Reported rather than asserted -- which
    // servers are configured is the person's business, not this script's.
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

main()
  .catch((error) => {
    record("smoke run", false, error.message);
  })
  .finally(() => {
    if (child) {
      // The app was launched here, so it is stopped here; a leftover window holding the
      // debug port would make the next run attach to the wrong build.
      try {
        process.platform === "win32"
          ? spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" })
          : child.kill();
      } catch {
        /* Already gone. */
      }
    }
    const failed = checks.filter((check) => !check.ok);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
    process.exitCode = failed.length > 0 ? 1 : 0;
  });
