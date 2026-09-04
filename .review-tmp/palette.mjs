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
const want = process.argv[2];
console.log(await ev(`(() => {
  document.documentElement.dataset.palette = ${JSON.stringify(want)};
  const s = getComputedStyle(document.documentElement);
  return JSON.stringify({
    palette: document.documentElement.dataset.palette,
    theme: document.documentElement.dataset.theme ?? "(system)",
    addr: s.getPropertyValue("--addr").trim(),
    sym: s.getPropertyValue("--sym").trim(),
    xref: s.getPropertyValue("--xref").trim(),
    imm: s.getPropertyValue("--imm").trim(),
    surface: s.getPropertyValue("--surface").trim(),
  });
})()`));
ws.close();
