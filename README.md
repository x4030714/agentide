# agentide

A desktop IDE where the coding agent works over the semantic model rather than over text.
The agent asks the language server for a symbol's callers instead of grepping for its name,
and every command it runs has a visible home in the UI.

Tauri 2 and a Rust core, React 19 and Monaco in the window, the Claude Agent SDK in a Node
sidecar. Windows x64.

## Install

Run the installer from `src-tauri/target/release/bundle/` — either the `.msi` or the NSIS
`-setup.exe`. Everything it needs ships with it: Node, the Claude Code binary, rust-analyzer
and a git. Nothing to install first.

Your own copies win when you have them. agentide only reaches for a bundled tool when the
program is not on PATH, so a newer rust-analyzer or your own git keeps being the one used.

## First run

Open agentide and it will tell you what is missing before you send anything. There are two
kinds of missing.

**Signing in blocks every turn.** In the terminal, run `agentide` and type `/login` — it
hands over to Claude Code's own sign-in, which opens a browser. Or set `ANTHROPIC_API_KEY`
in your environment. Or configure a local backend, which needs no Anthropic account at all
(see below).

Type `/doctor` in the CLI at any time to see what is missing. On a normal install that is
nothing, since git and rust-analyzer ship with it.

One thing the bundle cannot fix: rust-analyzer resolves `std` through `rust-src`, which
comes from `rustup component add rust-src`. Without it you get everything except types from
the standard library.

Then open a folder. The agent works on a workspace, and there is nothing for it to do
until there is one.

## The terminal

`agentide` on its own opens a prompt and keeps the session; `agentide "<prompt>"` runs one
turn and exits. Same agent, same conversations, same config — no window, which matters on a
machine where three processes and a webview is the difference between the agent running and
the OS killing something.

Type `/` to see every command, including the ones your Claude Code installation publishes.
The list is also a search: keep typing to narrow it, arrows to pick.

| | |
|---|---|
| `/login`, `/doctor` | sign in; see what is missing |
| `/model`, `/provider` | what the next turn runs on |
| `/resume` | continue a past conversation in this folder |
| `/cwd`, `/verbose`, `/exit` | |

## Running a local model

agentide can run Qwen, Gemma, DeepSeek and others on your own GPU. Open **Local models** in
the rail, pick one that fits your card, and press the button — it downloads llama.cpp and
the weights, writes the backend entry, and starts it in a terminal tab you can watch.

Claude Code speaks exactly one wire protocol, so llama.cpp is used for its native Anthropic
endpoint. Anything else needs LiteLLM in front, which is also the route to a hosted model.

Two things are different off Anthropic: there is no prompt caching, so the whole prompt is
recomputed every turn, and effort does nothing, so the control is not drawn.

## Building it yourself

```
npm install
npm run tauri dev       # the app
npm run tauri build     # installers
npm test                # frontend
npm --prefix sidecar test
cargo test --lib        # from src-tauri/
npm run smoke:quick     # end to end against a real rust-analyzer, free
```

`npm run smoke:quick` is the one that matters before claiming a change works. Every serious
bug in this project has lived in a seam the unit tests do not cross.

## License

MIT — see [LICENSE](LICENSE).

Fully vibecoded with Opus 5.
