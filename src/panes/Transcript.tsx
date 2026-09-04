import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import {
  agentInterrupt,
  agentPermissionReply,
  agentPrompt,
  agentStart,
  agentStop,
} from "../lib/bridge";
import { errorMessage } from "../lib/protocol";
import type { AgentEvent, WirePath } from "../lib/protocol";
import { formatAddr, initialState, reduce } from "../lib/transcript";
import type { Row } from "../lib/transcript";

interface TranscriptProps {
  root: WirePath | null;
}

/** A conversation handle. `crypto.randomUUID` needs a secure context; not all are. */
function newSessionId(): string {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The agent's turn, drawn as a function in a listing: an address column that never
 * renumbers, one addressed row per tool call, and a boundary rule closing each turn.
 *
 * The pane owns the sidecar's lifetime. It declares `hostPermissions: true` because it
 * renders an approval row; it declares no `hostTools`, so the Rust core answers every
 * `ide_*` call immediately with "not available in this build" rather than stalling a
 * turn on a backend that arrives in phase 3.
 */
export function TranscriptPane({ root }: TranscriptProps) {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const [sessionId] = useState(newSessionId);
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [startError, setStartError] = useState<string | null>(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    let cancelled = false;
    const onEvent = (event: AgentEvent) => {
      if (!cancelled) dispatch(event);
    };
    agentStart(onEvent, { hostPermissions: true, hostTools: [] }).catch((err) => {
      if (!cancelled) setStartError(errorMessage(err));
    });
    return () => {
      cancelled = true;
      void agentStop();
    };
  }, []);

  // Follow the tail, unless the reader has scrolled away from it.
  useEffect(() => {
    const body = bodyRef.current;
    if (body && pinned.current) body.scrollTop = body.scrollHeight;
  }, [state.rows]);

  const onScroll = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    pinned.current = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
  }, []);

  const running = state.status === "running";

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text || running || state.status === "exited") return;
    setDraft("");
    pinned.current = true;
    dispatch({ t: "prompt_submitted", text });
    agentPrompt(sessionId, text).catch((err) =>
      dispatch({ t: "exited", code: null, message: errorMessage(err), pending: [] }),
    );
  }, [draft, running, state.status, sessionId]);

  const answer = useCallback((id: string, decision: "allow" | "deny") => {
    agentPermissionReply(id, decision).catch(() => {
      /* Already answered -- the `permission_decided` event tells the row what happened. */
    });
  }, []);

  const toggle = useCallback((addr: number) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(addr)) next.delete(addr);
      else next.add(addr);
      return next;
    });
  }, []);

  return (
    <div className="pane transcript">
      <div className="pane-header">
        <span className="legend">Transcript</span>
        {state.meta.model && <span className="measure">{state.meta.model}</span>}
        {running && (
          <button
            type="button"
            className="ghost-button is-warn"
            onClick={() => void agentInterrupt(sessionId)}
          >
            Stop
          </button>
        )}
      </div>

      <div className="pane-body transcript-body" ref={bodyRef} onScroll={onScroll}>
        {startError && <p className="note is-error">{startError}</p>}
        {!startError && state.rows.length === 0 && (
          <p className="note">
            {root ? "no turns yet — describe a change below" : "open a folder to give the agent a workspace"}
          </p>
        )}
        {state.rows.map((row, index) => (
          <TranscriptRow
            key={row.addr}
            row={row}
            // A turn's first row opens a new block, the way a listing fences a function.
            opensTurn={index > 0 && row.turn !== state.rows[index - 1].turn}
            expanded={expanded.has(row.addr)}
            onToggle={toggle}
            onAnswer={answer}
          />
        ))}
      </div>

      <Composer
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        disabled={!root || state.status === "exited"}
        running={running}
      />
    </div>
  );
}

function TranscriptRow({
  row,
  opensTurn,
  expanded,
  onToggle,
  onAnswer,
}: {
  row: Row;
  opensTurn: boolean;
  expanded: boolean;
  onToggle: (addr: number) => void;
  onAnswer: (id: string, decision: "allow" | "deny") => void;
}) {
  const addr = <span className="t-addr">{formatAddr(row.addr)}</span>;
  const cls = ["t-row", `is-${row.kind}`, opensTurn ? "opens-turn" : ""]
    .filter(Boolean)
    .join(" ");

  switch (row.kind) {
    case "prompt":
      return (
        <div className={cls}>
          {addr}
          <span className="t-prompt">{row.text}</span>
        </div>
      );

    case "text":
      return (
        <div className={cls}>
          {addr}
          <span className="t-text">{row.text}</span>
        </div>
      );

    case "thinking":
      return (
        <div className={cls}>
          {addr}
          <button type="button" className="t-thinking" onClick={() => onToggle(row.addr)}>
            {expanded ? row.text : `thinking · ${row.text.length} chars`}
          </button>
        </div>
      );

    case "tool":
      return (
        <>
          <div className={cls}>
            {addr}
            <button
              type="button"
              className={`t-tool is-${row.cls} is-${row.status}`}
              onClick={() => row.detail && onToggle(row.addr)}
              title={row.operand}
            >
              <span className="t-op">{row.name}</span>
              <span className="t-operand">{row.operand}</span>
              <span className="measure">
                {row.status === "running"
                  ? row.elapsed !== undefined
                    ? `${Math.round(row.elapsed)}s`
                    : "…"
                  : row.status === "abandoned"
                    ? "—"
                    : (row.measure ?? "")}
              </span>
            </button>
          </div>
          {expanded && row.detail && (
            <div className="t-row is-detail">
              <span className="t-addr" />
              <pre className="t-detail">{row.detail}</pre>
            </div>
          )}
        </>
      );

    case "permission":
      return (
        <div className={cls}>
          {addr}
          <span className={`t-permission is-${row.status}`}>
            <span className="t-op">{row.tool}</span>
            <span className="t-operand">{row.operand}</span>
            {row.status === "pending" ? (
              <span className="t-actions">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => onAnswer(row.id, "allow")}
                >
                  Allow
                </button>
                <button
                  type="button"
                  className="ghost-button is-warn"
                  onClick={() => onAnswer(row.id, "deny")}
                >
                  Deny
                </button>
              </span>
            ) : (
              <span className="measure">
                {row.status}
                {row.source === "host" ? " (auto)" : ""}
              </span>
            )}
          </span>
        </div>
      );

    case "notice":
      return (
        <div className={cls}>
          {addr}
          <span className={`note is-${row.tone}`}>{row.text}</span>
        </div>
      );

    case "turn":
      return (
        <div className={cls}>
          {addr}
          <span className={`t-turn${row.error ? " is-error" : ""}`}>
            {row.error ?? row.reason}
            {row.durationMs !== undefined && ` · ${(row.durationMs / 1000).toFixed(1)}s`}
            {row.turns !== undefined && ` · ${row.turns} turns`}
            {row.costUsd !== undefined && ` · $${row.costUsd.toFixed(3)}`}
          </span>
        </div>
      );
  }
}

function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
  running,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  running: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow to the content, to a point; past that the field scrolls.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  return (
    <div className="composer">
      <span className="composer-mark" aria-hidden="true">
        &gt;
      </span>
      <textarea
        ref={ref}
        className="composer-input"
        rows={1}
        value={value}
        disabled={disabled}
        spellCheck={false}
        placeholder={
          disabled ? "no workspace" : running ? "running — enter queues the next turn" : "describe a change"
        }
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
    </div>
  );
}
