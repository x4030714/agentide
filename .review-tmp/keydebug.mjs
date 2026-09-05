const pages = await (await fetch("http://127.0.0.1:9222/json")).json();
const ws = new WebSocket(pages.find((p) => p.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const ev = (e) => new Promise((res) => {
  const mine = ++id;
  ws.addEventListener("message", function on(m) {
    const d = JSON.parse(m.data);
    if (d.id === mine) { ws.removeEventListener("message", on); res(d.result); }
  });
  ws.send(JSON.stringify({ id: mine, method: "Runtime.evaluate", params: { expression: e, returnByValue: true } }));
});

// Does anything at all receive a keydown on window?
console.log(await ev(`(() => {
  let seen = 0;
  const probe = () => { seen += 1; };
  window.addEventListener("keydown", probe);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", ctrlKey: true, bubbles: true, cancelable: true }));
  window.removeEventListener("keydown", probe);
  return "probe saw " + seen;
})()`).then(r => r?.result?.value ?? JSON.stringify(r)));

// Was the event's default prevented? If the app's handler ran, it calls preventDefault.
console.log(await ev(`(() => {
  const e = new KeyboardEvent("keydown", { key: "p", ctrlKey: true, bubbles: true, cancelable: true });
  window.dispatchEvent(e);
  return JSON.stringify({ defaultPrevented: e.defaultPrevented, target: String(e.target) });
})()`).then(r => r?.result?.value ?? JSON.stringify(r)));

console.log("palette:", await ev(`String(!!document.querySelector(".quick-open"))`).then(r => r?.result?.value));
ws.close();
