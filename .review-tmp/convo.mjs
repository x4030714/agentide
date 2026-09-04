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
  ws.send(JSON.stringify({ id: mine, method: "Runtime.evaluate", params: { expression: e, returnByValue: true, awaitPromise: true } }));
});
const P = `[...document.querySelectorAll(".tab-panel")].find(p => p.querySelector(".pane.conversations"))`;
console.log(await ev(`[...document.querySelectorAll(".tab")].find(t => t.textContent.trim() === "Conversations")?.click() ?? "no tab"`));
await new Promise((r) => setTimeout(r, 3000));
console.log(await ev(`(() => {
  const p = ${P};
  if (!p) return "no pane";
  const rows = [...p.querySelectorAll(".convo-row")];
  return JSON.stringify({
    header: p.querySelector(".pane-header .legend")?.textContent,
    count: rows.length,
    first3: rows.slice(0,3).map(r => ({
      name: r.querySelector(".convo-name")?.textContent?.slice(0,60),
      meta: r.querySelector(".convo-meta")?.textContent,
    })),
    notes: [...p.querySelectorAll(".note")].map(n => n.textContent.slice(0,80)),
  }, null, 1);
})()`));
ws.close();
