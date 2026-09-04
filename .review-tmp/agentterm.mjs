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
console.log("tab:", await ev(`(() => {
  const t = [...document.querySelectorAll(".term-tab-name")].find(b => b.textContent.trim() === "Agent");
  if (!t) return "no Agent tab";
  t.click();
  return "clicked";
})()`));
await new Promise((r) => setTimeout(r, 1500));
console.log(await ev(`(() => {
  const panel = [...document.querySelectorAll(".term-panel")].find(p => !p.hidden);
  const rows = [...panel.querySelectorAll(".xterm-rows > div")].map(d => d.textContent.replace(/\u00a0+/g," ").trimEnd()).filter(Boolean);
  return JSON.stringify({ lines: rows.length, text: rows.slice(0, 14) }, null, 1);
})()`));
ws.close();
