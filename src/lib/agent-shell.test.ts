import { describe, expect, it } from "vitest";

import { __testing } from "./agent-shell";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/**
 * What the model reads out of a terminal.
 *
 * Terminal output is written for eyes: colour, cursor moves, progress bars that redraw
 * one line a hundred times. Handed to a model raw it is thousands of tokens describing
 * something the user already watched, and the escape bytes make the real text harder to
 * find rather than easier. These pin what survives that trip.
 */
describe("terminal output for a model", () => {
  const { stripAnsi, clamp } = __testing;

  it("keeps the text and drops the colour", () => {
    expect(stripAnsi(`${ESC}[31merror${ESC}[0m: mismatched types`)).toBe(
      "error: mismatched types",
    );
  });

  it("drops a window-title sequence, which prints nothing", () => {
    expect(stripAnsi(`${ESC}]0;cargo build${BEL}done`)).toBe("done");
  });

  it("drops a sequence cut in half by a read boundary", () => {
    // A pty read lands wherever the OS puts it, so a chunk can end mid-escape. Leaving
    // the fragment in would put `[38;5` in the middle of the model's input.
    expect(stripAnsi(`compiling${ESC}[38;5`)).toBe("compiling");
  });

  it("leaves ordinary brackets alone", () => {
    // The stripper must not eat real text that merely looks like a sequence.
    expect(stripAnsi("warning: unused variable [dead_code]")).toBe(
      "warning: unused variable [dead_code]",
    );
  });

  it("keeps both ends of something too long", () => {
    // The head says what ran; the tail carries the error. The middle of a long build is
    // the part that carries nothing, so that is the part to lose.
    const long = `START${"x".repeat(60_000)}END`;
    const kept = clamp(long);
    expect(kept.startsWith("START")).toBe(true);
    expect(kept.endsWith("END")).toBe(true);
    expect(kept).toContain("omitted");
    expect(kept.length).toBeLessThan(long.length);
  });

  it("leaves short output exactly as it is", () => {
    expect(clamp("cargo check\nFinished in 3.2s")).toBe("cargo check\nFinished in 3.2s");
  });
});
