/**
 * That `/` is a menu and a search at once, and that a name typed in full runs.
 *
 * The ambiguity is deliberate — one key opens the list and the same keystrokes narrow it —
 * so the rules that keep it unambiguous are the ones worth pinning: an exact name wins
 * outright, an alias finds its command, and a prefix beats a substring. Get any of them
 * wrong and `/exit` opens a menu instead of leaving.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { allCommands, complete, format, lookup, LOCAL_COMMANDS } from "./cli-commands.ts";
import type { SlashCommand } from "./protocol.ts";

/** What the installation publishes, once a turn has asked it. */
const AGENT: SlashCommand[] = [
  { name: "commit", description: "commit the changes", argumentHint: "" },
  { name: "precommit", description: "run the checks", argumentHint: "" },
  { name: "model", description: "the installation's own", argumentHint: "" },
  { name: "review", description: "review the diff", argumentHint: "" },
];

test("a bare slash lists everything, not nothing", () => {
  // The whole request: every command visible from one keystroke. An empty search term is
  // the menu, not a search that matched nothing.
  const { exact, matches } = lookup("/", allCommands(AGENT));
  assert.equal(exact, null);
  assert.equal(matches.length, LOCAL_COMMANDS.length + AGENT.length - 1);
});

test("typing more of the name searches the same list", () => {
  const { exact, matches } = lookup("/com", allCommands(AGENT));
  assert.equal(exact, null);
  assert.deepEqual(
    matches.map((command) => command.name),
    ["commit", "precommit"],
  );
});

test("a prefix comes before a substring", () => {
  // `/co` wants `/commit`, not `/precommit` — a search that buries the obvious answer is
  // worse than no search.
  const { matches } = lookup("/co", allCommands(AGENT));
  assert.equal(matches[0]?.name, "commit");
});

test("a complete name runs rather than opening a menu", () => {
  // Without this `/exit` would list `/exit` and wait, and there would be no way to leave
  // by typing a command.
  const { exact, matches } = lookup("/exit", allCommands(AGENT));
  assert.equal(exact?.name, "exit");
  assert.deepEqual(matches, [exact]);
});

test("an alias finds its command", () => {
  assert.equal(lookup("/quit", allCommands(AGENT)).exact?.name, "exit");
});

test("arguments do not stop the name matching", () => {
  // `/model claude-opus-5` is `/model`; matching the whole line would find nothing and the
  // command would be sent to the agent as a prompt.
  const { exact } = lookup("/model claude-opus-5", allCommands(AGENT));
  assert.equal(exact?.name, "model");
  assert.ok(exact && "local" in exact, "the CLI's own `/model` must win the collision");
});

test("case does not matter", () => {
  assert.equal(lookup("/EXIT", allCommands(AGENT)).exact?.name, "exit");
});

test("the CLI's commands come first and its names win a collision", () => {
  const all = allCommands(AGENT);
  assert.deepEqual(all.slice(0, LOCAL_COMMANDS.length), LOCAL_COMMANDS);
  assert.equal(all.filter((command) => command.name === "model").length, 1);
});

test("a search with no result is empty rather than everything", () => {
  // Falling back to the full list would look like the search silently failed, and the
  // agent may well know a command this list has not been told about yet.
  assert.deepEqual(lookup("/zzz", allCommands(AGENT)).matches, []);
});

test("before the first turn there is still a list", () => {
  // `supportedCommands()` needs a live query, so the agent's half arrives late. A `/` that
  // showed nothing until then would read as broken.
  assert.equal(lookup("/", allCommands([])).matches.length, LOCAL_COMMANDS.length);
});

test("the listing puts every description in the same column", () => {
  const lines = format(allCommands(AGENT));
  const columns = new Set(lines.map((line) => line.indexOf(line.trim().split(/ {2,}/)[1] ?? "")));
  assert.equal(columns.size, 1, `descriptions are ragged:\n${lines.join("\n")}`);
  assert.ok(lines[0]?.includes("/help"));
});

test("the listing shows what a command takes", () => {
  // Read off the command rather than written down again: pinning the literal hint makes
  // this fail whenever the wording changes, which says nothing about the listing.
  for (const command of LOCAL_COMMANDS.filter((entry) => entry.argumentHint)) {
    const line = format(LOCAL_COMMANDS).find((entry) => entry.includes(`/${command.name} `));
    assert.ok(
      line?.includes(command.argumentHint),
      `no "${command.argumentHint}" in: ${line}`,
    );
  }
});

test("no line runs off the terminal", () => {
  // A skill description is written for a model: hundreds of words, and this one carries a
  // newline. Printed whole it wraps over several rows and the list stops being a list.
  const wordy: SlashCommand[] = [
    {
      name: "impeccable",
      description: `Use when the user wants to design, redesign, shape, critique or audit
        a frontend interface. ${"Covers a great many things. ".repeat(20)}`,
      argumentHint: "[shape · audit|critique · animate|bolder|colorize|delight|layout] [target]",
    },
  ];
  for (const line of format([...LOCAL_COMMANDS, ...wordy], 90)) {
    assert.ok(line.length <= 90, `${line.length} columns: ${line}`);
    assert.ok(!line.includes("\n"), `a newline survived into the listing: ${line}`);
  }
});

test("one wordy command does not indent every other description off the screen", () => {
  // Letting the widest entry set the column is the obvious implementation and the reason
  // the real listing was unreadable: an eighty-character argument hint pushed ninety other
  // descriptions past the right edge.
  const wide: SlashCommand = {
    name: "impeccable",
    description: "shape a frontend",
    argumentHint: "[shape · audit|critique · animate|bolder|colorize|delight|layout] [target]",
  };
  const lines = format([...LOCAL_COMMANDS, wide], 100);
  assert.ok(
    (lines[0]?.indexOf("show these commands") ?? 0) <= 30,
    `/help's description starts at column ${lines[0]?.indexOf("show these commands")}`,
  );
});

test("a truncated description says so", () => {
  const [line] = format(
    [{ name: "x", description: "a ".repeat(200), argumentHint: "" }],
    60,
  );
  assert.ok(line?.endsWith("…"), `no ellipsis: ${line}`);
});

test("Tab completes a command but never a prompt", () => {
  // Completing English into command names would fire on ordinary typing, which is what
  // most input here is.
  const [hits] = complete("/mo", allCommands(AGENT));
  assert.deepEqual(hits, ["/model"]);
  assert.deepEqual(complete("write a test for", allCommands(AGENT))[0], []);
});

test("Tab on a bare slash offers all of them", () => {
  const [hits, word] = complete("/", allCommands(AGENT));
  assert.equal(hits.length, LOCAL_COMMANDS.length + AGENT.length - 1);
  assert.equal(word, "/", "readline replaces the word it was given");
});
