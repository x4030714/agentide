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

const type = (text) => ev(`(() => {
  const box = document.querySelector(".quick-input");
  if (!box) return "no palette";
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(box, ${JSON.stringify("Q")}.replace("Q", ${JSON.stringify(text)}));
  box.dispatchEvent(new Event("input", { bubbles: true }));
  return "typed";
})()`);

const top = () => ev(`(() => {
  const rows = [...document.querySelectorAll(".quick-row")].slice(0, 4);
  return rows.map(r => [...r.children].map(c => c.textContent).join("")).join(" | ");
})()`);

for (const query of ["apptsx", "gitrs", "keys"]) {
  await type(query);
  await wait(400);
  console.log(query.padEnd(8), "->", await top());
}
ws.close();
