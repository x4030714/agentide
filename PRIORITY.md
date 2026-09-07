# What to build next

Agreed 2026-09-07. Ordered by how often the problem is actually hit, not by size.
`PRODUCT.md` is what this is for; `~/.claude/plans/virtual-brewing-hoare.md` is the long
plan. This file is only the short list, and an item leaves it when it ships.

**Shipped:** editor tabs, 2026-09-07 — several files open at once, the agent opening its
edits behind you rather than over you, and where you were in each file kept across a
switch. Reaping the orphans, 2026-09-07 — a job object with kill-on-close, so nothing
agentide starts can outlive it. The startup sweep that was going to be the cheap half was
dropped: the job covers the hard-kill case it was meant to paper over, and a heuristic that
guesses which stray process was ours can only be wrong in the expensive direction. See the
reaper note in `CLAUDE.md`.

---

## 1. A model list that is true before the first turn

**Now:** `supportedModels()` lives on a running `Query`, so the catalogue cannot be read
without a live turn. Until then the picker shows pinned ids; after it, the installation's
own list merges in. Better than it was — the two no longer replace each other — but the
menu still changes shape once per session, which is what made it confusing in the first
place.

**Wanted:** the picker shows the real list from the moment the app opens.

**How:** cache the catalogue to `~/.agentide/` when it arrives and show the cached copy at
startup, refreshing it on the next turn. It describes the installation, not the turn, so it
is stale only across a CLI upgrade — and a stale list that is right 99 times out of 100
beats a provisional one that is right none of the time. Pinned versions stay either way;
see `src/lib/model-menu.ts` for why an alias is not enough on its own.

---

## 2. A lightweight CLI

**Now:** using the agent means running the whole desktop app: Vite, a cargo build and a
webview. On this machine that is the difference between fitting in memory and not.

**Wanted:** the same agent, the same tools, no window. `agentide run "..."` in a terminal.

**Why it is not just "run the sidecar":** the sidecar declares the `ide_*` tools but does
not answer them — the frontend does, out of `src/lib/ide-host.ts`, because the answers need
the editor, the file tree and the language servers. A CLI has to supply headless versions
of the ones that make sense there (`ide_run`, the LSP tools, the file tools) and honestly
drop the ones that do not (`ide_open` has no editor to open into). `HOST_TOOL_NAMES` and
the drift test in `ide-tool-names.test.ts` are what keep that honest.

**The prize:** it would also make the agent scriptable and testable without a webview,
which is the thing that has made every end-to-end check in this project awkward.

---

## Not on this list, deliberately

Windows-only assumptions, the weight of dev mode, the rough edges, manual installers and
the absent CI are all known and accepted. One person, one machine — that is the design, not
a gap in it.
