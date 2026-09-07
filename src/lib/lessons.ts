/**
 * Noticing when something that was broken has been fixed, so the reason can be written
 * down while it is still known.
 *
 * The signal is deliberately not the model saying it fixed something. Self-reported
 * success is the failure mode this project keeps paying for -- a change that "works"
 * because `cargo check` passed and `tsc` was never run, a feature reported as done that
 * threw on the first render. What is used instead is a state transition nobody can
 * misreport: the same command exited non-zero, and later exited zero. That is a fact about
 * the machine.
 *
 * What the transition cannot know is *why*, and that is the half worth keeping. So this
 * module reports the facts and asks the model to supply the diagnosis, at the one moment
 * it is cheapest to write: immediately, with the whole investigation still in context. A
 * week later nobody can reconstruct it, which is why this has to be automatic rather than
 * something you remember to ask for.
 *
 * The note lands in the vault through an ordinary `Write`, so `permissions.ask` stops it
 * for approval like any other memory. Nothing here writes anything.
 */

/** How long a failure stays worth pairing with a later pass. */
const FAILURE_TTL_MS = 60 * 60_000;

/**
 * A pass this soon after the failure, with no other command in between, is a retry rather
 * than a fix -- a flaky test, a file lock, a port that was still closing. Nothing was
 * learned and a note would only cost tokens.
 */
const RETRY_WINDOW_MS = 5_000;

/** Commands remembered at once. Old failures are dropped oldest-first. */
const MAX_TRACKED = 64;

/** How much of an error line is worth carrying. Enough to recognise, not to re-read. */
const SYMPTOM_LIMIT = 240;

/** A command that failed, and what it said when it did. */
interface Failure {
  /** The exit code of the first failure, which is the one that describes the problem. */
  exitCode: number | null;
  /** The most telling line of its output, verbatim. */
  symptom: string;
  /** When it first failed. */
  at: number;
  /** How many `ide_run` calls had been made when it first failed. */
  callIndex: number;
  /** How many times it has failed since, in case the first theory was wrong. */
  attempts: number;
}

/** A fix worth recording: what broke, and how much work it took to get here. */
export interface Lesson {
  command: string;
  /** The exit code it used to fail with. */
  exitCode: number | null;
  symptom: string;
  /** Failures of this command before it passed. */
  attempts: number;
  /** Commands run in between -- the cheapest available measure of how hard it was. */
  callsBetween: number;
  elapsedMs: number;
}

const failures = new Map<string, Failure>();
/** Every `ide_run` that reached a shell, so "how many calls ago" is answerable. */
let calls = 0;

/**
 * The key a command is remembered under.
 *
 * Whitespace only. Two commands that differ in an argument are different commands: pairing
 * `cargo test --lib` with a later `cargo test -p other` would claim a fix that was never
 * demonstrated, and a false lesson is worse than a missing one.
 */
function normalise(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/**
 * A line that announces itself as the error. Anchored, so a line merely *mentioning* the
 * word does not outrank the compiler's own.
 */
const STARTS_WITH_ERROR =
  /^\s*(error(\[[A-Za-z0-9]+\])?[:\s]|fatal|FAILED\b|failures:|✖|✗|Assertion(Error)?|SyntaxError|TypeError|ERROR\b)/;

/**
 * Markers distinctive enough to trust anywhere in a line, because the runtimes that print
 * them put something else first: Rust leads with `thread 'main'`, Python with its own
 * banner, tsc with the file and position.
 */
const NAMES_A_FAILURE =
  /(panicked at|Traceback \(most recent|error\[[A-Za-z0-9]+\]|error TS\d+|Segmentation fault|\bpanic:)/;

/**
 * The line from a failing run that says what went wrong.
 *
 * Compilers and test runners both put the useful line somewhere in the middle of output
 * that is mostly progress, so this looks for the shapes they use rather than taking the
 * first or last line. Falling back to the first non-empty line is deliberate: a symptom
 * that is merely unhelpful still beats an empty one, because the note is meant to be
 * recognised later, not parsed.
 */
function symptomOf(output: string): string {
  const lines = output.split(/\r?\n/);
  const telling =
    lines.find((line) => STARTS_WITH_ERROR.test(line)) ??
    lines.find((line) => NAMES_A_FAILURE.test(line)) ??
    lines.find((line) => /\b(error|failed|cannot|not found|refused)\b/i.test(line)) ??
    lines.find((line) => line.trim().length > 0) ??
    "";
  const trimmed = telling.trim();
  return trimmed.length > SYMPTOM_LIMIT ? `${trimmed.slice(0, SYMPTOM_LIMIT)}…` : trimmed;
}

/** Drop the oldest failures once too many are tracked, and anything past its TTL. */
function prune(now: number): void {
  for (const [command, failure] of failures) {
    if (now - failure.at > FAILURE_TTL_MS) failures.delete(command);
  }
  while (failures.size > MAX_TRACKED) {
    const oldest = failures.keys().next();
    if (oldest.done) break;
    failures.delete(oldest.value);
  }
}

/**
 * Record how a command ended, and say whether that closed a failure.
 *
 * Returns a `Lesson` only on the transition -- a first-time pass, a repeated pass and any
 * failure all return null. Reporting clears the failure, so one fix is asked about once.
 */
export function recordRun(
  command: string,
  exitCode: number | null,
  output: string,
  now: number = Date.now(),
): Lesson | null {
  const key = normalise(command);
  if (!key) return null;
  calls += 1;

  if (exitCode !== 0) {
    const existing = failures.get(key);
    if (existing) {
      // The first failure's symptom is kept: it describes what was originally broken,
      // and a second attempt often fails differently on the way to the fix.
      existing.attempts += 1;
    } else {
      failures.set(key, {
        exitCode,
        symptom: symptomOf(output),
        at: now,
        callIndex: calls,
        attempts: 1,
      });
    }
    prune(now);
    return null;
  }

  // Pruned before the lookup, not after: a failure past its TTL must be gone by the time
  // it is asked for, or an hours-old break pairs with an unrelated pass and the note
  // describes a fix that never happened.
  prune(now);
  const failure = failures.get(key);
  if (!failure) return null;
  failures.delete(key);

  const elapsedMs = now - failure.at;
  const callsBetween = calls - failure.callIndex - 1;
  // See RETRY_WINDOW_MS. Only when nothing else ran in between -- a fix that took two
  // seconds is still a fix if something happened in those two seconds.
  if (callsBetween === 0 && failure.attempts === 1 && elapsedMs < RETRY_WINDOW_MS) return null;

  return {
    command: key,
    exitCode: failure.exitCode,
    symptom: failure.symptom,
    attempts: failure.attempts,
    callsBetween,
    elapsedMs,
  };
}

/** How long ago, in words a sentence can use. Never "0s", which reads as a bug. */
function ago(ms: number): string {
  if (ms < 90_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * What the model is told when a fix lands.
 *
 * Four things are asked for, and the order is the order they are worth in six months: the
 * symptom verbatim, because it is the only part that is a fact and the only part a future
 * search will match; the cause, marked as a diagnosis because it is a hypothesis that
 * happened to work; the fix; and the tell -- what would have shortened the search. Without
 * that last line a note is a changelog entry, and changelogs are what git is for.
 *
 * It ends by saying when not to write one. Most fixes are a typo or a missing import, and
 * a vault full of those costs prompt tokens on every future turn while making the notes
 * that matter harder to surface. The model is better placed to judge that than any
 * threshold here -- it knows whether it guessed right the first time.
 */
export function lessonPrompt(lesson: Lesson): string {
  const effort = [
    `failed ${ago(lesson.elapsedMs)} ago`,
    lesson.attempts > 1 ? `${lesson.attempts} failed attempts` : null,
    lesson.callsBetween > 0
      ? `${lesson.callsBetween} other command${lesson.callsBetween === 1 ? "" : "s"} in between`
      : null,
  ]
    .filter(Boolean)
    .join(", ");

  return [
    "---",
    `This command was broken and now works: \`${lesson.command}\` (exit ${lesson.exitCode ?? "?"}, ${effort}).`,
    `It was failing with: ${lesson.symptom || "(no output captured)"}`,
    "",
    "If finding the cause took real work, write it to memory now, while you still know it:",
    "  - the symptom, verbatim, so a future search matches it",
    "  - the cause you found, said as a diagnosis rather than a fact",
    "  - the fix",
    "  - the tell: what would have got you here faster",
    "Skip it when the fix was obvious from the error, or specific to code that has since",
    "changed. A note that is not worth recalling costs tokens on every later turn.",
  ].join("\n");
}

/** Only for the tests: the internals are the part worth pinning. */
export const __testing = {
  normalise,
  symptomOf,
  reset(): void {
    failures.clear();
    calls = 0;
  },
  tracked(): number {
    return failures.size;
  },
};
