/**
 * That the menu under the prompt points at what it looks like it points at.
 *
 * All of this is arithmetic no screenshot would catch: a window that scrolls a row late,
 * a highlight left on the wrong entry after wrapping, a footer claiming eight commands
 * when there are ninety. The last one is how this feature was reported broken.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { allCommands, LOCAL_COMMANDS } from "./cli-commands.ts";
import { accept, menuFor, move, rows, selection, visible } from "./cli-menu.ts";
import { theme, width } from "./cli-theme.ts";
import type { SlashCommand } from "./protocol.ts";

/** Ninety-odd commands is what a real installation publishes; the window matters there. */
function many(count: number): SlashCommand[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `cmd${String(index).padStart(2, "0")}`,
    description: `command number ${index}`,
    argumentHint: "",
  }));
}

const HEIGHT = 8;

test("a slash on its own opens the whole list", () => {
  const menu = menuFor("/", allCommands(many(90)));
  assert.equal(menu?.matches.length, 96);
  assert.equal(menu?.selected, 0);
});

test("anything not a slash opens nothing", () => {
  // Most of what is typed here is a prompt, and a menu over it would be in the way.
  assert.equal(menuFor("write a test", allCommands(many(4))), null);
  assert.equal(menuFor("", allCommands(many(4))), null);
});

test("once there is an argument the search is over", () => {
  // `/model claude-opus-5` has stopped being a search: the name is settled and the menu
  // would be covering the thing being typed.
  assert.equal(menuFor("/model claude-opus-5", allCommands([])), null);
  assert.ok(menuFor("/model", allCommands([])));
});

test("a search that matches nothing shows no box", () => {
  // An empty bordered box under the cursor reads as a bug; showing nothing reads as no
  // results, which is what happened.
  assert.equal(menuFor("/zzzz", allCommands(many(4))), null);
});

test("down moves one and wraps at the end", () => {
  let menu = menuFor("/", allCommands([]))!;
  const count = menu.matches.length;
  menu = move(menu, 1, HEIGHT);
  assert.equal(menu.selected, 1);
  for (let step = 0; step < count; step += 1) menu = move(menu, 1, HEIGHT);
  assert.equal(menu.selected, 1, "a full lap returns to where it started");
});

test("up from the first entry lands on the last", () => {
  // The fastest way to the bottom of ninety commands, and the reason wrapping is worth
  // the modulo.
  const menu = move(menuFor("/", allCommands(many(90)))!, -1, HEIGHT);
  assert.equal(menu.selected, menu.matches.length - 1);
});

test("the window follows the selection down, one row at a time", () => {
  let menu = menuFor("/", allCommands(many(90)))!;
  for (let step = 0; step < HEIGHT - 1; step += 1) menu = move(menu, 1, HEIGHT);
  assert.equal(menu.top, 0, "still on the first page");
  menu = move(menu, 1, HEIGHT);
  assert.equal(menu.top, 1, "scrolled by exactly one, not paged");
  assert.equal(menu.selected, HEIGHT);
});

test("the selection is always inside the window", () => {
  // The bug this exists to stop: a highlight drawn on a row that is no longer shown, so
  // Enter runs something the user cannot see.
  let menu = menuFor("/", allCommands(many(90)))!;
  for (let step = 0; step < 200; step += 1) {
    menu = move(menu, step % 7 === 0 ? -3 : 1, HEIGHT);
    const shown = visible(menu, HEIGHT);
    assert.ok(
      shown.includes(selection(menu)),
      `selected ${menu.selected} is outside the window at ${menu.top}`,
    );
  }
});

test("the window never runs off the end of the list", () => {
  let menu = menuFor("/", allCommands(many(90)))!;
  menu = move(menu, -1, HEIGHT);
  assert.equal(menu.top, menu.matches.length - HEIGHT);
  assert.equal(visible(menu, HEIGHT).length, HEIGHT, "the last page is still full");
});

test("a list shorter than the window does not scroll", () => {
  const menu = move(menuFor("/", allCommands([]))!, -1, HEIGHT);
  assert.equal(menu.top, 0);
  assert.equal(visible(menu, HEIGHT).length, LOCAL_COMMANDS.length);
});

test("exactly one row is highlighted, and it is the selected one", () => {
  const painted = theme({ isTTY: true }, { COLORTERM: "truecolor" });
  const menu = move(menuFor("/", allCommands(many(90)))!, 3, HEIGHT);
  const drawn = rows(menu, { terminal: 80, height: HEIGHT, theme: painted });
  const open = painted.selected("x").split("x")[0] as string;
  const marked = drawn.filter((row) => row.includes(open));
  assert.equal(marked.length, 1);
  assert.ok(marked[0]?.includes("/provider"), `highlighted the wrong row: ${marked[0]}`);
  assert.equal(selection(menu).name, "provider", "the fourth command, counting from zero");
});

test("the footer says how many there are, not how many are shown", () => {
  // Eight rows out of ninety-six look like the whole set otherwise, which is exactly how
  // this was reported: "there is only a few commands in the cli".
  const menu = menuFor("/", allCommands(many(90)))!;
  const footer = rows(menu, { terminal: 80, height: HEIGHT }).at(-1) ?? "";
  assert.ok(footer.includes("1/96"), footer);
  assert.ok(footer.includes("↑↓"), "the keys are not written anywhere else");
});

test("no drawn row is wider than the terminal", () => {
  // Every row over the width wraps, and a wrapped row makes the count of lines below the
  // prompt wrong, which puts the next redraw on top of the input.
  const menu = move(menuFor("/", allCommands(many(90)))!, 2, HEIGHT);
  const painted = theme({ isTTY: true }, { COLORTERM: "truecolor" });
  const options = { terminal: 60, height: HEIGHT, theme: painted, gutter: painted.dim("|") };
  for (const row of rows(menu, options)) {
    assert.ok(width(row) <= 60, `${width(row)} columns: ${JSON.stringify(row)}`);
  }
});

test("the menu draws the window and the footer, nothing more", () => {
  assert.equal(rows(menuFor("/", allCommands(many(90)))!, { terminal: 80, height: HEIGHT }).length, HEIGHT + 1);
});

test("choosing a command that needs nothing runs it", () => {
  const menu = menuFor("/exit", allCommands([]))!;
  assert.deepEqual(accept(menu), { line: "/exit", submit: true });
});

test("choosing a command that takes an argument waits for one", () => {
  // Submitting `/model` alone would run a command missing the only thing it needed.
  assert.deepEqual(accept(menuFor("/model", allCommands([]))!), {
    line: "/model ",
    submit: false,
  });
});
