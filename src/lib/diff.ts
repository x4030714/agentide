/** The line diff behind an edit row. Built from the tool's *input*, never its result — `Edit`
 * answers in prose, and the input is drawable before the write has even landed. */

import type { JsonObject } from "./protocol";

export type LineKind = "context" | "add" | "remove";

/** One line of the diff before it has been placed in a file. */
export interface Change {
  kind: LineKind;
  text: string;
}

export interface DiffLine extends Change {
  /** The line's own address: new-file numbering for context and added lines, old-file for a
   * removed one — where it *was* is the number a reviewer wants. */
  number: number;
}

export interface DiffHunk {
  lines: DiffLine[];
  /** What to search for to place this hunk once the edit lands — its new side, verbatim.
   * Empty for a pure deletion, which leaves nothing on disk to find. */
  anchor: string;
}

export interface FileDiff {
  /** The path exactly as the tool gave it, so the file can be read back. */
  path: string;
  hunks: DiffHunk[];
  added: number;
  removed: number;
}

/** Above this the `before x after` LCS table costs more than the drawing is worth, and a
 * rewrite that big reads as a replacement anyway. */
const MAX_CELLS = 250_000;

/** The diff of the tool call, or `null` for anything whose input is not a file change.
 * `null` not a throw: an unrecognised tool still gets a row, falling back to its result text. */
export function toolDiff(name: string, input: JsonObject | undefined): FileDiff | null {
  if (!input) return null;
  const path = str(input.file_path);
  if (path === null) return null;

  switch (name) {
    case "Edit":
      // `replace_all` can land the same hunk in several places. Draw one — the rest are
      // identical by definition, and only the summary's count would differ.
      return assemble(path, [hunkOf(str(input.old_string) ?? "", str(input.new_string) ?? "")]);

    case "Write": {
      // Nothing to compare against: the old content is already overwritten by read-back time,
      // so diffing against a re-read would report the change as no change.
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

/** Line-level LCS diff, removals before the additions that replace them. Common prefix and
 * suffix come off first — that keeps shared lines as in-order context, not a block swap. */
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

/** The 1-based line `needle` starts on, or `null`. Line endings normalised both sides: the model
 * sends LF and disk may hold CRLF, or every CRLF file would silently lose its numbering. */
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

/** Numbers a hunk from `start`, both sides at once. The counters diverge the moment a line is
 * added or removed, which is what makes a removed line's number differ from the one under it. */
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

/** Lines, minus the empty one a trailing newline produces — otherwise every insertion draws a
 * phantom `+` under it. */
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
