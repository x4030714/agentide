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
const state = () => ev(`(() => {
  const body = document.querySelector(".transcript-body");
  const btn = [...document.querySelectorAll(".pane.transcript .ghost-button")].find(b => b.textContent.trim() === "New");
  return JSON.stringify({
    rows: body ? body.children.length : -1,
    newButton: btn ? (btn.disabled ? "disabled" : "enabled") : "missing",
  });
})()`);

// Clear the draft first, so the command menu is not covering anything.
await ev(`(() => {
  const box = document.querySelector("textarea.composer-input");
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  setter.call(box, "");
  box.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
console.log("before:", await state());
console.log("click:", await ev(`(() => {
  const btn = [...document.querySelectorAll(".pane.transcript .ghost-button")].find(b => b.textContent.trim() === "New");
  if (!btn) return "no button";
  if (btn.disabled) return "disabled";
  btn.click();
  return "clicked";
})()`));
await new Promise((r) => setTimeout(r, 700));
console.log("after:", await state());
ws.close();
