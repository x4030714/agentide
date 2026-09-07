/**
 * When a fix counts as a lesson, and when it does not.
 *
 * Both halves matter equally. A missed transition is a lesson lost, and a false one is a
 * note in the vault forever, costing prompt tokens on every later turn to say something
 * that was never true. The retry case below is the one that would produce those.
 */

import { beforeEach, describe, expect, test } from "vitest";

import { __testing, lessonPrompt, recordRun } from "./lessons";

beforeEach(() => {
  __testing.reset();
});

const CHECK = "cargo check --lib";
const ERROR = [
  "   Compiling agentide v0.1.0",
  "error[E0432]: unresolved import `windows_sys::Win32::UI::WindowsAndMessaging::SetWindowRgn`",
  "  --> src\\window.rs:108:9",
  "error: could not compile `agentide` (lib) due to 1 previous error",
].join("\n");

describe("the transition", () => {
  test("a command that fails and later passes is a lesson", () => {
    const now = Date.now();
    expect(recordRun(CHECK, 1, ERROR, now)).toBeNull();
    const lesson = recordRun(CHECK, 0, "Finished in 10.25s", now + 200_000);
    expect(lesson).not.toBeNull();
    expect(lesson?.command).toBe(CHECK);
    expect(lesson?.exitCode).toBe(1);
    expect(lesson?.symptom).toContain("E0432");
  });

  test("a command that passes first time is not a lesson", () => {
    expect(recordRun(CHECK, 0, "Finished")).toBeNull();
  });

  test("a failure on its own is not a lesson; there is nothing to record yet", () => {
    expect(recordRun(CHECK, 1, ERROR)).toBeNull();
  });

  test("one fix is asked about once", () => {
    const now = Date.now();
    recordRun(CHECK, 1, ERROR, now);
    expect(recordRun(CHECK, 0, "ok", now + 200_000)).not.toBeNull();
    // The second pass has no failure behind it -- asking again would produce a duplicate
    // note for work that was already written down.
    expect(recordRun(CHECK, 0, "ok", now + 300_000)).toBeNull();
  });

  test("a timeout is a failure, so finishing later still teaches something", () => {
    const now = Date.now();
    // How `ideRun` reports a killed command: no exit code at all.
    expect(recordRun("npm run build", null, "webpack 5.x", now)).toBeNull();
    const lesson = recordRun("npm run build", 0, "built", now + 400_000);
    expect(lesson?.exitCode).toBeNull();
  });
});

describe("what is deliberately not a lesson", () => {
  test("an immediate retry with nothing in between is a flake, not a fix", () => {
    const now = Date.now();
    recordRun("npm test", 1, "1 failing", now);
    // Same command, straight away, nothing ran in between: a file lock, a port still
    // closing, a flaky test. Nothing was learned.
    expect(recordRun("npm test", 0, "passing", now + 900)).toBeNull();
  });

  test("but a quick pass with another command in between is a fix", () => {
    const now = Date.now();
    recordRun("npm test", 1, "1 failing", now);
    recordRun("npx tsc --noEmit", 0, "", now + 300);
    // Something happened in those two seconds, which is the difference from the case above.
    expect(recordRun("npm test", 0, "passing", now + 1_000)).not.toBeNull();
  });

  test("a second failed attempt makes even a quick pass a fix", () => {
    const now = Date.now();
    recordRun("npm test", 1, "1 failing", now);
    recordRun("npm test", 1, "1 failing", now + 500);
    const lesson = recordRun("npm test", 0, "passing", now + 900);
    expect(lesson?.attempts).toBe(2);
  });

  test("a different command's failure does not pair with this pass", () => {
    const now = Date.now();
    recordRun("cargo test --lib", 1, "test failed", now);
    // Pairing these would claim a fix that was never demonstrated: the command that
    // passed is not the command that failed.
    expect(recordRun("cargo test -p other", 0, "ok", now + 200_000)).toBeNull();
  });

  test("a failure older than the window is forgotten rather than paired", () => {
    const now = Date.now();
    recordRun(CHECK, 1, ERROR, now);
    expect(recordRun(CHECK, 0, "ok", now + 3 * 60 * 60_000)).toBeNull();
  });

  test("whitespace is not a different command", () => {
    const now = Date.now();
    recordRun("  cargo   check --lib ", 1, ERROR, now);
    expect(recordRun("cargo check --lib", 0, "ok", now + 200_000)).not.toBeNull();
  });
});

describe("the symptom", () => {
  test("is the error line, not the progress above it", () => {
    expect(__testing.symptomOf(ERROR)).toContain("E0432");
    expect(__testing.symptomOf(ERROR)).not.toContain("Compiling");
  });

  test("finds a test failure that names no error", () => {
    const output = [
      "PASS  src/lib/diff.test.ts",
      "FAILED  src/lib/transcript.test.ts > a memory recall row",
    ].join("\n");
    expect(__testing.symptomOf(output)).toContain("transcript.test.ts");
  });

  test("finds a panic", () => {
    const output = ["running 3 tests", "thread 'main' panicked at src/fs.rs:88:5:"].join("\n");
    expect(__testing.symptomOf(output)).toContain("panicked");
  });

  test("falls back to the first line rather than nothing", () => {
    // Unhelpful still beats empty: the note is meant to be recognised, not parsed.
    expect(__testing.symptomOf("\n\nsomething went sideways\n")).toBe("something went sideways");
  });

  test("is trimmed, because a wall of output is not a symptom", () => {
    const long = `error: ${"x".repeat(500)}`;
    expect(__testing.symptomOf(long).length).toBeLessThan(260);
    expect(__testing.symptomOf(long).endsWith("…")).toBe(true);
  });

  test("survives output with no lines at all", () => {
    const now = Date.now();
    recordRun(CHECK, 1, "", now);
    const lesson = recordRun(CHECK, 0, "ok", now + 200_000);
    expect(lesson?.symptom).toBe("");
  });
});

describe("what the model is told", () => {
  test("carries the symptom, the effort, and when not to write a note", () => {
    const now = Date.now();
    recordRun(CHECK, 1, ERROR, now);
    recordRun("npx tsc --noEmit", 1, "error TS2304", now + 1000);
    const lesson = recordRun(CHECK, 0, "Finished", now + 200_000);
    const prompt = lessonPrompt(lesson!);

    expect(prompt).toContain(CHECK);
    expect(prompt).toContain("E0432");
    expect(prompt).toContain("3m ago");
    expect(prompt).toContain("1 other command in between");
    // The four parts, in the order they are worth in six months.
    expect(prompt).toContain("verbatim");
    expect(prompt).toContain("diagnosis");
    expect(prompt).toContain("the tell");
    // And the brake: most fixes are not worth a note.
    expect(prompt).toContain("Skip it when the fix was obvious");
  });

  test("never says a fix landed zero seconds after the break", () => {
    const now = Date.now();
    recordRun("npm test", 1, "1 failing", now);
    recordRun("npx tsc --noEmit", 0, "", now + 100);
    const prompt = lessonPrompt(recordRun("npm test", 0, "passing", now + 300)!);
    expect(prompt).toContain("1s ago");
    expect(prompt).not.toContain("0s ago");
  });

  test("does not claim other commands ran when none did", () => {
    const now = Date.now();
    recordRun(CHECK, 1, ERROR, now);
    const prompt = lessonPrompt(recordRun(CHECK, 0, "ok", now + 200_000)!);
    expect(prompt).not.toContain("in between");
  });
});

describe("housekeeping", () => {
  test("tracking is bounded, so a long session does not grow without limit", () => {
    const now = Date.now();
    for (let index = 0; index < 200; index += 1) {
      recordRun(`command-${index}`, 1, "error: no", now);
    }
    expect(__testing.tracked()).toBeLessThanOrEqual(64);
  });

  test("an empty command is ignored rather than tracked", () => {
    expect(recordRun("   ", 1, "error")).toBeNull();
    expect(__testing.tracked()).toBe(0);
  });
});
