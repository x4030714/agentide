/**
 * That the tools declared to the model are the tools something will answer.
 *
 * This is the failure `CLAUDE.md` names as the worst kind in this project: a tool declared
 * and not answered is broken forever and silently -- the model can see it, call it, and get
 * a refusal every time, while its description costs tokens in every prompt. The desktop app
 * answers all fifteen. The CLI has no editor and no language server and answers three, so
 * it must be shown three.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { HostLink } from "./host.ts";
import { createIdeServer, IDE_SERVER_NAME, IDE_TOOL_NAMES, ideToolNames } from "./ide-tools.ts";

/** A link that goes nowhere: these tests never let a tool be called. */
function silentLink(): HostLink {
  return new HostLink(() => {});
}

/**
 * The tool names a built server actually exposes.
 *
 * Read from the MCP server's own registry rather than from the array handed to
 * `createSdkMcpServer`, because that array is what the test would be asserting about
 * itself. `_registeredTools` is the thing the model is eventually shown, and reaching for
 * it is deliberate: an underscore says it is not a public API, and there is no public one
 * that answers "what did you actually register".
 */
function declared(server: unknown): string[] {
  const registered = (server as { instance?: { _registeredTools?: Record<string, unknown> } })
    .instance?._registeredTools;
  return Object.keys(registered ?? {});
}

test("with no allowlist the server offers everything, which is the desktop app", () => {
  const names = declared(createIdeServer(silentLink(), "s-1"));
  assert.deepEqual(names.sort(), [...IDE_TOOL_NAMES].sort());
});

test("an allowlist narrows what the model is shown", () => {
  // What the CLI passes. Nine of these tools are questions for a language server and three
  // are instructions to an editor; a terminal has neither.
  const cli = ["ide_run", "ide_terminal_read", "ide_terminal_stop"];
  const names = declared(createIdeServer(silentLink(), "s-1", cli));
  assert.deepEqual(names.sort(), [...cli].sort());
});

test("a name that is not a tool narrows to nothing rather than being ignored", () => {
  // Silently keeping everything on a typo would put the editor tools back in a headless
  // prompt, which is the exact failure this allowlist exists to prevent.
  assert.deepEqual(declared(createIdeServer(silentLink(), "s-1", ["ide_nonsense"])), []);
});

test("the auto-approve list narrows with it", () => {
  // `ideToolNames` feeds `allowedTools`. Left wide it would name tools that are not
  // declared -- harmless today, and exactly the kind of drift that outlives the reason.
  const cli = ["ide_run", "ide_terminal_read", "ide_terminal_stop"];
  assert.deepEqual(ideToolNames(cli), cli.map((name) => `mcp__${IDE_SERVER_NAME}__${name}`));
  assert.equal(ideToolNames().length, IDE_TOOL_NAMES.length);
});

test("every name the CLI answers is a real tool", () => {
  // The CLI's list is written by hand in `cli.ts`. A name that drifts from `IDE_TOOL_NAMES`
  // would declare nothing and remove the terminal from a terminal-only agent.
  for (const name of ["ide_run", "ide_terminal_read", "ide_terminal_stop"]) {
    assert.ok(
      (IDE_TOOL_NAMES as readonly string[]).includes(name),
      `${name} is not a tool this server has`,
    );
  }
});

/** Whether the built server asks for its tools to sit in the prompt. */
function loaded(server: unknown): boolean {
  const registered = (server as { instance?: { _registeredTools?: Record<string, { _meta?: Record<string, unknown> }> } })
    .instance?._registeredTools;
  const first = Object.values(registered ?? {})[0];
  return first?._meta?.["anthropic/alwaysLoad"] === true;
}

test("the tools sit in the prompt by default, which is Anthropic", () => {
  // Measured: loaded costs 4,199 cached tokens and a 6.5s turn; deferred costs 492 tokens
  // and 8-9s, because the model spends a ToolSearch finding them. Cached tokens are nearly
  // free after the first turn, so paying two seconds a turn to save them is backwards.
  assert.equal(loaded(createIdeServer(silentLink(), "s-1")), true);
});

test("a local backend defers them instead", () => {
  // There is no prompt cache off Anthropic, so those 4,199 tokens are prefill compute on
  // every turn -- including the ones that touch no tool -- and 5% of the 64k window
  // `contextFor` floors at. There the round trip is the cheaper half.
  assert.equal(loaded(createIdeServer(silentLink(), "s-1", undefined, false)), false);
});

test("deferring changes what is loaded, never what is declared", () => {
  // The saving must come out of the prompt, not out of the model's reach: a tool that is
  // deferred is still findable and callable, and one that is missing is gone. Verified
  // live -- two runs on a turn that could only be answered by calling `ide_run` issued a
  // ToolSearch, found it, and called it.
  const loadedNames = declared(createIdeServer(silentLink(), "s-1", undefined, true));
  const deferredNames = declared(createIdeServer(silentLink(), "s-1", undefined, false));
  assert.deepEqual(deferredNames.sort(), loadedNames.sort());
});
