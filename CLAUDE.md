# agentide

A desktop IDE where the coding agent works over the semantic model rather than over text.
Tauri 2 + Rust core, React 19 + Vite frontend, Monaco editor, and the Claude Agent SDK in
a Node sidecar. `PRODUCT.md` is the product truth; the plan lives in
`~/.claude/plans/virtual-brewing-hoare.md`, and `PRIORITY.md` is the short list of what to
build next.

## Layout

| | |
|---|---|
| `src-tauri/src/` | the Rust core: `fs`, `agent`, `checkpoints`, `git`, `conversations`, `lsp`, `pty`, `window`, and `ipc` (the wire types) |
| `src/lib/` | frontend logic — protocol mirror, bridge, LSP client and adapter, the `ide_*` host, keybindings |
| `src/panes/` | one file per pane |
| `sidecar/src/` | the agent host: session, protocol, the `agentide` MCP server |
| `scripts/` | staging the release payload, solving palettes, the smoke test |

## Commands

```
npm test                 # frontend unit tests
npm --prefix sidecar test
cargo test --lib         # from src-tauri/
npm run smoke:quick      # end to end, no agent turn, free (needs rust-analyzer)
npm run smoke            # end to end including one turn (costs money)
npm run tauri dev        # the app
npm run tauri build      # installers into src-tauri/target/release/bundle/
node scripts/solve-theme.mjs --check
```

Run `npm run smoke:quick` before claiming a change works. Every serious bug in this project
lived in a seam that unit tests do not cross. It drives the `ide_*` tools against a real
rust-analyzer through `window.__ideTool`, which is why that hook exists in `App.tsx`.

## Things that are easy to get wrong here

Each of these cost real time at least once.

**Every path goes through `WirePath`.** Windows hands you `C:\a\b`, `\\?\C:\a\b` and
`c:/a/b` for the same directory. Passing a raw `PathBuf` string across a boundary is how
the packaged app died with `EISDIR ... lstat 'C:'` — Node cannot resolve a main module
through a verbatim prefix, and the error names neither the file nor the reason.

**There is exactly one path-to-URI function**, `toFileUri`, and `uriToPath` is its inverse.
A file's identity is spelled three ways at once: ours, Monaco's normalised form, and
whatever a language server echoes back. Nothing compares URI strings — incoming URIs are
converted back to a path and paths are matched. A second encoder makes diagnostics
silently stop appearing.

**The protocol has three mirrors** — zod in `sidecar/src/protocol.ts`, Rust enums in
`src-tauri/src/ipc.rs` and `agent.rs`, TypeScript in `src/lib/protocol.ts` — kept honest by
`sidecar/protocol-fixtures.json`. Add a message to one and add a fixture; the other two
fail a test until they agree.

**The MCP server is named `agentide`, never `ide`.** Claude Code ships its own server under
that name; ours was shadowed by it for three phases — connected, zero tools exposed, no
error on either side. There is a test that fails if anyone renames it back.

**External MCP servers come from three places, and only one of them is ours.**
`sidecar/src/mcp-config.ts` reads `~/.agentide/mcp.json` and `<workspace>/.agentide/mcp.json`,
project winning on a name collision, re-read every turn so an edit lands on the next
prompt. `disabled` and `note` are agentide's own fields and are stripped before the SDK
sees an entry; a `disabled: true` entry survives the merge as a tombstone, so a workspace
can switch off a server the user turned on. `agentide` is a reserved key and an entry
using it is dropped with a warning. The third place is the SDK's: `strictMcpConfig` is
unset, so it also loads a workspace `.mcp.json`, user settings and plugins on its own — a
server can appear that neither of our files mentions.

**Memory is the SDK's, pointed at a folder we choose.** `sidecar/src/memory-config.ts`
resolves a vault -- `~/agentide-vault` by default, overridable in `~/.agentide/memory.json`
-- and `session.ts` passes it as `settings.autoMemoryDirectory` on every query. The recall
supervisor, the note format and the writer are all the SDK's; we choose the directory and
who may write to it. Do not build a memory engine beside it.

Two things make it work and are easy to undo by accident. The settings go in **inline**,
through `Options.settings`, never into the person's `~/.claude/settings.json` -- agentide's
choice of vault has no business changing how their Claude Code behaves everywhere else.
And `permissions.ask` on the vault path is the *whole* approval story: memory writes are
ordinary `Write` calls, so in Review mode (`acceptEdits`) they would otherwise land without
ever reaching `canUseTool`. Remove that rule and writes go silent rather than stopping.

The format is markdown with YAML frontmatter and `[[wikilinks]]`, which is what Obsidian
reads -- the vault is a vault because of what the SDK already writes, not because of
anything here. Obsidian does not need to be installed.

**A fix is recorded from an observed transition, never from the model saying it fixed
something.** `src/lib/lessons.ts` remembers which `ide_run` commands exited non-zero, and
when the *same* command later exits zero it appends a prompt to that tool result asking for
the symptom, the cause, the fix and the tell. Self-reported success is the failure mode
this project keeps paying for -- a change that "works" because `cargo check` passed and
`tsc` was never run -- so the trigger is a fact about the machine rather than a claim.

Three things about it are load-bearing. `recordRun` is called before `ideRun`'s non-zero
early return, or failures are never recorded and no transition can ever be seen. The
command is keyed on its exact text, whitespace aside, because pairing `cargo test --lib`
with a later `cargo test -p other` would assert a fix that was never demonstrated. And the
prompt says when *not* to write a note: most fixes are a typo, and a vault of those costs
prompt tokens on every later turn while burying the notes that matter -- which is the
"Speed and tokens" rule below, applied to memory.

**A turn can run on something other than Anthropic, and that is three env vars.**
Claude Code speaks exactly one wire protocol, so `sidecar/src/provider-config.ts` reads
`~/.agentide/providers.json` and `session.ts` turns an entry into `ANTHROPIC_BASE_URL` and
`ANTHROPIC_AUTH_TOKEN` on the CLI's environment. llama.cpp and LM Studio speak that
protocol natively; anything else needs LiteLLM in front, which is also the route to a
hosted Qwen or Nemotron. An entry is usually a `.gguf` and a port, and the `llama-server`
command is built from it.

Four things hold it together and each is a way to break it silently. `Options.env`
**replaces** the subprocess environment, so it is spread over `process.env` -- dropping
`PATH` or an existing Claude login to set two variables is not a trade worth making. The
provider is in `queryFingerprint` **by value**, because the CLI reads those variables once
at startup and there is no setter: a live query kept across a provider change would answer
from the old backend while the picker showed the new one. `port` is required, because with
`ANTHROPIC_BASE_URL` set and nothing listening Claude Code does **not** fall back to the
cloud -- it fails the turn with an error naming neither the provider nor the port. And the
base URL and token never cross into the webview: `publicProviders` names the fields that
may, so a field added later is excluded until someone decides otherwise.

Two rules elsewhere in this file stop applying off Anthropic. There is no prompt caching,
so the whole prefix is reprocessed every single turn. And effort is an Anthropic concept:
provider models declare `supportsEffort: false` and `RunControls` then draws no effort
control at all, rather than one that is quietly ignored.

**The prefix is far bigger than the ~3.1k this file used to claim, and locally that is
fatal rather than merely costly.** Measured: a turn whose entire message was "hi" sent
**41,476 tokens** — the `claude_code` preset, `system.md`, thirteen `ide_*` descriptions,
and every tool of every configured MCP server, which was 51 tools on the machine it was
measured on. Anthropic caches that and it disappears; llama.cpp refuses the request with
`exceeds the available context size` and every turn fails identically whatever you ask.

Two consequences. `contextFor` in `src/lib/local-models.ts` has a 64k floor that holds even
when the card has no room for it, because slow beats a window that refuses the request. And
the MCP servers are now the dominant term in the prompt for a local model: switching off
the ones a session does not need (`disabled: true` in `mcp.json`) is worth more locally
than any wording change, which is the opposite of the trade on Anthropic.

**Everything spawned must be adopted into the job, or it outlives a kill.**
`src-tauri/src/reaper.rs` creates a Windows job object with `KILL_ON_JOB_CLOSE` and every
long-lived child is handed to it: the agent host (`agent.rs`), each language server
(`lsp.rs`), each terminal shell (`pty.rs`). Grandchildren join through their parent, which
is what covers the Claude CLI and every MCP server it starts -- nothing here knows those
exist. Add a spawn without `reaper::adopt` and it is an orphan again.

The exit handler in `lib.rs` is not a substitute and never was: the case that matters is
taskkill, or the OS reclaiming memory, and neither runs our code. Two rules keep this
working -- the job handle must stay non-inheritable, because a copy living in a child
would keep the job alive after we died and it would then kill nothing; and the kill-on-close
limit must be set, because a job without it holds the children *and* stops them joining a
job that would. Verified by hard-killing the app with no `/T` and confirming every child
died with it; that is the only test that proves it, since an exit handler passes every
gentler one.

**A tool declared but not answered is broken forever, silently.** The sidecar declares
`ide_*` tools and the frontend answers them from `HOST_TOOL_NAMES`. `ide-tool-names.test.ts`
reads the sidecar's source and fails on drift, because nothing else would.

**Colours are solved, not chosen.** The window is translucent, so a pane's real background
depends on the user's wallpaper; contrast is verified against the worst-case composite.
`scripts/solve-theme.mjs` generates every palette value and `--check` re-verifies them. Do
not hand-edit a value in `src/styles/palettes.css`.

**The agent's shell is `ide_run`, not `Bash`.** Bash is disallowed on purpose: it runs where
the user cannot watch, and PRODUCT.md's third principle is that every command has a visible
home in the UI.

**A million-token window is a million-token bill.** Opus 5 carries 1M of context and Claude
Code compacts only near the edge of it, so a long conversation on it is never summarised --
it is re-sent whole, on every request, including the request behind every tool call. The one
that taught us this had grown to 925,000 tokens; a turn with ten tool calls was nine million
cached tokens, and two prompts spent a Pro session allowance twice in one evening, with
nothing in the window saying so. `sidecar/src/context-config.ts` sets `autoCompactWindow` to
200k by default (`~/.agentide/context.json` overrides; `null` means the whole window), the
status bar shows `% ctx` after every turn, and Advanced mode's subagents run on Sonnet rather
than inheriting Opus -- each one is a fresh context billed from cold. This is the exception to
"never summarise history": the SDK does not carry it intact either, it compacts at the edge;
the only choice is where, and a ceiling the person can afford beats one they find on a bill.

**Anything addressed by a reused id needs its calls ordered.** A pty session is named by an
id the caller picks, and `pty_spawn`/`pty_kill` are separate `invoke` calls in flight
independently. StrictMode mounts an effect, tears it down and mounts it again, so one id saw
spawn, kill, spawn with nothing sequencing them -- and the kill landed on the session the
second spawn had just registered. Windows reports that killed conpty child as exit code 1,
so every terminal in the app opened dead and it read as a broken shell. `src/lib/in-order.ts`
queues per id and both calls go through it. The same shape is waiting anywhere else a
frontend id addresses a Rust-side resource.

**`npm install` needs the override in `package.json`, and it is not optional.**
`@xterm/addon-canvas` declares a peer of `@xterm/xterm@^5` — every published version does,
including the 0.8 betas — and this project is on 6. The addon itself works fine there; it is
loaded as the fallback when WebGL loses its context, and the range is simply stale upstream.
Without the `overrides` entry pinning its peer to the root version, a plain `npm install`
fails with ERESOLVE and the only way in is `--legacy-peer-deps`, which turns peer checking
off for everything else too. Remove the override only when the addon's own range moves.

**A dev launch that fails on "Port 1420 is already in use" is a Vite the last one left
behind.** Killing `npm run tauri dev` — Ctrl-C, a stopped background task, anything that is
not a clean exit — reliably orphans its Vite child, and `strictPort` is on because Tauri's
`devUrl` names 1420 exactly, so the next launch does not move to 1421; it dies. The error
names the port and nothing else, which is why it reads as a broken build and has cost this
project hours across separate sessions, twice in one evening. `scripts/free-port.mjs` runs
as npm's `predev` and clears it first. It only ever kills a `node`; anything else on 1420
is reported and left, because taking out someone else's process to start a dev server is
not a trade a script makes on its own.

## Style

Comments explain the decision, not the mechanism — why this way, what the alternative cost,
what breaks if it changes. A comment restating the code is noise; a comment naming the bug
that shaped the code is the reason the file is maintainable. Look at any module header
before writing a new one.

Prose in comments and UI text: plain, direct, no hedging. Em dashes and semicolons are
fine. American or British spelling, consistent within a file.

Tests pin the reasoning, not the implementation. Name the case rather than the function:
`a rename that also moves a file is refused whole`, not `test_rename_2`.

Errors say what happened and what to do about it. When a language server is still indexing,
say so in the answer — a model told "no references" reads it as proof rather than as
"not yet".

## Speed and tokens, and what may not be traded for either

This is meant to be fast. Not fast for a demo -- fast on the sixth turn of a long
session on a native codebase, which is the only measurement that counts here.

The line: **latency comes out of the harness, never out of the model.** Anything that
makes the model dumber to make the app quicker is the wrong trade, and it is the
tempting one, because it always works.

Fair game -- these cost nothing the model would have used:

- Process and startup cost. Spawning, connecting, indexing, resolving a package.
- Duplicate tools. Two servers offering `click` is two ways to do one thing, and the
  model pays to read both and pays again to choose. Dropping one is free.
- Deferred tool loading. Tool search exists so a tool the turn never uses costs
  nothing; do not force tools into the prompt without measuring that they were
  missing (see the `alwaysLoad` note in `sidecar/src/mcp-config.ts`).
- Rendering, virtualisation, anything the webview does after the answer arrives.
- Answering a question from the language server instead of from a file read: fewer
  tokens *and* faster *and* more correct, which is the shape every good change here
  has.

Not fair game -- each of these buys speed by making the model worse:

- Truncating tool output, file reads or diagnostics to save tokens.
- Dropping or trimming the `claude_code` preset, or the tuned prompt.
- Defaulting to a smaller model or a lower effort than the person chose.
- Capping `maxTurns` to make a turn end sooner.
- Summarising history the SDK would otherwise carry intact. **With one exception, below.**

Tokens obey the same rule, and the same list. Spend fewer of them by asking better
questions, never by giving the model less to think with.

- **The prefix is cached; keep it identical.** Our own prose is ~3.1k tokens in every
  prompt (13 tool descriptions ~1636, the server instructions ~222, `system.md`
  ~1245), and after the first turn it costs almost nothing -- as long as it does not
  change. **On a local backend none of that holds**: there is no prompt caching, so the
  whole prefix is reprocessed every turn and it is compute rather than money. That makes
  the tool list worth *less* there, not more -- which is an argument for measuring on the
  backend you actually run, not for trimming descriptions on the one you do not. Anything that varies the tool list between turns reprices the whole prefix.
  A server that connects on one turn and misses the 5s cap on the next does exactly
  that, silently: `uvx blender-mcp` measured 4854ms. Prefer a server that is reliably
  fast or reliably off to one that flaps.
- **A server whose application is closed is not started.** An entry can carry
  `requires: { port }`, and the loader opens the server only when something is already
  listening there. The port beats asking whether the process is running, on both
  counts: it is the condition under which the tools actually work -- Blender open with
  its addon server off listens on nothing -- and a localhost connect is microseconds
  where a process list is a subprocess spawn. Two closed gates measured 15ms against
  the 5.6s of spawning they replace.

- **Deleting tool descriptions is the wrong lever.** They are cached, and they are what
  makes the model reach for the right tool instead of Grep. A shorter description that
  loses a turn to a worse choice costs far more than it saved.
- **The real savings are in what a tool returns**, which is never cached: an outline
  instead of a file, a symbol's uses instead of a text search, the server's own fix
  instead of a read-guess-verify loop. Every one of those is fewer tokens *and* a
  better answer, which is the only kind of saving this section is asking for.
- Shaping output densely is fair game; truncating it is not. Deduplicating identical
  diagnostics is shaping. Capping the list at twenty is truncation.

When a change could go either way, measure it. `npm run smoke` runs a real turn and
the MCP strip reports what the prompt was actually built with -- that is how the
`alwaysLoad` question got settled instead of argued.
## Constraints

- Windows 10, single machine. Rust from the standalone MSI: **no `rustup`**, and `rust-src`
  is not installed, so rust-analyzer cannot resolve `std`.
- Primary languages are Rust and C/C++. Native-codebase scale: long LSP warm-up is the
  normal case, not an edge case.
- Built for one person who uses it daily. Density, keyboard reach and speed outrank
  discoverability, explanation and accommodation.
