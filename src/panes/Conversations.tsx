import { useCallback, useEffect, useState } from "react";

import { conversationRead, conversationsList } from "../lib/bridge";
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
 * Every conversation this workspace has had.
 *
 * These are the agent SDK's own transcripts, read straight off disk. That is what makes
 * the list honest about what can be continued: an entry here exists because the SDK can
 * resume it, not because this app remembered something about it. Nothing is written back
 * for the same reason -- a transcript this app edited is one the SDK could no longer
 * resume, which would turn the list into a museum.
 *
 * The live transcript stays where it is. Reading an old conversation next to a running
 * one is the common case, and moving the running one out of the way to look something up
 * would be the wrong trade.
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

/**
 * "3 hours ago". Coarse on purpose: the only question this list answers about time is
 * which conversation is the one you were just in, and an exact clock time makes that
 * harder to see, not easier.
 */
function ago(atMs: number | null): string {
  if (!atMs) return "unknown";
  const seconds = Math.max(0, (Date.now() - atMs) / 1000);
  // Each divisor is the size of the unit held now, paired with the unit it produces.
  const steps: Array<[number, string]> = [
    [60, "minute"],
    [60, "hour"],
    [24, "day"],
    [7, "week"],
    [4.35, "month"],
    [12, "year"],
  ];
  let value = seconds;
  let unit = "second";
  for (const [size, name] of steps) {
    if (value < size) break;
    value /= size;
    unit = name;
  }
  const whole = Math.floor(value);
  if (unit === "second" && whole < 30) return "just now";
  return `${whole} ${unit}${whole === 1 ? "" : "s"} ago`;
}
