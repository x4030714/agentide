/**
 * The line diff behind an edit row in the transcript.
 *
 * Built from the tool's *input*, never from its result. `Edit` answers with a sentence
 * of prose, so the only place the change exists in a shape worth drawing is the
 * `old_string`/`new_string` pair the model sent — and reading it from there means the
 * diff is ready the moment the call is drawn, before the write has landed.
 *
 * Line numbers are the one thing the input cannot supply: a hunk knows its own shape and
 * nothing about where it sits. `locateHunks` rebases them against the file on disk, and
 * everything here works without it — a hunk that cannot be placed is numbered from 1 and
 * still reads. That degradation is the point: the file may have moved, a later edit may
 * have rewritten the anchor, the read may simply fail, and none of those are worth
 * withholding the diff over.
 *
 * No dependency and no Monaco. The colouring is applied over the result by the pane; this
 * runs in Node under the tests.
 */

import type { JsonObject } from "./protocol";

export type LineKind = "context" | "add" | "remove";

/** One line of the diff before it has been placed in a file. */
export interface Change {
  kind: LineKind;
  text: string;
}

export interface DiffLine extends Change {
  /**
   * The line's own address: the new file's numbering for a context or added line, the
   * old file's for a removed one. A removed line's number is where it *was*, which is
   * the number a reviewer is looking for.
   */
  number: number;
}

export interface DiffHunk {
  lines: DiffLine[];
  /**
   * What to search for to place this hunk once the edit has landed — its new side,
   * verbatim. Empty for a pure deletion, which leaves nothing on disk to find.
   */
  anchor: string;
}

export interface FileDiff {
  /** The path exactly as the tool gave it, so the file can be read back. */
  path: string;
  hunks: DiffHunk[];
  added: number;
  removed: number;
}

/**
 * Above this the LCS table costs more than the drawing is worth, and a rewrite that big
 * reads as a replacement anyway. The table is `before x after` cells; a real Edit is tens
 * of lines on each side, and the common prefix and suffix are trimmed off before it.
 */
const MAX_CELLS = 250_000;

/**
 * The diff of the tool call, or `null` for anything whose input is not a file change.
 *
 * Returning `null` rather than throwing is load-bearing: a tool this does not recognise
 * still has a transcript row, and that row falls back to its result text. New mutating
 * tools appear without warning.
 */
export function toolDiff(name: string, input: JsonObject | undefined): FileDiff | null {
  if (!input) return null;
  const path = str(input.file_path);
  if (path === null) return null;

  switch (name) {
    case "Edit":
      // `replace_all` can land the same hunk in several places. One is drawn: the others
      // are identical by definition, and the count in the summary would be the only
      // honest thing a second copy added.
      return assemble(path, [hunkOf(str(input.old_string) ?? "", str(input.new_string) ?? "")]);

    case "Write": {
      // Nothing to compare against. The previous content is on disk and already
      // overwritten by the time this is read back, so diffing against a re-read would
      // report the change as no change. The file arriving whole is the honest drawing.
      const content = str(input.content);
      return content === null ? null : assemble(path, [hunkOf("", content)]);
    }

    case "MultiEdit": {
      if (!Array.isArray(input.edits)) return null;
      const hunks: DiffHunk[] = [];
      for (const edit of input.edits) {
        if (typeof edit !== "object" || edit === null) continue;
        const one = edit as JsonObject;
        hunks.push(hunkOf(str(one.old_string) ?? "", str(one.new_string) ?? ""));
      }
      return hunks.length > 0 ? assemble(path, hunks) : null;
    }

    default:
      return null;
  }
}

/**
 * A line-level diff, longest common subsequence, removals before the additions that
 * replace them.
 *
 * The common prefix and suffix come off first. That is not only speed: it keeps the
 * shared lines of a hunk as context in the order they appear, which is what makes the
 * result readable as a diff rather than as a block replacement.
 */
export function diffLines(before: string, after: string): Change[] {
  const a = splitLines(before);
  const b = splitLines(after);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;

  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  return [
    ...a.slice(0, head).map(context),
    ...middle(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...a.slice(a.length - tail).map(context),
  ];
}

/**
 * The 1-based line `needle` starts on, or `null` when the file does not contain it.
 *
 * Line endings are normalised on both sides. The model sends `\n` in an edit and the file
 * on disk may hold `\r\n`; without this every diff on a CRLF file would quietly fall back
 * to relative numbering, which looks like the feature not working.
 */
export function lineOf(text: string, needle: string): number | null {
  if (needle === "") return null;
  const hay = unixEndings(text);
  const at = hay.indexOf(unixEndings(needle));
  if (at < 0) return null;

  let line = 1;
  for (let i = 0; i < at; i += 1) if (hay[i] === "\n") line += 1;
  return line;
}

/** The hunks, renumbered onto the file they were found in. Ones that are not stay put. */
export function locateHunks(hunks: DiffHunk[], text: string): DiffHunk[] {
  return hunks.map((hunk) => {
    const start = lineOf(text, hunk.anchor);
    return start === null ? hunk : { ...hunk, lines: numberFrom(hunk.lines, start) };
  });
}

/** The line under the operand: what the edit did, in the shape a commit message says it. */
export function summarize(diff: FileDiff): string {
  if (diff.added === 0 && diff.removed === 0) return "No lines changed";
  const added = `Added ${lines(diff.added)}`;
  const removed = `${diff.added > 0 ? "removed" : "Removed"} ${lines(diff.removed)}`;
  if (diff.removed === 0) return added;
  if (diff.added === 0) return removed;
  return `${added}, ${removed}`;
}

// --- Internals ---------------------------------------------------------------

function assemble(path: string, hunks: DiffHunk[]): FileDiff {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") added += 1;
      else if (line.kind === "remove") removed += 1;
    }
  }
  return { path, hunks, added, removed };
}

function hunkOf(before: string, after: string): DiffHunk {
  return { lines: numberFrom(diffLines(before, after), 1), anchor: after };
}

/**
 * Numbers a hunk from `start`, both sides at once. The two counters diverge as soon as
 * the hunk adds or removes a line, which is exactly what makes a removed line's number
 * differ from the added one under it.
 */
function numberFrom(changes: Change[], start: number): DiffLine[] {
  let oldLine = start;
  let newLine = start;
  return changes.map((change) => {
    if (change.kind === "remove") return { ...change, number: oldLine++ };
    if (change.kind === "add") return { ...change, number: newLine++ };
    oldLine += 1;
    return { ...change, number: newLine++ };
  });
}

function middle(a: string[], b: string[]): Change[] {
  if (a.length === 0) return b.map(add);
  if (b.length === 0) return a.map(remove);
  if (a.length * b.length > MAX_CELLS) return [...a.map(remove), ...b.map(add)];

  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const out: Change[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(context(a[i]));
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      // The removal first, so a replacement reads as the old line and then the new one.
      out.push(remove(a[i]));
      i += 1;
    } else {
      out.push(add(b[j]));
      j += 1;
    }
  }
  while (i < a.length) out.push(remove(a[i++]));
  while (j < b.length) out.push(add(b[j++]));
  return out;
}

/**
 * Lines, with the empty one a trailing newline produces dropped: a hunk ending in a
 * newline is not a hunk with a blank last line, and drawing one puts a phantom `+` under
 * every insertion.
 */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const out = unixEndings(text).split("\n");
  if (out[out.length - 1] === "") out.pop();
  return out;
}

function unixEndings(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function context(text: string): Change {
  return { kind: "context", text };
}

function add(text: string): Change {
  return { kind: "add", text };
}

function remove(text: string): Change {
  return { kind: "remove", text };
}

function lines(count: number): string {
  return `${count} line${count === 1 ? "" : "s"}`;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
