# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Decided by the user before init, recorded here as product truth:

- **Shell:** Tauri 2, Rust core (`src-tauri/`), system WebView2 on Windows.
- **Renderer:** React 19 + Vite 7 + TypeScript 5.8.
- **Editor:** Monaco.
- **Agent:** `@anthropic-ai/claude-agent-sdk` running in a bundled Node **sidecar** process, spoken to over newline-delimited JSON on stdio. The SDK is a Node library and cannot run inside the Rust core; the sidecar is the resolution.
- **Terminal:** `portable-pty` (ConPTY) + xterm.js.
- **Git:** the git CLI against a separate `.agentide/checkpoints.git` for agent checkpoints; `git2` for panel reads.
- **Model and effort:** selectable per turn; unset means the SDK default. The model list comes from the SDK's own `supportedModels()`.

Full architecture and phasing: `C:\Users\tung\.claude\plans\virtual-brewing-hoare.md`.

## Users

One user: the author, building it for himself. Confirmed during init.

Consequences that are product truth, not preference:

- No onboarding, no first-run wizard, no empty-state tutorials.
- No settings GUI for anything a config file can express.
- Defaults may be opinionated and sharp. There is no second user to hedge for.
- Discoverability is not a goal. Density and speed outrank explanation.

## Product Purpose

A desktop IDE where the coding agent is a first-class participant rather than a chat panel
bolted to the side. It edits the open project, runs commands in the terminal the user can see,
and — the point of the whole thing — queries the language server for semantic facts instead of
guessing from text.

Success: the user stops switching between a terminal agent and an editor, and the agent stops
making the class of mistake that comes from not knowing what the code actually means.

## Positioning

**The agent works over the semantic model, not over text.** Confirmed as the single reason the
project is worth building.

Mainstream agentic editors give their agent grep and file reads. This one gives it the language
server: `ide_diagnostics` returns live errors with no build step, `ide_references` returns actual
typed callers rather than string matches, `ide_rename_symbol` performs a correct project-wide
rename. The language server is already running to serve the human; exposing it to the agent is
the mechanism a text-first competitor cannot casually copy.

Two supporting positions, subordinate to the above:

- Nothing the agent does is irreversible (per-turn checkpoints in a shadow git repo, which is
  also the pre-image store — a separate one was specified in the plan and dropped as redundant).
- Nothing the agent does is hidden (its terminal is the user's terminal, its edits are visible diffs).

## Operating Context

- Windows 10 (build 19045), single machine, local projects. Not a cloud or team tool.
- **Appearance follows the OS, with a manual override.** Superseded the earlier "dark-first"
  record: the 2am low-light scene is still the primary one and still drives the dark palette,
  but it is no longer the only target, so both themes are real and both are held to the
  contrast floor. Recorded because a stale "dark only" would mislead the next design decision.
- The window is translucent over the desktop, which makes the *effective* background of every
  surface depend on the user's wallpaper. Contrast is therefore verified against the worst-case
  composite rather than the nominal colour — this is a durable constraint, not a one-off check.
- **Primary languages: Rust and C/C++.** Confirmed. This sets the LSP priority:
  - `rust-analyzer` — slow initial index, rich semantic data, heavy diagnostics. The best case
    for agent-facing LSP tools and the primary target.
  - `clangd` — requires `compile_commands.json`; the project must handle its absence gracefully
    rather than appearing broken.
  - TypeScript/Python/Lua/Java are not current targets. tsserver may still be wired first purely
    because it is the easiest to prove the transport against — that is a build-order convenience,
    not a user need.
- Real projects are large native codebases where indexing takes real time. Long LSP warm-up and
  partial-index states are the normal case, not an edge case.
- The user runs a coding agent constantly today and knows exactly what it gets wrong.

## Capabilities and Constraints

Confirmed functionality (see plan for phasing):

- File tree, Monaco editor, filesystem watcher.
- Streaming agent chat with visible tool calls and interrupt.
- Three edit modes over one mechanism — Strict (blocks, nothing unseen on disk), Review
  (default; non-blocking queue, per-hunk accept/reject), Auto (collapsed queue, rewind per turn).
- Integrated PTY terminal shared with the agent's `Bash` tool.
- LSP for the human (completion, hover, diagnostics, definition) and for the agent (tools above).
- Git panel plus a checkpoint timeline.

Constraints:

- Rust installed via standalone MSI — **no `rustup`**, host target `x86_64-pc-windows-msvc` only.
- Translucency uses `apply_blur`, not acrylic: `window-vibrancy` documents acrylic as having
  poor drag/resize performance on Windows 10 v1903+, and this machine is well past that. Mica
  is Windows 11 only. The OS blur radius is not adjustable — only how much shows through.
- `bun` not installed; sidecar bundling uses Node SEA unless that changes.
- Bundling a Node runtime puts the app at roughly 70–120 MB. Accepted.
- `monaco-languageclient` requires `@codingame/monaco-vscode-api` shims and is version-sensitive;
  a hand-rolled Monaco↔LSP adapter is the recorded fallback.
- Agent authentication is the user's own `ANTHROPIC_API_KEY` or an existing Claude Code login.

## Brand Commitments

None. No existing name lock, logo, palette, or voice. `agentide` is a working directory name,
not a decided product name.

## Evidence on Hand

Nothing to fabricate around — this is a greenfield tool with no users, no testimonials, no
benchmarks, no pricing, and no public presence.

The repo now carries a real, deliberate visual system ("Quiet Instrument", recorded in the
direction contract at the top of `index.html`'s body) built on a token set in
`src/styles/world.css`. That system **is** design authority and should be extended rather than
replaced. It succeeded "The Disassembly Listing" (seed f56d4c96) at the user's request; the
`create-tauri-app` boilerplate it started from is long gone.

## Product Principles

1. **The semantic layer is the product.** Any feature that makes the language server more useful
   to the agent outranks a feature that makes the chat nicer.
2. **Reversible beats permissioned.** Prefer making an action undoable over interrupting to ask.
   The confirmation dialog is the last resort, not the first.
3. **No hidden work.** Every command the agent runs and every byte it writes has a visible home
   in the UI. Nothing happens in a place the user cannot look.
4. **Built for one.** Density, keyboard reach, and speed over discoverability, explanation, and
   accommodation.
5. **Long waits are normal; treat them honestly.** Native-codebase indexing takes real time.
   Show true progress and degraded-but-usable states rather than pretending to be instant.

## Accessibility & Inclusion

No product-specific requirement established — single known user, no stated needs. General craft
floor still applies: real focus states, keyboard operability of every control, and contrast that
holds up during long sessions (which is a comfort requirement here, not only a compliance one).
