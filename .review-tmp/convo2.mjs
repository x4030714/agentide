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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Read the second one (a short conversation).
await ev(`${P}.querySelectorAll(".convo-open")[1].click()`);
await wait(2500);
console.log("read:", await ev(`(() => {
  const msgs = [...${P}.querySelectorAll(".convo-message")];
  return JSON.stringify({
    count: msgs.length,
    roles: msgs.map(m => m.className.replace("convo-message is-","")),
    first: msgs[0]?.innerText?.slice(0,90),
    last: msgs.at(-1)?.innerText?.slice(0,90),
  }, null, 1);
})()`));

// Continue it, and check the marker moves and the transcript is told.
await ev(`[...${P}.querySelectorAll(".convo-row")][1].querySelector("button.ghost-button")?.click()`);
await wait(1200);
console.log("after continue:", await ev(`(() => {
  const live = ${P}.querySelector(".convo-row.is-live");
  return JSON.stringify({
    liveName: live?.querySelector(".convo-name")?.textContent?.slice(0,50),
    liveLabel: live?.querySelector(".convo-live")?.textContent,
  });
})()`));
ws.close();
