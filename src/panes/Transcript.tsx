import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useFocusTarget } from "../lib/keys";

import {
  agentInterrupt,
  checkpointCreate,
  agentPermissionReply,
  agentPrompt,
  agentStart,
  agentStop,
  agentToolReply,
  conversationRead,
  memoryVault,
} from "../lib/bridge";
import { errorMessage } from "../lib/protocol";
import { isEditMode, modeOptions } from "../lib/editmode";
import type { EditMode } from "../lib/editmode";
import { isPromptMode, readTunedPrompt } from "../lib/promptmode";
import type { PromptMode } from "../lib/promptmode";
import type {
  AgentEvent,
  Checkpoint,
  EffortLevel,
  JsonObject,
  SlashCommand,
  ToolResult,
  WirePath,
} from "../lib/protocol";
import {
  editedFile,
  formatAddr,
  formatTokens,
  initialState,
  liveActivity,
  reduce,
} from "../lib/transcript";
import { Markdown } from "./Markdown";
import { RunControls } from "./RunControls";
import type { Activity, Row } from "../lib/transcript";

interface TranscriptProps {
  root: WirePath | null;
  /**
   * A checkpoint was taken; the turn that follows can be reverted to it.
   *
   * `null` when one could not be taken and the turn ran anyway. It has to be said rather
   * than left unsaid: keeping the previous turn's checkpoint would leave the review queue
   * measuring this turn's edits against a point two turns back, and reverting would undo
   * work nobody asked to lose.
   */
  onTurnStart: (checkpoint: Checkpoint | null) => void;
  /** The turn ended, so the review queue should re-read. */
  onTurnEnd: () => void;
  /**
   * Answer one `ide_*` call. Owned by the parent, which is what holds the editor and the
   * language servers; this pane only knows when a call arrives.
   */
  onToolCall: (name: string, args: JsonObject) => Promise<ToolResult>;
  /**
   * The agent is about to change this file, so show it.
   *
   * Watching an edit land is the reason to have an editor in an agent's IDE at all;
   * the file already reloads from disk when the watcher reports it, so opening it is
   * the whole of what was missing.
   */
  onAgentEdit: (path: WirePath) => void;
  /** The names `onToolCall` will answer. Anything else is answered by the Rust core. */
  hostTools: readonly string[];
  /**
   * A past conversation to continue instead of this session's own, chosen in the
   * Conversations panel. Sent with every prompt: the sidecar adopts the id, so repeating
   * it costs nothing, and dropping it after the first turn would branch the conversation
   * without saying so.
   */
  resumeConversation: string | null;
  /**
   * The user started a new conversation. The parent clears whatever it was continuing:
   * this pane owns the transcript, but which past conversation is being resumed is the
   * parent's state.
   */
  onNewConversation: () => void;
}

/** Survives a restart: this is the control, so it is also the setting. */
const MODEL_KEY = "agentide.model";
const EFFORT_KEY = "agentide.effort";
const MODE_KEY = "agentide.editMode";
const PROMPT_KEY = "agentide.promptMode";

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

/**
 * How long to wait for a checkpoint before running the turn without one.
 *
 * Generous on purpose. A real project with a large tree can legitimately take many
 * seconds, and timing that out would cost the safety net exactly where it is worth
 * most. This bounds the pathological case -- a drive root, where the walk is the whole
 * disk -- rather than trimming the normal one.
 */
const CHECKPOINT_MS = 30_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`still running after ${Math.round(ms / 1000)}s`)), ms),
    ),
  ]);
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
 * renders an approval row, and it declares the `ide_*` tools its parent can answer --
 * anything outside that list is refused by the Rust core immediately, which is what keeps
 * an unimplemented tool from stalling a turn until the sidecar's timeout.
 */
export function TranscriptPane({
  root,
  onTurnStart,
  onTurnEnd,
  onToolCall,
  hostTools,
  onAgentEdit,
  resumeConversation,
  onNewConversation,
}: TranscriptProps) {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const [sessionId, setSessionId] = useState(newSessionId);

  const [draft, setDraft] = useState("");
  const [model, setModelState] = useState<string | null>(() => stored(MODEL_KEY));
  const [effort, setEffortState] = useState<EffortLevel | null>(() => stored<EffortLevel>(EFFORT_KEY));
  const [mode, setModeState] = useState<EditMode>(() => {
    const saved = stored(MODE_KEY);
    // Review is the default: edits land, nothing waits on you, and everything is
    // still reversible because the checkpoint is taken regardless of mode.
    return isEditMode(saved) ? saved : "review";
  });
  const [promptMode, setPromptModeState] = useState<PromptMode>(() => {
    const saved = stored(PROMPT_KEY);
    return isPromptMode(saved) ? saved : "tuned";
  });
  /** Whether either system.md exists, so Tuned can admit when it adds nothing. */
  const [tunedAvailable, setTunedAvailable] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [startError, setStartError] = useState<string | null>(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // The sidecar is started once, on mount; both of these are read from a ref so a new
  // callback identity from the parent does not restart it.
  const toolCallRef = useRef(onToolCall);
  const hostToolsRef = useRef(hostTools);
  const onAgentEditRef = useRef(onAgentEdit);
  /**
   * The memory vault, once Rust has resolved it. A ref rather than state for the same
   * reason the callbacks above are: the event handler is installed on mount and must not
   * be rebuilt when this arrives. `null` until then, which only means an early note could
   * still open -- the fetch is one IPC call and beats the first turn.
   */
  const vaultRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void memoryVault()
      .then(({ vault }) => {
        if (!cancelled) vaultRef.current = vault;
      })
      .catch(() => {
        /* No vault means nothing to exclude, which is how this behaved before memory. */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  /**
   * Draw the conversation being continued, rather than only telling the SDK about it.
   *
   * Keyed on the id alone: re-reading on every render would fight the live rows, and the
   * only moment a replay is wanted is when the conversation being continued changes. A
   * read that fails leaves the transcript as it was -- the resume itself still works,
   * since that is the SDK's business and not this pane's.
   */
  useEffect(() => {
    if (!resumeConversation) return;
    let cancelled = false;
    void conversationRead(resumeConversation)
      .then((entries) => {
        if (!cancelled) {
          dispatch({ t: "conversation_loaded", id: resumeConversation, entries });
        }
      })
      .catch(() => {
        /* Nothing to replay; the turn will still resume. */
      });
    return () => {
      cancelled = true;
    };
  }, [resumeConversation]);

  useEffect(() => {
    toolCallRef.current = onToolCall;
    hostToolsRef.current = hostTools;
    onAgentEditRef.current = onAgentEdit;
  }, [onToolCall, hostTools, onAgentEdit]);

  useEffect(() => {
    let cancelled = false;
    const onEvent = (event: AgentEvent) => {
      if (cancelled) return;
      dispatch(event);
      if (event.t === "event") {
        const edited = editedFile(event.msg, vaultRef.current ?? undefined);
        if (edited) onAgentEditRef.current(edited as WirePath);
      }
      if (event.t === "done" || event.t === "exited") onTurnEnd();
      if (event.t === "tool_call") {
        // Every call must be answered, including the ones that fail: an unanswered
        // `tool_call` leaves the turn waiting on the sidecar's timeout with no sign of
        // why. `answerIdeTool` already catches its own errors; this catches the rest.
        void toolCallRef.current(event.name, event.args)
          .catch((err) => ({ ok: false, error: errorMessage(err) }) as ToolResult)
          .then((result) => agentToolReply(event.id, result))
          .catch(() => {
            /* The reply itself failed -- the session is already gone. */
          });
      }
    };
    agentStart(onEvent, { hostPermissions: true, hostTools: [...hostToolsRef.current] }).catch((err) => {
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

  // Only to label the control. The prompt itself is re-read at submit, so editing the
  // file takes effect on the next turn without a restart.
  useEffect(() => {
    let cancelled = false;
    void readTunedPrompt(root).then((text) => {
      if (!cancelled) setTunedAvailable(text !== null);
    });
    return () => {
      cancelled = true;
    };
  }, [root]);

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
  // Derived on every render rather than memoised: it reads two fields and returns a small
  // object, and the render it feeds is already happening because a row arrived.
  const live: Activity | null = liveActivity(state);

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text || running || state.status === "exited") return;
    setDraft("");
    pinned.current = true;
    dispatch({ t: "prompt_submitted", text });

    /**
     * Checkpoint first, prompt second, and never the other way round: a turn that began
     * before its checkpoint is a turn with nothing to go back to.
     *
     * A checkpoint that cannot be taken no longer stops the turn, though. Some
     * workspaces cannot have one -- a drive root cannot hold `.agentide` without
     * elevation, and a huge tree takes long enough that waiting is its own failure --
     * and refusing to run there made the app useless in a place someone reasonably
     * wants to work. The guarantee is not dropped quietly, which was the real objection:
     * the turn says on its own line that nothing in it can be reverted, and the parent
     * is told there is no checkpoint so the review queue does not measure against a
     * stale one.
     */
    void (async () => {
      try {
        onTurnStart(await withTimeout(checkpointCreate(text.slice(0, 72)), CHECKPOINT_MS));
      } catch (err) {
        onTurnStart(null);
        dispatch({
          t: "local_notice",
          tone: "warn",
          text: `no checkpoint — nothing in this turn can be reverted (${errorMessage(err)})`,
        });
      }
      try {
        // Read now, not at mount: the file is meant to be iterated on, and a cached
        // copy would make editing it silently do nothing until a restart.
        const append = promptMode === "tuned" ? await readTunedPrompt(root) : null;
        await agentPrompt(sessionId, text, {
          ...modeOptions(mode),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(append ? { systemPromptAppend: append } : {}),
          ...(resumeConversation ? { resumeConversation } : {}),
        });
      } catch (err) {
        dispatch({ t: "exited", code: null, message: errorMessage(err), pending: [] });
      }
    })();
  }, [draft, running, state.status, sessionId, model, effort, mode, promptMode, root, resumeConversation, onTurnStart]);

  /**
   * Start over: a new session id, an empty transcript, nothing resumed.
   *
   * The sidecar is left running. It holds no per-conversation state of its own -- the
   * SDK's transcript is keyed by session id and a new id is simply a new one -- so
   * restarting it would cost a second of startup to achieve nothing.
   */
  const newConversation = useCallback(() => {
    setSessionId(newSessionId());
    setDraft("");
    setExpanded(new Set());
    dispatch({ t: "conversation_reset" });
    onNewConversation();
    pinned.current = true;
  }, [onNewConversation]);

  const answer = useCallback((id: string, decision: "allow" | "deny") => {
    agentPermissionReply(id, decision).catch(() => {
      /* Already answered -- the `permission_decided` event tells the row what happened. */
    });
  }, []);

  const setModel = useCallback((next: string | null) => {
    setModelState(next);
    remember(MODEL_KEY, next);
  }, []);

  const setPromptMode = useCallback((next: PromptMode) => {
    setPromptModeState(next);
    remember(PROMPT_KEY, next);
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
        {/* Disabled rather than hidden while a turn runs: a control that vanishes when
            you reach for it is worse than one that says why it will not work. */}
        <button
          type="button"
          className="ghost-button"
          disabled={running || state.rows.length === 0}
          title="Start a new conversation"
          onClick={newConversation}
        >
          New
        </button>
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
        promptMode={promptMode}
        onPromptMode={setPromptMode}
        tunedAvailable={tunedAvailable}
        models={state.models}
        model={model}
        effort={effort}
        onModel={setModel}
        onEffort={setEffort}
        mcpServers={state.meta.mcpServers ?? []}
        disabled={state.status === "exited"}
      />

      {live && <ActivityLine activity={live} startedAt={state.turnStartedAt} />}

      <Composer
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        disabled={!root || state.status === "exited"}
        running={running}
        commands={state.commands}
      />
    </div>
  );
}

/**
 * Memoised, and not as a micro-optimisation.
 *
 * The reducer returns a new `rows` array on every agent event, so an unmemoised row
 * re-renders every row in the transcript for each of the hundreds of events in a turn --
 * quadratic in the length of the run, which is exactly the case this pane exists for.
 * `replace()` only ever swaps the one row it changes, so identity comparison prunes all
 * but that row, and the callbacks below are `useCallback`-stable for the same reason.
 */
const TranscriptRow = memo(function TranscriptRow({
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
          {/* The reply is Markdown; the prompt above is not, because that one is
              exactly what the person typed and must not be reinterpreted. */}
          <div className="t-text">
            <Markdown source={row.text} />
          </div>
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
});

/**
 * What the agent is doing, while it is doing it.
 *
 * Above the composer rather than in the pane header: this is read while waiting, and
 * waiting happens with your eyes on the thing you just typed into. The header keeps its
 * one-word version for when the transcript is scrolled away.
 *
 * The elapsed clock is the point of the whole line. A tool name tells you what is
 * happening; a number climbing past thirty seconds is what tells you something is wrong,
 * and it is the only signal here that distinguishes slow from hung.
 */
function ActivityLine({ activity, startedAt }: { activity: Activity; startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());

  // One interval, only while a turn is live, and it stops when this unmounts. A second
  // clock ticking beside the SDK's own `tool_progress` would be two answers to one
  // question.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  return (
    <div className={`activity${activity.blocked ? " is-blocked" : ""}`} role="status" aria-live="polite">
      <span className="activity-mark" aria-hidden="true" />
      <span className="activity-verb">{activity.verb}</span>
      {activity.detail && <span className="activity-detail">{activity.detail}</span>}
      <span className="activity-measure">
        {activity.tokens !== undefined && `${formatTokens(activity.tokens)} · `}
        {seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}
      </span>
    </div>
  );
}

function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
  running,
  commands,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  running: boolean;
  /** What this installation accepts, as the SDK reported it. */
  commands: SlashCommand[];
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [highlight, setHighlight] = useState(0);

  // Ctrl+2 lands here: the composer is what the transcript column is *for*, and focusing
  // the scrollback instead would put the cursor nowhere useful.
  useFocusTarget("composer", () => ref.current?.focus());

  // Ctrl+2 lands here: the composer is what the transcript column is *for*, and focusing
  // the scrollback instead would put the cursor nowhere useful.
  useFocusTarget("composer", () => ref.current?.focus());

  /**
   * The commands worth offering for what has been typed so far.
   *
   * Only while the draft is a single `/word` with no space after it: past that the user
   * is writing the command's arguments, and a menu over the top of that is in the way.
   * Aliases match too but are not listed, because `/cost` and `/usage` being two rows
   * for one command makes the list longer without making it more useful.
   */
  const matches = useMemo(() => {
    const typed = /^\/(\S*)$/.exec(value);
    if (!typed) return [];
    const query = typed[1].toLowerCase();
    return commands
      .filter(
        (command) =>
          command.name.toLowerCase().startsWith(query) ||
          command.aliases?.some((alias) => alias.toLowerCase().startsWith(query)),
      )
      .slice(0, 8);
  }, [value, commands]);

  // Any change to the list puts the selection back at the top, so typing one more
  // character cannot leave the highlight on a row that has moved.
  useEffect(() => {
    setHighlight(0);
  }, [matches.length, value]);

  const complete = (command: SlashCommand) => {
    // A command that takes arguments keeps the cursor after a space, ready for them; one
    // that does not is left ready to send.
    onChange(`/${command.name}${command.argumentHint ? " " : ""}`);
    ref.current?.focus();
  };

  // Grow to the content, to a point; past that the field scrolls.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  return (
    <div className="composer">
      {matches.length > 0 && (
        <div className="command-menu" role="listbox" aria-label="Commands">
          {matches.map((command, index) => (
            <button
              key={command.name}
              type="button"
              role="option"
              aria-selected={index === highlight}
              className={`command-row${index === highlight ? " is-on" : ""}`}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => complete(command)}
            >
              <span className="command-name">/{command.name}</span>
              {command.argumentHint && (
                <span className="command-args">{command.argumentHint}</span>
              )}
              <span className="command-note">{command.description}</span>
            </button>
          ))}
        </div>
      )}
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
          if (matches.length > 0) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setHighlight((at) => (at + step + matches.length) % matches.length);
              return;
            }
            if (event.key === "Tab") {
              event.preventDefault();
              complete(matches[highlight]);
              return;
            }
            if (event.key === "Escape") {
              // Dismiss the menu without losing what was typed.
              event.preventDefault();
              onChange(`${value} `);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && matches[highlight].argumentHint) {
              // A command that wants arguments should not be sent by the Enter that
              // picked it out of the list.
              event.preventDefault();
              complete(matches[highlight]);
              return;
            }
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
    </div>
  );
}
