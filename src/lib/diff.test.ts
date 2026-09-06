import { describe, expect, it } from "vitest";

import { diffLines, lineOf, locateHunks, summarize, toolDiff } from "./diff";
import type { Change, DiffLine } from "./diff";

/** `kind` and `text` are what a diff is; the assertions read better without the noise. */
function shape(changes: Change[]): string[] {
  return changes.map((change) => `${MARK[change.kind]}${change.text}`);
}

const MARK = { context: " ", add: "+", remove: "-" } as const;

/** A located line, as `number kind text`, which is the row the pane draws. */
function placed(lines: DiffLine[]): string[] {
  return lines.map((line) => `${line.number}${MARK[line.kind]}${line.text}`);
}

describe("diffLines", () => {
  it("marks only the inserted line", () => {
    expect(shape(diffLines("one\ntwo", "one\nnew\ntwo"))).toEqual([" one", "+new", " two"]);
  });

  it("marks only the deleted line", () => {
    expect(shape(diffLines("one\ngone\ntwo", "one\ntwo"))).toEqual([" one", "-gone", " two"]);
  });

  it("draws a replacement as the old line and then the new one", () => {
    expect(shape(diffLines("a\nold\nb", "a\nnew\nb"))).toEqual([" a", "-old", "+new", " b"]);
  });

  it("says nothing changed when nothing changed", () => {
    expect(shape(diffLines("a\nb\n", "a\nb\n"))).toEqual([" a", " b"]);
  });

  it("does not invent a blank last line for text that ends in a newline", () => {
    expect(shape(diffLines("", "one\n"))).toEqual(["+one"]);
  });

  it("keeps a moved line as one removal and one addition rather than rewriting the block", () => {
    expect(shape(diffLines("a\nb\nc", "b\nc\na"))).toEqual(["-a", " b", " c", "+a"]);
  });
});

describe("locating a hunk", () => {
  const file = "one\ntwo\nTHREE\nextra\nfour\n";
  const edit = { file_path: "C:/w/f.ts", old_string: "two\nthree", new_string: "two\nTHREE\nextra" };

  it("numbers the hunk from the line the new text sits on", () => {
    const diff = toolDiff("Edit", edit)!;
    const [hunk] = locateHunks(diff.hunks, file);
    expect(placed(hunk.lines)).toEqual(["2 two", "3-three", "3+THREE", "4+extra"]);
  });

  it("numbers from one when the new text is not in the file", () => {
    const diff = toolDiff("Edit", edit)!;
    const [hunk] = locateHunks(diff.hunks, "something else entirely\n");
    expect(placed(hunk.lines)).toEqual(["1 two", "2-three", "2+THREE", "3+extra"]);
  });

  it("locates a hunk in a file stored with CRLF", () => {
    expect(lineOf("one\r\ntwo\r\nthree\r\n", "two\nthree")).toBe(2);
  });

  it("has nowhere to look for a hunk that only deletes", () => {
    expect(lineOf("one\ntwo\n", "")).toBeNull();
  });
});

describe("toolDiff", () => {
  it("draws a Write as the whole file arriving", () => {
    const diff = toolDiff("Write", { file_path: "C:/w/new.ts", content: "a\nb\n" })!;
    expect(diff.path).toBe("C:/w/new.ts");
    expect(placed(diff.hunks[0].lines)).toEqual(["1+a", "2+b"]);
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(0);
  });

  it("draws one hunk per edit of a MultiEdit", () => {
    const diff = toolDiff("MultiEdit", {
      file_path: "C:/w/f.ts",
      edits: [
        { old_string: "a", new_string: "A" },
        { old_string: "b\nc", new_string: "b" },
      ],
    })!;
    expect(diff.hunks.map((hunk) => shape(hunk.lines))).toEqual([["-a", "+A"], [" b", "-c"]]);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(2);
  });

  it("has no diff for a tool whose input is not a file change", () => {
    expect(toolDiff("NotebookEdit", { notebook_path: "C:/w/n.ipynb", new_source: "x" })).toBeNull();
    expect(toolDiff("Edit", undefined)).toBeNull();
    expect(toolDiff("Write", { file_path: "C:/w/f.ts" })).toBeNull();
    expect(toolDiff("MultiEdit", { file_path: "C:/w/f.ts", edits: "not an array" })).toBeNull();
  });
});

describe("summarize", () => {
  const of = (before: string, after: string) =>
    summarize(toolDiff("Edit", { file_path: "C:/w/f.ts", old_string: before, new_string: after })!);

  it("names both halves of a replacement", () => {
    expect(of("one\n", "two\nthree\n")).toBe("Added 2 lines, removed 1 line");
  });

  it("omits the half that did not happen", () => {
    expect(of("", "one\n")).toBe("Added 1 line");
    expect(of("one\n", "")).toBe("Removed 1 line");
  });

  it("says so when an edit changed nothing", () => {
    expect(of("same\n", "same\n")).toBe("No lines changed");
  });
});
