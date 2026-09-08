import { useCallback, useEffect, useState } from "react";

import { conversationRead, conversationsList } from "../lib/bridge";
import { ago } from "../lib/format";
import { errorMessage } from "../lib/protocol";
import type { ConversationEntry, ConversationSummary } from "../lib/protocol";

interface ConversationsProps {
  root: string | null;
  /** Bumped when a turn ends, which is when a transcript gains content. */
  revision: number;
  /** The conversation the live transcript is currently continuing, if any. */
  resumedId: string | null;
  /** Continue one: the next prompt goes to that conversation instead of a new one. */
  onResume: (id: string) => void;
}

/**
 * Every conversation this workspace has had, read straight off the agent SDK's own transcripts:
 * an entry exists because the SDK can resume it. Never written back, or it could not.
 */
export function ConversationsPane({ root, revision, resumedId, onResume }: ConversationsProps) {
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [entries, setEntries] = useState<ConversationEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
        if (!cancelled) setEntries(next);
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

      <div className="pane-body changes-body">
        <div className="convo-list">
          {error && <p className="note is-error">{error}</p>}
          {!error && items.length === 0 && (
            <p className="note">
              {loading ? "reading…" : "no conversations yet — the first turn starts one"}
            </p>
          )}

          {items.map((item) => (
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
