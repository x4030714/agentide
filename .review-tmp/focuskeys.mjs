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

// Close the palette the way a person would.
await ev(`document.querySelector(".quick-input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
await wait(400);

const press = (key, code) => ev(`(() => {
  window.dispatchEvent(new KeyboardEvent("keydown", {
    key: ${JSON.stringify(key)}, code: ${JSON.stringify(code ?? "")},
    ctrlKey: true, bubbles: true, cancelable: true,
  }));
  return "ok";
})()`);

const where = () => ev(`(() => {
  const el = document.activeElement;
  if (!el) return "nothing";
  const pane = el.closest(".pane");
  const paneName = pane ? [...pane.classList].filter(c => c !== "pane").join(".") : "?";
  return paneName + " / " + el.className.split(" ")[0];
})()`);

for (const [label, key, code] of [
  ["Ctrl+1 tree", "1", "Digit1"],
  ["Ctrl+2 composer", "2", "Digit2"],
  ["Ctrl+3 editor", "3", "Digit3"],
  ["Ctrl+4 terminal", "4", "Digit4"],
]) {
  await press(key, code);
  await wait(500);
  console.log(label.padEnd(16), "->", await where());
}

const treeWidth = () => ev(`String(Math.round(document.querySelector(".pane.tree")?.getBoundingClientRect().width ?? -1))`);
console.log("tree width       ->", await treeWidth());
await press("b");
await wait(600);
console.log("after Ctrl+B     ->", await treeWidth());
await press("b");
await wait(600);
console.log("after Ctrl+B x2  ->", await treeWidth());
ws.close();
