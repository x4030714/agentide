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
console.log(await ev(`(() => {
  const b = document.querySelector(".palette-picker .win-button");
  if (!b) return "no picker button";
  b.click();
  return "opened";
})()`));
await new Promise((r) => setTimeout(r, 800));
console.log(await ev(`JSON.stringify({ options: [...document.querySelectorAll(".palette-option")].map(o => o.innerText.replace(/\n/g, " | ")) }, null, 1)`));
ws.close();
