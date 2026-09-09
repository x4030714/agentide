import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useFocusTarget } from "../lib/keys";

import { useResolvedAppearance } from "../lib/appearance";
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
  readFile,
  signedIn,
} from "../lib/bridge";
import { startBackground } from "../lib/agent-shell";
import { locateHunks, summarize, toolDiff } from "../lib/diff";
import type { DiffHunk, LineKind } from "../lib/diff";
import { languageForPath } from "../lib/lsp-monaco";
import { monaco, themeFor } from "../lib/monaco-setup";
import { errorMessage } from "../lib/protocol";
import { isEditMode, modeOptions } from "../lib/editmode";
import type { EditMode } from "../lib/editmode";
import { isPromptMode, readPromptAppend, readTunedPrompt } from "../lib/promptmode";
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
import { decodeModel } from "../lib/model-menu";
import { mergeProviders, settleProviders, usePendingProviders } from "../lib/pending-providers";
import { ensureProvider } from "../lib/provider";
import { RunControls } from "./RunControls";
import type { Activity, Row } from "../lib/transcript";

interface TranscriptProps {
  root: WirePath | null;
  /** A checkpoint the next turn can revert to; `null` when one could not be taken. Said
   * rather than left unsaid, or the review queue measures against a stale point. */
  onTurnStart: (checkpoint: Checkpoint | null) => void;
  /** The turn ended, so the review queue should re-read. */
  onTurnEnd: () => void;
  /** Answer one `ide_*` call. The parent holds the editor and language servers; this
   * pane only knows when a call arrives. */
  onToolCall: (name: string, args: JsonObject) => Promise<ToolResult>;
  /** The agent is about to change this file, so show it. Watching an edit land is the
   * reason to have an editor here at all; the watcher already handles reloading. */
  onAgentEdit: (path: WirePath) => void;
  /** The names `onToolCall` will answer. Anything else is answered by the Rust core. */
  hostTools: readonly string[];
  /** A past conversation to continue, from the Conversations panel. Sent every prompt:
   * the sidecar adopts it, and dropping it after turn one would branch silently. */
  resumeConversation: string | null;
  /** A new conversation was started. The parent clears what it was resuming — this pane
   * owns the transcript, the parent owns which conversation it continues. */
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

/** How long to wait for a checkpoint before running without one. Generous: this bounds
 * the drive-root case, not the large-project case where the net is worth most. */
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

/** The agent's turn as a listing: addresses that never renumber, one row per tool call.
 * Declares only the `ide_*` tools its parent answers; the core refuses the rest at once. */
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
  /** What the sidecar has read, plus what Settings wrote since. See
   * `pending-providers.ts`; the extras drop out on the first turn. */
  const pendingProviders = usePendingProviders();
  const providers = mergeProviders(state.providers, pendingProviders);
  // Drop our copy once the sidecar has read it. In an effect, not the merge: a render that
  // wrote to the store would read and write the same state, which React may do twice.
  useEffect(() => {
    settleProviders(state.providers);
  }, [state.providers]);
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
  /** Cleared once a sign-in has actually worked, so the banner goes without a turn. */
  const [solved, setSolved] = useState<string[]>([]);

  const bodyRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // The sidecar is started once, on mount; both of these are read from a ref so a new
  // callback identity from the parent does not restart it.
  const toolCallRef = useRef(onToolCall);
  const hostToolsRef = useRef(hostTools);
  const onAgentEditRef = useRef(onAgentEdit);
  /** The memory vault, once Rust resolves it. A ref, not state: the handler is installed
   * on mount and must not be rebuilt when this lands. */
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
  /** Draw the conversation being continued, not just tell the SDK about it. Keyed on the
   * id alone — re-reading each render would fight the live rows. */
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
        // Every call gets an answer, failures included: an unanswered `tool_call` leaves
        // the turn on the sidecar's timeout with no sign of why.
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
    // `onTurnEnd` is stable; re-subscribing every render would restart the sidecar.
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

    /** Checkpoint first, prompt second, or the turn has nothing to go back to. One that
     * cannot be taken says so on its own row rather than blocking or going quiet. */
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
        const append = await readPromptAppend(promptMode, root);
        // One menu value carries both halves of the choice; see `model-menu.ts`.
        const chosen = decodeModel(model);
        if (chosen.provider) {
          // Started here, not in the sidecar, so it lands in a visible terminal tab — a
          // 30B takes tens of seconds. The sidecar still gates the turn on it answering.
          const backend = state.providers.find((entry) => entry.key === chosen.provider);
          if (backend) {
            const start = await ensureProvider(backend, root);
            if (start.started) {
              dispatch({
                t: "local_notice",
                tone: "info",
                text: `starting ${backend.key} — loading the model, see the ${start.id} terminal tab`,
              });
            } else if ("error" in start) {
              dispatch({ t: "local_notice", tone: "warn", text: start.error });
            }
          }
        }
        await agentPrompt(sessionId, text, {
          ...modeOptions(mode),
          ...(chosen.model ? { model: chosen.model } : {}),
          ...(chosen.provider ? { provider: chosen.provider } : {}),
          ...(effort ? { effort } : {}),
          ...(append ? { systemPromptAppend: append } : {}),
          // The answer is drawn as it arrives rather than when it is finished; see
          // `streaming` in `transcript.ts` for why that cannot change what is drawn.
          includePartialMessages: true,
          ...(resumeConversation ? { resumeConversation } : {}),
        });
      } catch (err) {
        dispatch({ t: "exited", code: null, message: errorMessage(err), pending: [] });
      }
    })();
  }, [draft, running, state.status, state.providers, sessionId, model, effort, mode, promptMode, root, resumeConversation, onTurnStart]);

  /** Start over: new session id, empty transcript, nothing resumed. The sidecar keeps
   * running — it holds no per-conversation state, so restarting buys nothing. */
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

  /**
   * Run a problem's own fix in a terminal tab, and drop the problem once it worked.
   *
   * A tab rather than a hidden spawn: signing in is a device code to read and a browser to
   * use, and PRODUCT.md's third principle is that every command has a visible home. The
   * re-check is a fact about the machine, not a claim by this component -- the banner only
   * clears when the credential is actually there.
   */
  const fix = useCallback((command: string) => {
    void (async () => {
      try {
        await startBackground(command, root);
      } catch (err) {
        dispatch({ t: "local_notice", tone: "error", text: errorMessage(err) });
        return;
      }
      // Signing in ends when the person finishes in their browser, which no exit code here
      // reports. Poll the one fact that settles it, and give up rather than poll forever.
      for (let tries = 0; tries < 120; tries += 1) {
        await new Promise((wake) => setTimeout(wake, 2000));
        if (await signedIn().catch(() => false)) {
          setSolved((was) => [...was, "Not signed in, so no turn can run"]);
          return;
        }
      }
    })();
  }, [root]);

  const visibleProblems = state.problems.filter((problem) => !solved.includes(problem.title));

  return (
    <div className="pane transcript">
      <div className="pane-header">
        <span className="legend">Transcript</span>
        {/* One live slot. Thinking outranks the model name because it is what changes;
            idle, the header says what the next turn will run on. */}
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
        {/* The answer as it arrives, replaced by a real row when the message lands. Not
            a `Row` — nothing provisional goes into the structure everything indexes by. */}
        {state.streaming !== null && state.streaming !== "" && (
          <div className="row is-text is-streaming">
            <div className="t-text">
              <Markdown source={state.streaming} />
            </div>
          </div>
        )}
      </div>

      {/* Above the composer, not a row: it describes the machine, and a row would scroll
          away exactly when someone needs it — before their first prompt. */}
      {visibleProblems.length > 0 && (
        <div className="setup">
          {visibleProblems.map((problem) => (
            <p key={problem.title} className={`note is-${problem.severity === "blocked" ? "error" : "warn"}`}>
              <strong>{problem.title}.</strong> {problem.fix}
              {problem.command && (
                <button type="button" className="chip is-action" onClick={() => fix(problem.command!)}>
                  Sign in
                </button>
              )}
            </p>
          ))}
        </div>
      )}

      <RunControls
        mode={mode}
        onMode={setMode}
        promptMode={promptMode}
        onPromptMode={setPromptMode}
        tunedAvailable={tunedAvailable}
        models={state.models}
        providers={providers}
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

/** Memoised, and not as a micro-optimisation: the reducer returns a fresh `rows` on every
 * event, so unmemoised this is quadratic in the length of the run. */
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
      // Its own component: this is the only row kind that holds state -- the file behind
      // an edit is read on first expand -- and a hook cannot live inside this switch.
      return (
        <ToolRow
          row={row}
          className={cls}
          expanded={expanded}
          onToggle={onToggle}
          onAnswer={onAnswer}
        />
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

/** One tool call, and what it changed. The diff comes from the call's *input*, so it is
 * ready as the row draws and survives a denied call. The body waits for an expand. */
function ToolRow({
  row,
  className,
  expanded,
  onToggle,
  onAnswer,
}: {
  row: Row & { kind: "tool" };
  className: string;
  expanded: boolean;
  onToggle: (addr: number) => void;
  onAnswer: (id: string, decision: "allow" | "deny") => void;
}) {
  // Memoised on the row's own fields: this row is replaced on every progress tick, and
  // rediffing a whole-file `Write` each time is work with no output.
  const diff = useMemo(() => toolDiff(row.name, row.input), [row.name, row.input]);

  /** Hunks placed in the file, read on first expand and kept — doing it on arrival is a
   * round trip per file for a body most rows never open. A failed read caches unplaced. */
  const [hunks, setHunks] = useState<DiffHunk[] | null>(null);

  useEffect(() => {
    // Not while the call is still running. A hunk's anchor is its *new* text, which is not
    // in the file until the write lands, so an early read would cache a failed placement.
    if (!expanded || diff === null || hunks !== null || row.status === "running") return;
    let cancelled = false;
    void readFile(diff.path)
      .then((file) => {
        if (!cancelled) setHunks(locateHunks(diff.hunks, file.text));
      })
      .catch(() => {
        if (!cancelled) setHunks(diff.hunks);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, diff, hunks, row.status]);

  // A diff is worth opening before the result arrives, and worth opening when the call was
  // denied and there is no result at all.
  const canExpand = row.detail !== undefined || diff !== null;

  return (
    <>
      <div className={className}>
        <span className="t-addr">{formatAddr(row.addr)}</span>
        {/* A div, not a button: approval controls nest here and a button inside a button
            is invalid markup. Keyboard expansion is wired by hand instead. */}
        <div
          className={[
            "t-tool",
            `is-${row.cls}`,
            `is-${row.status}`,
            row.permission?.status === "pending" ? "is-awaiting" : "",
            canExpand ? "is-expandable" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          title={row.operand}
          role={canExpand ? "button" : undefined}
          tabIndex={canExpand ? 0 : undefined}
          aria-expanded={canExpand ? expanded : undefined}
          onClick={() => canExpand && onToggle(row.addr)}
          onKeyDown={(event) => {
            if (!canExpand) return;
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
      {/* The size of the change, under the file it changed, whether or not it is open. */}
      {diff && (
        <div className="t-row is-diffstat">
          <span className="t-addr" />
          <span className="t-diffstat">{summarize(diff)}</span>
        </div>
      )}
      {expanded &&
        (diff ? (
          <div className="t-row is-detail">
            <span className="t-addr" />
            <DiffBody path={diff.path} hunks={hunks ?? diff.hunks} />
          </div>
        ) : (
          row.detail && (
            <div className="t-row is-detail">
              <span className="t-addr" />
              <pre className="t-detail">{row.detail}</pre>
            </div>
          )
        ))}
    </>
  );
}

/** The editor's own tab width, so a tab indents the same here as in the file. */
const DIFF_TAB_SIZE = 2;

const SIGNS: Record<LineKind, string> = { context: " ", add: "+", remove: "-" };

/** The edit itself: line numbers, sign, code. Coloured by `monaco.editor.colorize`, which
 * is already loaded and already themed — a second highlighter is a second palette. */
function DiffBody({ path, hunks }: { path: string; hunks: DiffHunk[] }) {
  const appearance = useResolvedAppearance();
  const [painted, setPainted] = useState<string[][] | null>(null);

  useEffect(() => {
    const language = languageForPath(path);
    // Nothing Monaco tokenizes. The uncoloured lines below are the whole diff already.
    if (language === null) return;

    // `colorize` uses whatever theme was last set globally, and the editor pane sets it.
    // With no file ever opened the diff would come back light on a dark pane.
    monaco.editor.setTheme(themeFor(appearance));

    let cancelled = false;
    void Promise.all(
      // One call per hunk rather than one per line: the tokenizer carries state between
      // lines, so a multi-line string or comment ends where it really ends.
      hunks.map((hunk) =>
        monaco.editor.colorize(hunk.lines.map((line) => line.text).join("\n"), language, {
          tabSize: DIFF_TAB_SIZE,
        }),
      ),
    )
      .then((html) => {
        // `colorize` terminates every line with `<br/>`; the split is its inverse.
        if (!cancelled) setPainted(html.map((one) => one.split("<br/>")));
      })
      .catch(() => {
        /* Uncoloured is still the whole diff; only the colour went missing. */
      });
    return () => {
      cancelled = true;
    };
  }, [path, hunks, appearance]);

  return (
    <div className="t-diff">
      {hunks.map((hunk, index) => (
        <div className="t-hunk" key={index}>
          {hunk.lines.map((line, at) => {
            const html = painted?.[index]?.[at];
            return (
              <div className={`t-dline is-${line.kind}`} key={at}>
                <span className="t-dnum">{line.number}</span>
                <span className="t-dsign" aria-hidden="true">
                  {SIGNS[line.kind]}
                </span>
                {html === undefined ? (
                  <code className="t-dtext">{line.text}</code>
                ) : (
                  /* Monaco's own output, and the only HTML this pane inserts. It escapes
                     what it renders and emits nothing but `mtk*` spans. */
                  <code className="t-dtext" dangerouslySetInnerHTML={{ __html: html }} />
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** What the agent is doing, above the composer because that is where you are looking
 * while waiting. The elapsed clock is the point: it is what separates slow from hung. */
function ActivityLine({ activity, startedAt }: { activity: Activity; startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());

  // One interval, only while a turn is live. A second clock beside the SDK's own
  // `tool_progress` would be two answers to one question.
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

  /** Commands worth offering for what is typed. Only while the draft is one `/word` with
   * no space — past that these are arguments, and a menu over them is in the way. */
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
