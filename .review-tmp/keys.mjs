const pages = await (await fetch("http://127.0.0.1:9222/json")).json();
const ws = new WebSocket(pages.find((p) => p.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const ev = (e) => new Promise((res) => {
  const mine = ++id;
  ws.addEventListener("message", function on(m) {
    const d = JSON.parse(m.data);
    if (d.id === mine) { ws.removeEventListener("message", on); res(d.result?.result?.value); }
  });
  ws.send(JSON.stringify({ id: mine, method: "Runtime.evaluate", params: { expression: e, returnByValue: true } }));
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Real keyboard events on the window, exactly as the browser would deliver them.
const press = (key, code) => ev(`(() => {
  window.dispatchEvent(new KeyboardEvent("keydown", {
    key: ${JSON.stringify(key)}, code: ${JSON.stringify(code ?? "")},
    ctrlKey: true, bubbles: true, cancelable: true,
  }));
  return "pressed";
})()`);

console.log("Ctrl+P:", await press("p"));
await wait(1500);
console.log(await ev(`(() => {
  const open = document.querySelector(".quick-open");
  if (!open) return "palette did not open";
  const note = open.querySelector(".note")?.textContent ?? "";
  return JSON.stringify({ open: true, note, focused: document.activeElement?.className });
})()`));

// Type a query and read the ranking.
await ev(`(() => {
  const box = document.querySelector(".quick-input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(box, "apptsx");
  box.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
await wait(500);
console.log("results:", await ev(`JSON.stringify([...document.querySelectorAll(".quick-row")].slice(0,4).map(r => r.innerText.replace(/\n/g, " ")))`));
ws.close();
