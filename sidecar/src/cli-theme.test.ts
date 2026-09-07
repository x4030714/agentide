/**
 * That colour is off when it should be off, and that padding counts columns not bytes.
 *
 * Both failures are invisible until someone else hits them: escape codes in a piped log
 * are only noticed by whoever greps it, and a column short by the length of its own colour
 * only looks wrong once a row is coloured differently from its neighbour.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { clip, pad, theme, width } from "./cli-theme.ts";

const TTY = { isTTY: true };

test("piped output carries no colour", () => {
  // A log full of escape codes is unreadable and ungreppable, and this is the common case:
  // `agentide ... > out.txt`.
  const plain = theme({ isTTY: false }, {});
  assert.equal(plain.accent("hi"), "hi");
  assert.ok(plain.plain);
});

test("NO_COLOR is obeyed even when set to nothing", () => {
  // The convention is that the variable being present is the signal; requiring a value
  // would ignore the most common way people set it.
  assert.ok(theme(TTY, { NO_COLOR: "" }).plain);
  assert.ok(theme(TTY, { NO_COLOR: "1" }).plain);
});

test("FORCE_COLOR wins over not being a terminal", () => {
  // How this gets driven from a harness, and from a pty that reports itself badly.
  assert.equal(theme({ isTTY: false }, { FORCE_COLOR: "1" }).plain, false);
});

test("a dumb terminal gets none", () => {
  assert.ok(theme(TTY, { TERM: "dumb" }).plain);
});

test("truecolor is used only when the terminal says it has it", () => {
  const rich = theme(TTY, { COLORTERM: "truecolor" }).accent("x");
  const basic = theme(TTY, {}).accent("x");
  assert.ok(rich.includes("38;2;"), rich);
  assert.ok(basic.includes("38;5;"), basic);
  assert.ok(!basic.includes("38;2;"), "fell back to a code the terminal cannot read");
});

test("every colour closes itself", () => {
  // An unclosed attribute leaks into everything printed after it, including the user's
  // shell prompt once the process exits.
  const paint = theme(TTY, { COLORTERM: "truecolor" });
  for (const painted of [paint.accent("x"), paint.dim("x"), paint.bold("x"), paint.danger("x")]) {
    assert.ok(painted.endsWith("[0m"), JSON.stringify(painted));
  }
});

test("width ignores the escapes, because the cursor does", () => {
  assert.equal(width(theme(TTY, {}).accent("hello")), 5);
  assert.equal(width("hello"), 5);
});

test("padding a coloured string still lines up", () => {
  // The bug this exists for: `padEnd` on a coloured string counts the escape bytes, so a
  // coloured column comes out short by exactly the length of its own colour.
  const paint = theme(TTY, { COLORTERM: "truecolor" });
  assert.equal(width(pad(paint.accent("hi"), 10)), 10);
  assert.equal(width(pad("hi", 10)), 10);
});

test("padding never shortens", () => {
  assert.equal(pad("hello", 2), "hello");
});

test("clipping cuts what is seen and closes what it cut", () => {
  const paint = theme(TTY, { COLORTERM: "truecolor" });
  const cut = clip(paint.accent("abcdefghij"), 4);
  assert.equal(width(cut), 4);
  assert.ok(cut.endsWith("[0m"), "left a colour open across the cut");
});

test("clipping leaves a string that already fits alone", () => {
  assert.equal(clip("abc", 10), "abc");
});
