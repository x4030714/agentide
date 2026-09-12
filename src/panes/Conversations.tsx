import { useCallback, useEffect, useState } from "react";

import { conversationRead, conversationsList } from "../lib/bridge";
import { ago } from "../lib/format";
import { searchConversations } from "../lib/conversation-search";
import { errorMessage } from "../lib/protocol";
import type { ConversationSummary } from "../lib/protocol";
import { saidIn, type Said } from "../lib/transcript";

interface ConversationsProps {
  root: string | null;
  /** Bumped when a turn ends, which is when a transcript gains content. */
  revision: number;
  /** The conversation the live transcript is currently continuing, if any. */
  resumedId: string | null;
  /** Continue one: the next prompt goes to that conversation instead of a new one. */
  onResume: (id: string) => void;
  /**
   * One line per conversation, and clicking it continues that one.
   *
   * The full pane is a browser: it reads a conversation beside the list so you can decide
   * whether you want it, which is right when it is one tab among several. Beside a
   * conversation that fills the window it is the wrong instrument -- there is nowhere to put
   * a preview, and the thing you came to do is pick one and carry on.
   */
  compact?: boolean;
}

/**
 * Every conversation this workspace has had, read straight off the agent SDK's own transcripts:
 * an entry exists because the SDK can resume it. Never written back, or it could not.
 */
export function ConversationsPane({
  root,
  revision,
  resumedId,
  onResume,
  compact = false,
}: ConversationsProps) {
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [entries, setEntries] = useState<Said[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  const reload = useCallback(async () => {
    if (!root) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      setItems(await conversationsList());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [root]);

  useEffect(() => {
    void reload();
  }, [reload, revision]);

  useEffect(() => {
    let cancelled = false;
    if (!openId) {
      setEntries(null);
      return;
    }
    conversationRead(openId)
      .then((next) => {
        if (!cancelled) setEntries(saidIn(next));
      })
      .catch((err) => {
        if (!cancelled) {
          setEntries(null);
          setError(errorMessage(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [openId]);

  const shown = searchConversations(items, query);

  /** The box itself. Shared, because a search that behaves differently in two places is two
   * searches to learn. */
  const search = (
    <input
      className="convo-search"
      type="search"
      value={query}
      placeholder={`Search ${items.length} conversation${items.length === 1 ? "" : "s"}`}
      spellCheck={false}
      onChange={(event) => setQuery(event.target.value)}
      onKeyDown={(event) => {
        // Escape empties it rather than leaving the pane: the list is the thing you came
        // for, and a filter you cannot clear from the keyboard is a filter you fight.
        if (event.key === "Escape" && query !== "") {
          event.preventDefault();
          event.stopPropagation();
          setQuery("");
        }
      }}
    />
  );

  if (!root) {
    return (
      <div className="pane conversations">
        <div className="pane-header">
          <span className="legend">Conversations</span>
        </div>
        <div className="pane-body">
          <p className="note">no workspace open</p>
        </div>
      </div>
    );
  }

  if (compact) {
    return (
      <div className="pane conversations is-compact">
        {items.length > 0 && <div className="convo-search-row">{search}</div>}
        <div className="pane-body">
          <div className="convo-list">
            {error && <p className="note is-error">{error}</p>}
            {!error && items.length === 0 && (
              <p className="note">
                {loading ? "reading…" : "no conversations yet — the first turn starts one"}
              </p>
            )}
            {!error && items.length > 0 && shown.length === 0 && (
              <p className="note">nothing matches “{query}”</p>
            )}
            {shown.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`convo-line${resumedId === item.id ? " is-live" : ""}`}
                // Everything the full row spells out, for the one time you need it. The line
                // itself carries the title, which is what you are scanning for.
                title={`${ago(item.updatedMs)} · ${item.prompts} prompt${
                  item.prompts === 1 ? "" : "s"
                }${item.branch ? ` · ${item.branch}` : ""}`}
                onClick={() => onResume(item.id)}
              >
                <span className="convo-dot" aria-hidden="true" />
                <span className="convo-name">{item.title ?? item.opening ?? item.id}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pane conversations">
      <div className="pane-header">
        <span className="legend">
          Conversations{items.length > 0 ? ` · ${items.length}` : ""}
        </span>
        <button type="button" className="ghost-button" disabled={loading} onClick={() => void reload()}>
          Refresh
        </button>
      </div>

      {items.length > 0 && <div className="convo-search-row">{search}</div>}

      <div className="pane-body changes-body">
        <div className="convo-list">
          {error && <p className="note is-error">{error}</p>}
          {!error && items.length === 0 && (
            <p className="note">
              {loading ? "reading…" : "no conversations yet — the first turn starts one"}
            </p>
          )}
          {!error && items.length > 0 && shown.length === 0 && (
            <p className="note">nothing matches “{query}”</p>
          )}

          {shown.map((item) => (
            <div
              key={item.id}
              className={`convo-row${openId === item.id ? " is-selected" : ""}${
                resumedId === item.id ? " is-live" : ""
              }`}
            >
              <button
                type="button"
                className="convo-open"
                onClick={() => setOpenId(openId === item.id ? null : item.id)}
                title={item.opening ?? item.id}
              >
                <span className="convo-name">{item.title ?? item.opening ?? item.id}</span>
                <span className="convo-meta">
                  {ago(item.updatedMs)}
                  {" · "}
                  {item.prompts} prompt{item.prompts === 1 ? "" : "s"}
                  {item.branch ? ` · ${item.branch}` : ""}
                </span>
              </button>
              {resumedId === item.id ? (
                <span className="measure convo-live">continuing</span>
              ) : (
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => onResume(item.id)}
                  title="The next prompt continues this conversation"
                >
                  Continue
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="change-detail">
          {!openId && <p className="note">pick a conversation to read it</p>}
          {openId && !entries && <p className="note">reading…</p>}
          {entries && entries.length === 0 && <p className="note">nothing was said in it</p>}
          {entries && entries.length > 0 && (
            <div className="convo-read">
              {entries.map((entry, index) => (
                <div key={index} className={`convo-message is-${entry.role}`}>
                  <span className="convo-said">{entry.text}</span>
                  {entry.tools.length > 0 && (
                    <span className="convo-tools">{entry.tools.join(", ")}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
