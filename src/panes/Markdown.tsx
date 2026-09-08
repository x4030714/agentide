import { memo } from "react";

import { parseMarkdown } from "../lib/markdown";
import type { Block, Span } from "../lib/markdown";

/**
 * An agent's reply as React elements -- never as markup, since a model that just read your
 * disk wrote it. Memoised: a turn re-renders the whole transcript on every event.
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
      // One weight for all three levels, size only: a full heading scale inside a message
      // bubble reads as shouting.
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
