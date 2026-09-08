import { describe, expect, it } from "vitest";

import { parseMarkdown, parseSpans } from "./markdown";

/** The cases that decide whether the transcript reads as prose or as punctuation, weighted
 * to what an agent writing about this codebase produces: paths, pointers, unclosed fences. */
describe("blocks", () => {
  it("reads a fenced block with its language", () => {
    const blocks = parseMarkdown("before\n\n```rust\nfn main() {}\n```\n\nafter");
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "code", "paragraph"]);
    const code = blocks[1];
    expect(code).toMatchObject({ kind: "code", language: "rust", text: "fn main() {}" });
  });

  it("keeps an unclosed fence rather than losing the code in it", () => {
    // A reply cut off mid-block should still show what it had written.
    const blocks = parseMarkdown("```\ncargo build\nerror: something");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "code", text: "cargo build\nerror: something" });
  });

  it("does not treat blank lines inside a fence as a break", () => {
    const blocks = parseMarkdown("```\none\n\ntwo\n```");
    expect(blocks[0]).toMatchObject({ kind: "code", text: "one\n\ntwo" });
  });

  it("reads headings and stops at three", () => {
    const blocks = parseMarkdown("# One\n## Two\n#### Not a heading");
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "heading", "paragraph"]);
  });

  it("groups consecutive bullets into one list", () => {
    const blocks = parseMarkdown("- first\n- second\n- third");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "list", ordered: false });
    if (blocks[0].kind === "list") expect(blocks[0].items).toHaveLength(3);
  });

  it("tells a numbered list from a bulleted one", () => {
    const blocks = parseMarkdown("1. first\n2. second");
    expect(blocks[0]).toMatchObject({ kind: "list", ordered: true });
  });

  it("continues a wrapped list item instead of starting a paragraph", () => {
    const blocks = parseMarkdown("- a long item that\n  wraps onto another line\n- second");
    if (blocks[0].kind !== "list") throw new Error("expected a list");
    expect(blocks[0].items).toHaveLength(2);
    expect(blocks[0].items[0][0]).toMatchObject({
      kind: "text",
      text: "a long item that wraps onto another line",
    });
  });

  it("reads a rule rather than a bullet for ---", () => {
    expect(parseMarkdown("---")[0]).toMatchObject({ kind: "rule" });
  });

  it("does not leave a paragraph unflushed at the end", () => {
    const blocks = parseMarkdown("just a line with no trailing newline");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("paragraph");
  });
});

describe("inline", () => {
  it("reads bold and inline code", () => {
    expect(parseSpans("**Results:** `cargo check` ran")).toEqual([
      { kind: "strong", text: "Results:" },
      { kind: "text", text: " " },
      { kind: "code", text: "cargo check" },
      { kind: "text", text: " ran" },
    ]);
  });

  it("leaves markers inside code alone", () => {
    // `**ptr` is C, not an unclosed bold run.
    expect(parseSpans("the `**ptr` deref")).toEqual([
      { kind: "text", text: "the " },
      { kind: "code", text: "**ptr" },
      { kind: "text", text: " deref" },
    ]);
  });

  it("does not italicise multiplication", () => {
    expect(parseSpans("2 * 3 * 4")).toEqual([{ kind: "text", text: "2 * 3 * 4" }]);
  });

  it("does not italicise an identifier with underscores", () => {
    expect(parseSpans("call ide_rename_symbol here")).toEqual([
      { kind: "text", text: "call ide_rename_symbol here" },
    ]);
  });

  it("reads a link", () => {
    expect(parseSpans("see [the docs](https://example.com/x)")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", text: "the docs", href: "https://example.com/x" },
    ]);
  });

  it("leaves an unmatched marker as text", () => {
    expect(parseSpans("a ** dangling marker")).toEqual([
      { kind: "text", text: "a ** dangling marker" },
    ]);
  });
});
