/** The small slice of Markdown an agent writes, parsed into blocks. Output is data, never an HTML
 * string; anything unsupported stays literal, so a stray `|` reads as a `|`. */

export type Block =
  | { kind: "paragraph"; spans: Span[] }
  | { kind: "heading"; level: 1 | 2 | 3; spans: Span[] }
  | { kind: "code"; language: string | null; text: string }
  | { kind: "list"; ordered: boolean; items: Span[][] }
  | { kind: "rule" };

export type Span =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "link"; text: string; href: string };

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", spans: parseSpans(paragraph.join("\n")) });
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      const marker = fence[1][0];
      const body: string[] = [];
      index += 1;
      // An unclosed fence runs to the end rather than swallowing the rest as a paragraph:
      // a model that gets cut off mid-block should still show the code it had written.
      while (index < lines.length) {
        const closing = FENCE.exec(lines[index]);
        if (closing && closing[1][0] === marker && !closing[2]) break;
        body.push(lines[index]);
        index += 1;
      }
      blocks.push({ kind: "code", language: fence[2] || null, text: body.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      continue;
    }

    // Checked before the bullet rule, which would otherwise claim `---`.
    if (RULE.test(line)) {
      flushParagraph();
      blocks.push({ kind: "rule" });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        kind: "heading",
        level: heading[1].length as 1 | 2 | 3,
        spans: parseSpans(heading[2]),
      });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = numbered !== null;
      const items: Span[][] = [];
      while (index < lines.length) {
        const current = lines[index];
        const match = ordered ? NUMBERED.exec(current) : BULLET.exec(current);
        if (!match) break;
        // A wrapped item continues on an indented line with no marker of its own.
        const parts = [match[1]];
        while (
          index + 1 < lines.length &&
          /^\s{2,}\S/.test(lines[index + 1]) &&
          !BULLET.test(lines[index + 1]) &&
          !NUMBERED.test(lines[index + 1])
        ) {
          index += 1;
          parts.push(lines[index].trim());
        }
        items.push(parseSpans(parts.join(" ")));
        index += 1;
      }
      index -= 1;
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  return blocks;
}

/** Inline markers, left to right. Code matches first and its contents are never rescanned, so
 * `` `**ptr` `` renders as C rather than a bold run that never closes. */
export function parseSpans(source: string): Span[] {
  const spans: Span[] = [];
  let text = "";
  let index = 0;

  const flush = () => {
    if (text) spans.push({ kind: "text", text });
    text = "";
  };

  while (index < source.length) {
    const rest = source.slice(index);

    const code = /^`([^`]+)`/.exec(rest);
    if (code) {
      flush();
      spans.push({ kind: "code", text: code[1] });
      index += code[0].length;
      continue;
    }

    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      flush();
      spans.push({ kind: "link", text: link[1], href: link[2] });
      index += link[0].length;
      continue;
    }

    const strong = /^(\*\*|__)(.+?)\1/.exec(rest);
    if (strong) {
      flush();
      spans.push({ kind: "strong", text: strong[2] });
      index += strong[0].length;
      continue;
    }

    // Single `*` only, and never one with a space after it: `2 * 3` is arithmetic and
    // `a_b_c` is an identifier, and both are more common in this app than emphasis.
    const em = /^\*([^\s*][^*]*)\*/.exec(rest);
    if (em) {
      flush();
      spans.push({ kind: "em", text: em[1] });
      index += em[0].length;
      continue;
    }

    text += source[index];
    index += 1;
  }

  flush();
  return spans;
}
