/**
 * Drives the Repository panel through a real stage-and-commit, the way a person would:
 * clicking its buttons and typing in its textarea, never calling app internals.
 * Phase 5's verification step, run against this repository's own working tree.
 */
const message = process.argv[2];
if (!message) throw new Error("give a commit message");

const pages = await (await fetch("http://127.0.0.1:9222/json")).json();
const ws = new WebSocket(pages.find((p) => p.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const ev = (expression) =>
  new Promise((res) => {
    const mine = ++id;
    ws.addEventListener("message", function on(e) {
      const m = JSON.parse(e.data);
      if (m.id === mine) { ws.removeEventListener("message", on); res(m.result?.result?.value); }
    });
    ws.send(JSON.stringify({ id: mine, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const P = `[...document.querySelectorAll(".tab-panel")].find(p => p.querySelector(".pane.git"))`;

await ev(`[...document.querySelectorAll(".tab")].find(t => t.textContent.trim() === "Repository")?.click()`);
await wait(1200);
await ev(`${P}.querySelector(".pane-header ~ * .change-group .ghost-button, .change-group .ghost-button")?.click()`);
await wait(3000);
console.log("staged:", await ev(`${P}.querySelectorAll(".git-row").length + " rows, groups: " + [...${P}.querySelectorAll(".change-group .legend")].map(g=>g.textContent).join(" | ")`));

// Type into the real textarea the way a keystroke does, so React sees it.
await ev(`(() => {
  const box = ${P}.querySelector("textarea.commit-input");
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  setter.call(box, ${JSON.stringify(message)});
  box.dispatchEvent(new Event("input", { bubbles: true }));
  return box.value.length;
})()`);
await wait(400);
console.log("commit button enabled:", await ev(`!${P}.querySelector(".commit-box button").disabled`));
await ev(`${P}.querySelector(".commit-box button").click()`);
await wait(5000);
console.log("after:", await ev(`JSON.stringify({
  notes: [...${P}.querySelectorAll(".note")].map(n => n.textContent.slice(0,120)),
  groups: [...${P}.querySelectorAll(".change-group .legend")].map(g => g.textContent),
})`));
ws.close();
