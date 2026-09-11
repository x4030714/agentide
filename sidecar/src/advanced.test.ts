/** The guard is the part worth testing: a pattern too broad blocks real work and reads as the
 * agent being broken, which costs more than the thing it prevented. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ROSTER, advancedOptions, forbidden, hooks } from "./advanced.ts";

type Event = "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop" | "SubagentStart" | "SubagentStop";

/** Run one hook of one event against an input, the way the SDK would. */
async function fire(event: Event, input: unknown) {
  const notes: string[] = [];
  const table = hooks((text) => notes.push(text));
  const hook = table[event]?.[0]?.hooks[0];
  assert.ok(hook, `no ${event} hook`);
  const output = await hook(input as never, undefined, { signal: new AbortController().signal });
  return { output: output as Record<string, unknown>, notes };
}

/**
 * One turn against a single hook table, since the record is closed over per query.
 * Each step is `[event, input]`; the last output is returned.
 */
async function turn(steps: [Event, unknown][]) {
  const table = hooks(() => {});
  const signal = new AbortController().signal;
  let output: Record<string, unknown> = {};
  for (const [event, input] of steps) {
    const hook = table[event]?.[0]?.hooks[0];
    assert.ok(hook, `no ${event} hook`);
    output = (await hook(input as never, undefined, { signal })) as Record<string, unknown>;
  }
  return output;
}

const submit: [Event, unknown] = ["UserPromptSubmit", { prompt: "fix the thing" }];
const edited: [Event, unknown] = [
  "PostToolUse",
  { tool_name: "Edit", tool_input: { file_path: "C:/w/src/main.rs" } },
];
const stop: [Event, unknown] = ["Stop", { stop_hook_active: false }];

test("a turn that changed code and checked nothing is sent back, once", async () => {
  // The failure this whole mode exists to stop: an edit reported as working because it
  // compiled in someone's head.
  const blocked = await turn([submit, edited, stop]);
  assert.equal(blocked.decision, "block");
  assert.match(String(blocked.reason), /main\.rs/);
  assert.match(String(blocked.reason), /never checked/);
});

test("it asks once and then lets the turn end", async () => {
  // A second refusal is a loop, and a model that has been told and decided otherwise has
  // given its answer.
  const table = hooks(() => {});
  const signal = new AbortController().signal;
  const run = async (event: Event, input: unknown) =>
    (await table[event]![0]!.hooks[0]!(input as never, undefined, { signal })) as Record<string, unknown>;

  await run("UserPromptSubmit", { prompt: "fix it" });
  await run("PostToolUse", { tool_name: "Write", tool_input: { file_path: "a.ts" } });
  assert.equal((await run("Stop", { stop_hook_active: false })).decision, "block");
  assert.equal((await run("Stop", { stop_hook_active: false })).decision, undefined);
});

test("a turn that ran the tests is let go", async () => {
  const ran: [Event, unknown] = [
    "PostToolUse",
    { tool_name: "mcp__agentide__ide_run", tool_input: { command: "cargo test --lib" } },
  ];
  assert.equal((await turn([submit, edited, ran, stop])).decision, undefined);
});

test("asking the language server counts as checking", async () => {
  // It is the same question a test asks, and a cheaper way to ask it.
  const asked: [Event, unknown] = ["PostToolUse", { tool_name: "mcp__agentide__ide_diagnostics", tool_input: {} }];
  assert.equal((await turn([submit, edited, asked, stop])).decision, undefined);
});

test("looking around is not checking", async () => {
  // `ls` and `git status` are how you orient, not how you find out whether it works. If
  // they counted, the rule would be a formality.
  for (const command of ["ls -la", "git status", "cat README.md"]) {
    const looked: [Event, unknown] = [
      "PostToolUse",
      { tool_name: "mcp__agentide__ide_run", tool_input: { command } },
    ];
    assert.equal((await turn([submit, edited, looked, stop])).decision, "block", command);
  }
});

test("a turn that changed nothing is never asked", async () => {
  assert.equal((await turn([submit, stop])).decision, undefined);
});

test("last turn's test run does not vouch for this turn", async () => {
  const ran: [Event, unknown] = [
    "PostToolUse",
    { tool_name: "mcp__agentide__ide_run", tool_input: { command: "npm test" } },
  ];
  // Checked, ended, then a new prompt edits again: the record resets with the prompt.
  const blocked = await turn([submit, edited, ran, stop, submit, edited, stop]);
  assert.equal(blocked.decision, "block");
});

test("the SDK's own loop guard is respected", async () => {
  // `stop_hook_active` means this stop is already the result of a block.
  const looping: [Event, unknown] = ["Stop", { stop_hook_active: true }];
  assert.equal((await turn([submit, edited, looping])).decision, undefined);
});

test("a recursive force delete is refused whatever order the flags came in", () => {
  const commands = [
    "rm -rf build",
    "rm -fr build",
    "rm -f -r build",
    "rm -Rf build",
    "rm -Recurse -Force build",
    "Remove-Item -Recurse -Force build",
  ];
  for (const command of commands) {
    assert.ok(forbidden(command), command);
  }
});

test("an ordinary delete is not refused", () => {
  const commands = [
    "rm target/debug/app.exe",
    "cargo clean",
    "git rm --cached x",
    "Remove-Item build/out.txt",
    "rm -r build",
  ];
  for (const command of commands) {
    assert.equal(forbidden(command), null, command);
  }
});

test("a force push to the trunk is refused, to a branch is not", () => {
  assert.ok(forbidden("git push --force origin main"));
  assert.ok(forbidden("git push --force-with-lease origin master"));
  assert.equal(forbidden("git push --force origin advanced-mode"), null);
});

test("resetting onto the remote is refused, resetting to a local commit is not", () => {
  assert.ok(forbidden("git reset --hard origin/main"));
  assert.equal(forbidden("git reset --hard HEAD~1"), null);
});

test("shutting the machine down is refused", () => {
  assert.ok(forbidden("shutdown /r /t 0"));
  assert.ok(forbidden("Stop-Computer -Force"));
});

test("the hook blocks before the command runs, and says why", async () => {
  const { output } = await fire("PreToolUse", {
    tool_name: "mcp__agentide__ide_run",
    tool_input: { command: "rm -rf ." },
  });
  assert.equal(output.decision, "block");
  assert.match(String(output.reason), /recursive force delete/);
});

test("a harmless command passes the hook untouched", async () => {
  const { output } = await fire("PreToolUse", {
    tool_name: "mcp__agentide__ide_run",
    tool_input: { command: "cargo test --lib" },
  });
  assert.equal(output.continue, true);
  assert.equal(output.decision, undefined);
});

test("a call with no command at all does not throw", async () => {
  const { output } = await fire("PreToolUse", { tool_name: "mcp__agentide__ide_run" });
  assert.equal(output.continue, true);
});

test("the guard only watches our shell", () => {
  const table = hooks(() => {});
  assert.equal(table.PreToolUse?.[0]?.matcher, "mcp__agentide__ide_run");
});

test("delegation is announced by roster name at both ends", async () => {
  const started = await fire("SubagentStart", { agent_type: "ide-architect" });
  assert.deepEqual(started.notes, ["ide-architect started"]);
  const stopped = await fire("SubagentStop", { agent_type: "ide-reviewer" });
  assert.deepEqual(stopped.notes, ["ide-reviewer finished"]);
});

test("an unnamed subagent is still announced", async () => {
  const { notes } = await fire("SubagentStop", {});
  assert.deepEqual(notes, ["a subagent finished"]);
});

test("the two agents that judge cannot edit", () => {
  for (const name of ["ide-architect", "ide-reviewer"]) {
    const tools = ROSTER[name]?.tools;
    assert.ok(tools, `${name} has no tool list, so it can do anything`);
    for (const tool of tools) {
      assert.ok(!/^(Edit|Write|NotebookEdit|Bash|mcp__agentide__ide_run)$/.test(tool), tool);
    }
  }
});

test("every agent describes when to use it, which is the whole of how it gets chosen", () => {
  for (const [name, agent] of Object.entries(ROSTER)) {
    assert.ok(agent.description.length > 60, name);
    assert.ok(agent.prompt.length > 60, name);
  }
});

test("the bundle carries all three levers", () => {
  const options = advancedOptions(() => {});
  assert.deepEqual(Object.keys(options.agents ?? {}).sort(), [
    "ide-architect",
    "ide-implementer",
    "ide-reviewer",
    "ide-validator",
  ]);
  assert.equal(options.thinking?.type, "enabled");
  assert.ok(options.hooks);
});

test("no roster name can collide with an agent the person keeps on disk", () => {
  // `~/.claude/agents/` is where Claude Code finds a person's own agents, and the SDK does
  // not say which definition wins when a programmatic one shares a name. The bare names
  // did collide -- the machine this was built on keeps an architect, implementer, reviewer
  // and validator there -- so a delegation could have run the wrong instructions. A prefix
  // no ordinary agent name carries takes the question away.
  for (const name of Object.keys(ROSTER)) {
    assert.match(name, /^ide-/, name);
  }
});
