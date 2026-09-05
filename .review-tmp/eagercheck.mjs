const pages = await (await fetch("http://127.0.0.1:9222/json")).json();
const target = pages.find((p) => p.type === "page" && p.url && p.url !== "about:blank");
const ws = new WebSocket(target.webSocketDebuggerUrl);
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

// Point it at this project, where Cargo.toml is one level down.
await ev(`localStorage.setItem("agentide.lastWorkspace", "C:/Users/tung/Desktop/agentide"), "set"`);
ws.send(JSON.stringify({ id: ++id, method: "Page.reload", params: { ignoreCache: true } }));
await new Promise((r) => setTimeout(r, 6000));

for (let i = 0; i < 30; i++) {
  const pill = await ev(`document.querySelector(".lsp-status")?.innerText?.replace(/\s+/g, " ") ?? ""`);
  if (pill) { console.log("server status pill:", pill); break; }
  if (i === 29) console.log("no server started within 60s");
  await new Promise((r) => setTimeout(r, 2000));
}
console.log("no file opened:", await ev(`!document.querySelector(".monaco-editor")`));
ws.close();
