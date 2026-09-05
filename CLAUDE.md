# agentide

A desktop IDE where the coding agent works over the semantic model rather than over text.
Tauri 2 + Rust core, React 19 + Vite frontend, Monaco editor, and the Claude Agent SDK in
a Node sidecar. `PRODUCT.md` is the product truth; the plan lives in
`~/.claude/plans/virtual-brewing-hoare.md`.

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
npm run smoke:quick      # end to end, no agent turn, free
npm run smoke            # end to end including one turn (costs money)
npm run tauri dev        # the app
npm run tauri build      # installers into src-tauri/target/release/bundle/
node scripts/solve-theme.mjs --check
```

Run `npm run smoke:quick` before claiming a change works. Every serious bug in this project
lived in a seam that unit tests do not cross.

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

## Constraints

- Windows 10, single machine. Rust from the standalone MSI: **no `rustup`**, and `rust-src`
  is not installed, so rust-analyzer cannot resolve `std`.
- Primary languages are Rust and C/C++. Native-codebase scale: long LSP warm-up is the
  normal case, not an edge case.
- Built for one person who uses it daily. Density, keyboard reach and speed outrank
  discoverability, explanation and accommodation.
