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
// Choose it the way a person does: open the picker, click the row.
console.log(await ev(`(() => {
  document.querySelector(".palette-picker .win-button").click();
  return "opened";
})()`));
await new Promise((r) => setTimeout(r, 400));
console.log(await ev(`(() => {
  const row = [...document.querySelectorAll(".palette-option")].find(o => o.innerText.toLowerCase().includes(${JSON.stringify(want)}));
  if (!row) return "no such palette";
  row.click();
  return "picked " + row.querySelector(".palette-label").textContent;
})()`));
await new Promise((r) => setTimeout(r, 700));
console.log(await ev(`(() => {
  const s = getComputedStyle(document.documentElement);
  const bubble = document.querySelector(".t-prompt");
  const code = document.querySelector(".md-inline-code");
  return JSON.stringify({
    attr: document.documentElement.dataset.palette ?? "(default)",
    sym: s.getPropertyValue("--sym").trim(),
    bubbleBg: bubble ? getComputedStyle(bubble).backgroundColor : "no bubble",
    inlineCode: code ? getComputedStyle(code).color : "no inline code",
  }, null, 1);
})()`));
ws.close();
