import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import {
  agentInterrupt,
  checkpointCreate,
  agentPermissionReply,
  agentPrompt,
  agentStart,
  agentStop,
} from "../lib/bridge";
import { errorMessage } from "../lib/protocol";
import { isEditMode, modeOptions } from "../lib/editmode";
import type { EditMode } from "../lib/editmode";
import type { AgentEvent, Checkpoint, EffortLevel, WirePath } from "../lib/protocol";
import { formatAddr, formatTokens, initialState, reduce } from "../lib/transcript";
import { RunControls } from "./RunControls";
import type { Row } from "../lib/transcript";

interface TranscriptProps {
  root: WirePath | null;
  /** A checkpoint was taken; the turn that follows can be reverted to it. */
  onTurnStart: (checkpoint: Checkpoint) => void;
  /** The turn ended, so the review queue should re-read. */
  onTurnEnd: () => void;
}

/** Survives a restart: this is the control, so it is also the setting. */
const MODEL_KEY = "agentide.model";
const EFFORT_KEY = "agentide.effort";
const MODE_KEY = "agentide.editMode";

function stored<T extends string>(key: string): T | null {
  try {
    return (localStorage.getItem(key) as T | null) || null;
  } catch {
    return null;
  }
}

function remember(key: string, value: string | null) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* A private context can refuse storage; the choice still applies to this session. */
  }
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
export function TranscriptPane({ root, onTurnStart, onTurnEnd }: TranscriptProps) {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const [sessionId] = useState(newSessionId);
  const [draft, setDraft] = useState("");
  const [model, setModelState] = useState<string | null>(() => stored(MODEL_KEY));
  const [effort, setEffortState] = useState<EffortLevel | null>(() => stored<EffortLevel>(EFFORT_KEY));
  const [mode, setModeState] = useState<EditMode>(() => {
    const saved = stored(MODE_KEY);
    // Review is the default: edits land, nothing waits on you, and everything is
    // still reversible because the checkpoint is taken regardless of mode.
    return isEditMode(saved) ? saved : "review";
  });
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [startError, setStartError] = useState<string | null>(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    let cancelled = false;
    const onEvent = (event: AgentEvent) => {
      if (cancelled) return;
      dispatch(event);
      if (event.t === "done" || event.t === "exited") onTurnEnd();
    };
    agentStart(onEvent, { hostPermissions: true, hostTools: [] }).catch((err) => {
      if (!cancelled) setStartError(errorMessage(err));
    });
    return () => {
      cancelled = true;
      void agentStop();
    };
    // `onTurnEnd` is a stable callback from the parent; re-subscribing on every render
    // would restart the sidecar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

    /**
     * Checkpoint first, prompt second, and never the other way round: a turn that began
     * before its checkpoint is a turn with nothing to go back to. If the checkpoint
     * fails the turn does not run at all — proceeding would quietly drop the guarantee
     * the whole mode system rests on.
     */
    void (async () => {
      try {
        onTurnStart(await checkpointCreate(text.slice(0, 72)));
      } catch (err) {
        dispatch({
          t: "exited",
          code: null,
          message: `no checkpoint, so the turn did not run: ${errorMessage(err)}`,
          pending: [],
        });
        return;
      }
      try {
        await agentPrompt(sessionId, text, {
          ...modeOptions(mode),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
        });
      } catch (err) {
        dispatch({ t: "exited", code: null, message: errorMessage(err), pending: [] });
      }
    })();
  }, [draft, running, state.status, sessionId, model, effort, mode, onTurnStart]);

  const answer = useCallback((id: string, decision: "allow" | "deny") => {
    agentPermissionReply(id, decision).catch(() => {
      /* Already answered -- the `permission_decided` event tells the row what happened. */
    });
  }, []);

  const setModel = useCallback((next: string | null) => {
    setModelState(next);
    remember(MODEL_KEY, next);
  }, []);

  const setMode = useCallback((next: EditMode) => {
    setModeState(next);
    remember(MODE_KEY, next);
  }, []);

  const setEffort = useCallback((next: EffortLevel | null) => {
    setEffortState(next);
    remember(EFFORT_KEY, next);
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
        {/**
         * One live slot. Thinking outranks the model name because it is the thing that
         * changes; when nothing is happening the header says what it will run on.
         */}
        {state.thinking !== null ? (
          <span className="measure is-thinking">thinking · {formatTokens(state.thinking)}</span>
        ) : running ? (
          <span className="measure is-thinking">working</span>
        ) : (
          state.meta.model && <span className="measure">{state.meta.model}</span>
        )}
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

      <RunControls
        mode={mode}
        onMode={setMode}
        models={state.models}
        model={model}
        effort={effort}
        onModel={setModel}
        onEffort={setEffort}
        disabled={state.status === "exited"}
      />

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
            {/**
             * A div, not a button: the approval controls nest inside this row, and a
             * button inside a button is invalid markup. Expansion is wired by hand so
             * the row still answers to the keyboard when there is detail to show.
             */}
            <div
              className={[
                "t-tool",
                `is-${row.cls}`,
                `is-${row.status}`,
                row.permission?.status === "pending" ? "is-awaiting" : "",
                row.detail ? "is-expandable" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              title={row.operand}
              role={row.detail ? "button" : undefined}
              tabIndex={row.detail ? 0 : undefined}
              aria-expanded={row.detail ? expanded : undefined}
              onClick={() => row.detail && onToggle(row.addr)}
              onKeyDown={(event) => {
                if (!row.detail) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onToggle(row.addr);
                }
              }}
            >
              <span className="t-op">{row.name}</span>
              <span className="t-operand">{row.operand}</span>
              {row.permission?.status === "pending" ? (
                <span className="t-actions">
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onAnswer(row.permission!.id, "allow");
                    }}
                  >
                    Allow
                  </button>
                  <button
                    type="button"
                    className="ghost-button is-warn"
                    onClick={(event) => {
                      event.stopPropagation();
                      onAnswer(row.permission!.id, "deny");
                    }}
                  >
                    Deny
                  </button>
                </span>
              ) : (
                <span className="measure">
                  {row.status === "denied"
                    ? `denied${row.permission?.source === "host" ? " (auto)" : ""}`
                    : row.status === "running"
                      ? row.elapsed !== undefined
                        ? `${Math.round(row.elapsed)}s`
                        : "…"
                      : row.status === "abandoned"
                        ? "—"
                        : (row.measure ?? "")}
                </span>
              )}
            </div>
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
