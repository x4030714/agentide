/**
 * Drives the running app over the WebView2 debugging port.
 *
 * Used to prove an end-to-end path that no unit test can reach: a real model, calling a
 * real `ide_*` tool, answered by the real language server. Everything is done through the
 * page's own event handlers -- setting a value and dispatching `input` the way a keystroke
 * does -- rather than by calling app internals, so what passes here is what a person
 * pressing keys would get.
 *
 *   node .review-tmp/drive.mjs "<prompt>"
 */

const PORT = 9222;

async function target() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json`);
      const pages = (await response.json()).filter((page) => page.type === "page");
      if (pages.length > 0) return pages[0];
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("no debuggable page appeared on the port");
}

class Cdp {
  #ws;
  #id = 0;
  #pending = new Map();

  static async open(url) {
    const cdp = new Cdp();
    cdp.#ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      cdp.#ws.onopen = resolve;
      cdp.#ws.onerror = reject;
    });
    cdp.#ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const pending = cdp.#pending.get(message.id);
      if (!pending) return;
      cdp.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    };
    return cdp;
  }

  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "evaluate threw");
    }
    return result.result.value;
  }

  close() {
    this.#ws.close();
  }
}

const prompt = process.argv[2];
if (!prompt) throw new Error("give a prompt as the first argument");

const page = await target();
const cdp = await Cdp.open(page.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");

const where = await cdp.eval(`document.querySelector(".title-path")?.textContent ?? "?"`);
console.log("workspace:", where);

// Submit through the real composer: the native value setter plus a bubbled `input` is
// what React's onChange listens for, and the form's submit is what the app listens for.
const submitted = await cdp.eval(`(() => {
  const box = document.querySelector("textarea.composer-input");
  if (!box) return "no composer found";
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  setter.call(box, ${JSON.stringify(prompt)});
  box.dispatchEvent(new Event("input", { bubbles: true }));
  // The composer submits on Enter without shift; there is no form to requestSubmit.
  box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  return "submitted, composer now: " + JSON.stringify(box.value);
})()`);
console.log(submitted);

// Poll the transcript until the turn's boundary rule appears.
const started = Date.now();
let last = 0;
for (;;) {
  const state = await cdp.eval(`(() => {
    const body = document.querySelector(".transcript-body");
    const rows = body ? [...body.children] : [];
    const box = document.querySelector("textarea.composer-input");
    return {
      count: rows.length,
      running: (box?.placeholder ?? "").includes("running"),
      text: rows.slice(-45).map((row) => row.innerText.replace(/[ \\t]+/g, " ").slice(0, 400)),
    };
  })()`);
  if (state.count !== last) {
    console.log(`--- ${state.count} rows (${Math.round((Date.now() - started) / 1000)}s) ---`);
    last = state.count;
  }
  if (Date.now() - started > 240_000) {
    console.log("TIMEOUT");
    console.log(state.text.join("\n"));
    break;
  }
  if (!state.running && Date.now() - started > 12000) {
    console.log(state.text.join("\n"));
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

cdp.close();
