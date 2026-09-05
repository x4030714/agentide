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
const r = await ev(`JSON.stringify({
  panes: document.querySelectorAll(".pane").length,
  title: document.querySelector(".titlebar-mark")?.textContent,
  bodyLen: document.body.innerHTML.length,
})`);
console.log("dom:", r?.result?.value ?? JSON.stringify(r));
ws.close();
