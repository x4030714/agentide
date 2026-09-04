import { memo } from "react";

import { parseMarkdown } from "../lib/markdown";
import type { Block, Span } from "../lib/markdown";

/**
 * An agent's reply, rendered.
 *
 * React elements all the way down -- no HTML string, no `dangerouslySetInnerHTML`, no
 * sanitiser to keep correct. The text being rendered is written by a model that has just
 * read files off disk, so the safest thing to do with it is never treat it as markup.
 *
 * Memoised on the source: a turn re-renders the whole transcript on every event, and
 * re-parsing every past reply each time is work with no output.
 */
export const Markdown = memo(function Markdown({ source }: { source: string }) {
  return (
    <>
      {parseMarkdown(source).map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </>
  );
});

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "heading": {
      // One visual weight for all three levels, differing only in size: a reply is a
      // few paragraphs, not a document, and a full heading scale inside a message
      // bubble reads as someone shouting.
      const Tag = (["h3", "h4", "h5"] as const)[block.level - 1];
      return (
        <Tag className={`md-heading is-h${block.level}`}>
          <Spans spans={block.spans} />
        </Tag>
      );
    }

    case "code":
      return (
        <pre className="md-code">
          {block.language && <span className="md-lang">{block.language}</span>}
          <code>{block.text}</code>
        </pre>
      );

    case "list":
      return block.ordered ? (
        <ol className="md-list">
          {block.items.map((item, index) => (
            <li key={index}>
              <Spans spans={item} />
            </li>
          ))}
        </ol>
      ) : (
        <ul className="md-list">
          {block.items.map((item, index) => (
            <li key={index}>
              <Spans spans={item} />
            </li>
          ))}
        </ul>
      );

    case "rule":
      return <hr className="md-rule" />;

    case "paragraph":
      return (
        <p className="md-p">
          <Spans spans={block.spans} />
        </p>
      );
  }
}

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((span, index) => {
        switch (span.kind) {
          case "code":
            return (
              <code key={index} className="md-inline-code">
                {span.text}
              </code>
            );
          case "strong":
            return <strong key={index}>{span.text}</strong>;
          case "em":
            return <em key={index}>{span.text}</em>;
          case "link":
            // Rendered, not followed. Nothing in this app opens a browser, and a link
            // that looks clickable and does nothing is worse than one that does not.
            return (
              <span key={index} className="md-link" title={span.href}>
                {span.text}
              </span>
            );
          case "text":
            return <span key={index}>{span.text}</span>;
        }
      })}
    </>
  );
}
