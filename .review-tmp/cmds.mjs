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
const setDraft = (text) => ev(`(() => {
  const box = document.querySelector("textarea.composer-input");
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  setter.call(box, ${JSON.stringify("PLACEHOLDER")}.replace("PLACEHOLDER", ${JSON.stringify(text)}));
  box.dispatchEvent(new Event("input", { bubbles: true }));
  return box.value;
})()`);

console.log("typed:", await setDraft("/"));
await new Promise((r) => setTimeout(r, 600));
console.log(await ev(`(() => {
  const rows = [...document.querySelectorAll(".command-row")];
  return JSON.stringify({
    shown: rows.length,
    rows: rows.map(r => r.innerText.replace(/\n/g, "  ")),
  }, null, 1);
})()`));

console.log("typed /re:", await setDraft("/re"));
await new Promise((r) => setTimeout(r, 600));
console.log(await ev(`JSON.stringify([...document.querySelectorAll(".command-row .command-name")].map(n => n.textContent))`));
ws.close();
