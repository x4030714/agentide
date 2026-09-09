/** The tools declared to the model are the tools something will answer. Desktop answers all
 * fifteen; the CLI has no editor and no language server, so it must be shown three. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { HostLink } from "./host.ts";
import { createIdeServer, IDE_SERVER_NAME, IDE_TOOL_NAMES, ideToolNames } from "./ide-tools.ts";

/** A link that goes nowhere: these tests never let a tool be called. */
function silentLink(): HostLink {
  return new HostLink(() => {});
}

/** Read off the server's own registry, not the array we handed it -- that array is the thing
 * under test. `_registeredTools` is private, but no public API answers this. */
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
  // Measured: loaded is 4,199 cached tokens and 6.5s; deferred is 492 tokens and 8-9s for
  // the ToolSearch. Cached tokens are nearly free, so two seconds a turn is a bad trade.
  assert.equal(loaded(createIdeServer(silentLink(), "s-1")), true);
});

test("a local backend defers them instead", () => {
  // No prompt cache off Anthropic, so those 4,199 tokens are prefill on every turn and 5%
  // of the 64k window `contextFor` floors at. The round trip is the cheaper half.
  assert.equal(loaded(createIdeServer(silentLink(), "s-1", undefined, false)), false);
});

test("deferring changes what is loaded, never what is declared", () => {
  // The saving comes out of the prompt, not the model's reach. Verified live: a turn that
  // needed `ide_run` issued a ToolSearch, found it, and called it.
  const loadedNames = declared(createIdeServer(silentLink(), "s-1", undefined, true));
  const deferredNames = declared(createIdeServer(silentLink(), "s-1", undefined, false));
  assert.deepEqual(deferredNames.sort(), loadedNames.sort());
});
