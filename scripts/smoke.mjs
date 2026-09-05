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
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 9222;
const ATTACH = process.argv.includes("--attach");
const RUN_TURN = !process.argv.includes("--no-turn");

const checks = [];
let child = null;

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
  writeFileSync(join(dir, "src", "main.rs"), "fn main() {\n    println!(\"smoke\");\n}\n");
  writeFileSync(join(dir, "README.md"), "# smoke\n\nA scratch workspace for scripts/smoke.mjs.\n");
  return dir.split("\\").join("/");
}

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

  if (RUN_TURN) {
    await page.type("textarea.composer-input", "Call ide_open_editors and report exactly what it returned.");
    await page.eval(
      `document.querySelector("textarea.composer-input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })), "sent"`,
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
