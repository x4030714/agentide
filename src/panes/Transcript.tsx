import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useFocusTarget } from "../lib/keys";

import { useResolvedAppearance } from "../lib/appearance";
import {
  agentInterrupt,
  checkpointCreate,
  agentPermissionReply,
  agentPrompt,
  agentStart,
  agentWarm,
  agentStop,
  agentToolReply,
  conversationRead,
  memoryVault,
  readFile,
  readFileBase64,
  signedIn,
} from "../lib/bridge";
import { startBackground } from "../lib/agent-shell";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { attachmentLabel, fromPath, toAttachment } from "../lib/attachments";
import { CHUNK, chunk, grow, keepPlace, nearTop } from "../lib/row-chunks";
import { ownedCommand } from "../lib/terminal-commands";
import { locateHunks, summarize, toolDiff } from "../lib/diff";
import type { DiffHunk, LineKind } from "../lib/diff";
import { languageForPath } from "../lib/lsp-monaco";
import { monaco, themeFor } from "../lib/monaco-setup";
import { errorMessage } from "../lib/protocol";
import { isEditMode, modeOptions } from "../lib/editmode";
import type { EditMode } from "../lib/editmode";
import { isAdvanced, isPromptMode, readPromptAppend, readTunedPrompt } from "../lib/promptmode";
import type { PromptMode } from "../lib/promptmode";
import type {
  Account,
  AccountInfo,
  AgentEvent,
  Attachment,
  Checkpoint,
  EffortLevel,
  JsonObject,
  SlashCommand,
  ToolResult,
  WirePath,
} from "../lib/protocol";
import {
  agentRuns,
  editedChange,
  formatTokens,
  initialState,
  liveActivity,
  mainRows,
  sessionCost,
  reduce,
} from "../lib/transcript";
import { Markdown } from "./Markdown";
import { decodeModel } from "../lib/model-menu";
import { mergeProviders, settleProviders, usePendingProviders } from "../lib/pending-providers";
import { ensureProvider } from "../lib/provider";
import { RunControls } from "./RunControls";
import type { Activity, AgentEdit, AgentRun, Row } from "../lib/transcript";

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
  /** The agent is about to change this file, so show it -- and the change itself, so the
   * editor can scroll to it and mark it. Watching an edit land is the reason to have an
   * editor here at all; the watcher already handles reloading. */
  onAgentEdit: (edit: AgentEdit) => void;
  /** The names `onToolCall` will answer. Anything else is answered by the Rust core. */
  hostTools: readonly string[];
  /** A past conversation to continue, from the Conversations panel. Sent every prompt:
   * the sidecar adopts it, and dropping it after turn one would branch silently. */
  resumeConversation: string | null;
  /** A new conversation was started. The parent clears what it was resuming — this pane
   * owns the transcript, the parent owns which conversation it continues. */
  onNewConversation: () => void;
  /** Who is signed in, whenever the sidecar says. Passed up because the account belongs to
   * the window rather than to this conversation; this pane is only where the channel lands. */
  onAccount: (account: Account, key: string, accounts: AccountInfo[], note?: string) => void;
  /** Which Claude account turns run under, or undefined for the machine's own login. */
  account: string | undefined;
  /** What this conversation has cost and how much of the window it fills, whenever either
   * changes. The status bar shows them: they are about the session, and this pane is only
   * where the results land. */
  onUsage: (usage: { cost: number; context: { tokens: number; max: number } | null }) => void;
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
  onAccount,
  onUsage,
  account,
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
  /** Attached to the next prompt and cleared with it: an attachment belongs to the message
   * it was collected for, not to the session. */
  const [attachments, setAttachments] = useState<Attachment[]>([]);
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
  /**
   * How many rows from the tail are drawn.
   *
   * A long conversation used to render every row on every keystroke -- the composer's draft
   * lives in this component, so typing re-created and diffed the whole list. Rows are
   * memoised, so nothing re-rendered, but element creation alone is linear in the length of
   * the conversation and that is what made typing lag.
   */
  const [shown, setShown] = useState(CHUNK);
  /** Scroll height before a growth, so the rows under the reader can be held in place. */
  const growingFrom = useRef<number | null>(null);
  /** Which `session|workspace` has been warmed, so a turn's status changes do not re-warm. */
  const warmed = useRef<string | null>(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // The sidecar is started once, on mount; both of these are read from a ref so a new
  // callback identity from the parent does not restart it.
  const toolCallRef = useRef(onToolCall);
  const hostToolsRef = useRef(hostTools);
  const onAgentEditRef = useRef(onAgentEdit);
  const onAccountRef = useRef(onAccount);
  /** The memory vault, once Rust resolves it. A ref, not state: the handler is installed
   * on mount and must not be rebuilt when this lands. */
  const vaultRef = useRef<string | null>(null);
  /** The open workspace, for resolving the relative paths the model writes. */
  const rootRef = useRef<WirePath | null>(null);
  rootRef.current = root;

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
      .then((records) => {
        if (!cancelled) {
          dispatch({
            t: "conversation_loaded",
            id: resumeConversation,
            records,
            cwd: rootRef.current,
          });
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
    onAccountRef.current = onAccount;
  }, [onToolCall, hostTools, onAgentEdit, onAccount]);

  useEffect(() => {
    let cancelled = false;
    const onEvent = (event: AgentEvent) => {
      if (cancelled) return;
      dispatch(event);
      if (event.t === "event") {
        const edited = editedChange(event.msg, vaultRef.current ?? undefined, rootRef.current);
        if (edited) onAgentEditRef.current(edited);
      }
      if (event.t === "done" || event.t === "exited") onTurnEnd();
      // Up to App, which owns the Settings overlay: the account belongs to the window, not
      // to this conversation, and this pane is only where the sidecar's channel lands.
      if (event.t === "account") {
        onAccountRef.current(event.account, event.key, event.accounts, event.note);
      }
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

  // Build the query before anything is typed. The command and model lists live on a live
  // `Query`, so without this `/` offers nothing and the picker is empty until a turn has
  // been spent -- which is exactly when nobody needs the menu any more. Re-run on the
  // workspace, because that is what the query is built against.
  useEffect(() => {
    // Not before the sidecar is listening. `agentStart` resolves asynchronously, and an
    // earlier version fired this on mount: the message reached a router with no agent
    // behind it, errored, and the catch swallowed it -- so `/` stayed empty and nothing
    // said why. `ready` is the first moment there is something to warm.
    if (!root || state.status === "idle" || state.status === "starting") return;
    const key = `${sessionId}|${root}`;
    if (warmed.current === key) return;
    warmed.current = key;
    void agentWarm(sessionId).catch((err) => {
      // Reported rather than swallowed. A menu that never fills is the failure this whole
      // path exists to prevent, and a silent catch is how it hid the first time.
      warmed.current = null;
      dispatch({ t: "local_notice", tone: "warn", text: `could not prepare: ${errorMessage(err)}` });
    });
  }, [root, sessionId, state.status]);

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

  /**
   * Follow the tail, unless the reader has scrolled away from it.
   *
   * Watching the DOM rather than the state, because `rows` is only one of the things that
   * make this taller. The answer streams in as text with no new row for the whole time it is
   * being written, the activity line's clock ticks every second, and markdown and code
   * blocks settle after they mount -- so keying on `rows` followed a finished message and
   * sat still through one in progress, which is exactly when you want it to move.
   *
   * A mutation observer needs no list of what to watch and cannot fall behind a new kind of
   * content. `pinned` is what makes it polite: it is false the moment the reader scrolls up,
   * so this never fights them, and loading older rows above happens with it false too.
   */
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const stick = () => {
      if (pinned.current) body.scrollTop = body.scrollHeight;
    };
    stick();
    const observer = new MutationObserver(stick);
    observer.observe(body, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  // A growth prepends rows, which pushes everything down by exactly the height it added.
  // Layout effect, not effect: corrected before the browser paints, or the transcript is
  // seen to jump.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const before = growingFrom.current;
    if (!body || before === null) return;
    growingFrom.current = null;
    body.scrollTop = keepPlace(body.scrollTop, before, body.scrollHeight);
  }, [shown]);

  // A different conversation starts at the tail again. Without this, replaying a short one
  // after a long one would draw it with a thousand rows' worth of `shown` still set.
  useEffect(() => {
    setShown(CHUNK);
  }, [sessionId, resumeConversation]);

  const onScroll = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    pinned.current = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
    // Reading upward past the top of what is drawn asks for the next chunk. Recorded here
    // rather than in the effect, because the height has to be the one from *before* React
    // prepends anything.
    if (nearTop(body.scrollTop, body.clientHeight) && growingFrom.current === null) {
      setShown((was) => {
        if (was >= rowsRef.current) return was;
        growingFrom.current = body.scrollHeight;
        return grow(was, rowsRef.current);
      });
    }
  }, []);

  /**
   * The delegated runs, and the rows the transcript itself draws.
   *
   * Memoised on `rows` because both walk the whole conversation, and the reducer hands back
   * a fresh `rows` for every event -- including a progress tick, which arrives every second
   * for every running tool.
   */
  const runs = useMemo(() => agentRuns(state), [state.rows]);
  const flow = useMemo(() => mainRows(state), [state.rows]);
  const runsById = useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs]);
  const active = runs.filter((run) => run.status === "running");

  /** The row count, for `onScroll` -- which is installed once and must not close over it. */
  const rowsRef = useRef(0);
  rowsRef.current = flow.length;

  const running = state.status === "running";
  // Derived on every render rather than memoised: it reads two fields and returns a small
  // object, and the render it feeds is already happening because a row arrived.
  const live: Activity | null = liveActivity(state);

  // Reported rather than derived by the parent: the running total needs the whole result
  // history to be counted correctly, and that lives in this reducer.
  const cost = sessionCost(state);
  const context = state.context;
  useEffect(() => {
    onUsage({ cost, context });
  }, [cost, context, onUsage]);

  const submit = useCallback(() => {
    const text = draft.trim();
    // An attachment on its own is a prompt: the image is the message, and refusing to send
    // it because the box is empty would be the app disagreeing with what it can see.
    if ((!text && attachments.length === 0) || running || state.status === "exited") return;

    /**
     * A command this window already does.
     *
     * Everything else goes to the CLI as prompt text -- it answers its own commands there,
     * for no tokens. These few would answer *and* change state the window is showing, so the
     * two would then disagree about the conversation.
     */
    const typed = /^\/([a-z0-9-]+)\s*$/i.exec(text);
    const owned = typed ? ownedCommand(typed[1].toLowerCase()) : null;
    if (typed && owned) {
      setDraft("");
      dispatch({
        t: "local_notice",
        tone: "info",
        text: `/${typed[1].toLowerCase()} is agentide's to do — ${owned}.`,
      });
      return;
    }
    const sending = attachments;
    setDraft("");
    setAttachments([]);
    pinned.current = true;
    dispatch({
      t: "prompt_submitted",
      text,
      sent: sending.map((attachment) => ({
        kind: attachment.kind,
        label: attachmentLabel(attachment),
      })),
    });

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
        await agentPrompt(
          sessionId,
          text,
          {
          ...modeOptions(mode),
          ...(chosen.model ? { model: chosen.model } : {}),
          ...(chosen.provider ? { provider: chosen.provider } : {}),
          ...(effort ? { effort } : {}),
          ...(append ? { systemPromptAppend: append } : {}),
          // One field; the sidecar owns what it means. A subagent's prompt is content and
          // stays with the code that versions it, so none of it crosses the wire.
          ...(isAdvanced(promptMode) ? { promptProfile: "advanced" as const } : {}),
          // Which login this turn runs under. Absent is the machine's own, which is what
          // the CLI would have used anyway.
          ...(account ? { account } : {}),
          // The answer is drawn as it arrives rather than when it is finished; see
          // `streaming` in `transcript.ts` for why that cannot change what is drawn.
            includePartialMessages: true,
            ...(resumeConversation ? { resumeConversation } : {}),
          },
          sending,
        );
      } catch (err) {
        dispatch({ t: "exited", code: null, message: errorMessage(err), pending: [] });
      }
    })();
  }, [draft, running, state.status, state.providers, sessionId, model, effort, mode, promptMode, root, resumeConversation, onTurnStart, account, attachments]);

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
   * Open a run from the list of active agents: expand it and go to it.
   *
   * Opened rather than toggled. The list is how you get *into* a conversation, and a chip
   * that closes the thing you are reading when you click it again to check the name is a
   * control that punishes you for using it. The row's own header still closes it.
   *
   * Unpinning first, because the tail follows new rows and a subagent produces them the
   * whole time you are reading -- scrolled to a run, the observer would drag you back down
   * within the second.
   */
  const openRun = useCallback((addr: number) => {
    setExpanded((current) => (current.has(addr) ? current : new Set(current).add(addr)));
    pinned.current = false;
    // After the expand has painted, or this measures the collapsed row's position.
    requestAnimationFrame(() => {
      const find = () => bodyRef.current?.querySelector(`[data-addr="${addr}"]`);
      const at = find();
      if (at) {
        at.scrollIntoView({ block: "center" });
        return;
      }
      // The row is older than the drawn window. Draw the whole conversation and try again:
      // this is a deliberate jump, and a chip that does nothing when clicked is worse than
      // a long render.
      setShown(rowsRef.current);
      requestAnimationFrame(() => find()?.scrollIntoView({ block: "center" }));
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
  const drawn = chunk(flow.length, shown);
  const loadMore = useCallback(() => {
    const body = bodyRef.current;
    if (body) growingFrom.current = body.scrollHeight;
    setShown((was) => grow(was, rowsRef.current));
  }, []);

  return (
    <div className={`pane transcript${state.rows.length === 0 ? " is-empty" : ""}`}>
      <div className="pane-header">
        <span className="legend">Transcript</span>
{/* What the next turn runs on. The live status is not here -- it is in the
            transcript, under what you sent, where the answer is about to appear. */}
        {state.meta.model && <span className="measure">{state.meta.model}</span>}
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
        {drawn.hidden > 0 && (
          <button type="button" className="note earlier" onClick={loadMore}>
            {drawn.hidden} earlier {drawn.hidden === 1 ? "row" : "rows"} — scroll up or click to load
          </button>
        )}
        {flow.slice(drawn.start).map((row, offset) => {
          // The absolute index, because `opensTurn` compares against the row before this
          // one in the *conversation*, which may not be drawn.
          const index = drawn.start + offset;
          const run = row.kind === "tool" && row.cls === "agent" ? runsById.get(row.id) : undefined;
          return (
            <TranscriptRow
              key={row.addr}
              row={row}
              // A turn's first row opens a new block, the way a listing fences a function.
              opensTurn={index > 0 && row.turn !== flow[index - 1].turn}
              expanded={expanded.has(row.addr)}
              run={run}
              /* Only the rows that nest a conversation get the whole set. `expanded` is a
                 new Set on every toggle, so handing it to every row would re-render the
                 conversation each time one opens -- which is the cost the boolean avoids. */
              expandedRows={run ? expanded : undefined}
              onToggle={toggle}
              onAnswer={answer}
            />
          );
        })}
        {/* The answer as it arrives, replaced by a real row when the message lands. Not
            a `Row` — nothing provisional goes into the structure everything indexes by. */}
        {state.streaming !== null && state.streaming !== "" && (
          <div className="row is-text is-streaming">
            <div className="t-text">
              <Markdown source={state.streaming} />
            </div>
          </div>
        )}
        {/**
         * What the agent is doing, at the end of the conversation rather than in the chrome.
         *
         * Directly under the prompt the moment you send one, and it stays at the foot of the
         * transcript as rows arrive -- which is where you are already looking, and where the
         * answer is about to land. The two places it used to live were both wrong: the header
         * is chrome you are not watching, and a band above the composer moved the composer
         * every time a turn began.
         *
         * Not a `Row`: it takes no address, and a transient state must never consume one.
         */}
        {/* Who else is working, and a way into what they are doing. Above the activity line
            and below the rows, because it is the same kind of thing the activity line is --
            what is happening now -- and it must sit where you are already looking. */}
        {active.length > 0 && <AgentList runs={active} onOpen={openRun} />}
        {live && <ActivityLine activity={live} startedAt={state.turnStartedAt} />}
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

      {/* One block, because it is one thing: what the next turn will be, and the place you
          say it. Three unrelated strips stacked above a box is how it read before. */}
      <div className="composer-dock">
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


      <Composer
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        disabled={!root || state.status === "exited"}
        running={running}
        commands={state.commands}
        attachments={attachments}
        onAttach={(attachment) => setAttachments((was) => [...was, attachment])}
        onDetach={(index) => setAttachments((was) => was.filter((_, at) => at !== index))}
        onAttachError={(text) => dispatch({ t: "local_notice", tone: "warn", text })}
      />
      </div>
    </div>
  );
}

/** Memoised, and not as a micro-optimisation: the reducer returns a fresh `rows` on every
 * event, so unmemoised this is quadratic in the length of the run. */
const TranscriptRow = memo(function TranscriptRow({
  row,
  opensTurn,
  expanded,
  run,
  expandedRows,
  onToggle,
  onAnswer,
}: {
  row: Row;
  opensTurn: boolean;
  expanded: boolean;
  /** The delegated run this row started, when it is a `Task` call. Its rows are drawn
   * inside it, so a subagent's work reads as one conversation instead of as noise in this
   * one. */
  run?: AgentRun;
  /** Which addresses are open, for the rows nested inside a run. Only passed to a row that
   * has one; see the call site. */
  expandedRows?: Set<number>;
  onToggle: (addr: number) => void;
  onAnswer: (id: string, decision: "allow" | "deny") => void;
}) {
  const addr = <span className="t-addr" />;
  const cls = ["t-row", `is-${row.kind}`, opensTurn ? "opens-turn" : ""]
    .filter(Boolean)
    .join(" ");

  switch (row.kind) {
    case "prompt":
      return (
        <div className={cls}>
          {addr}
          <span className="t-prompt">
            {row.text}
            {row.sent && (
              <span className="t-sent">
                {row.sent.map((item, index) => (
                  <span key={`${item.label}-${index}`} className="t-sent-item">
                    {item.kind === "image" ? "▣" : "▤"} {item.label}
                  </span>
                ))}
              </span>
            )}
          </span>
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
          run={run}
          expandedRows={expandedRows}
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
  run,
  expandedRows,
  onToggle,
  onAnswer,
}: {
  row: Row & { kind: "tool" };
  className: string;
  expanded: boolean;
  run?: AgentRun;
  expandedRows?: Set<number>;
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
  // denied and there is no result at all. A delegated run is worth opening from its first
  // row, while it is still being written -- that is the whole point of the nesting.
  const nested = run !== undefined && run.rows.length > 0;
  const canExpand = row.detail !== undefined || diff !== null || nested;

  return (
    <>
      <div className={className} data-addr={row.addr}>
        <span className="t-addr" />
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
          {/* Three grid children exactly -- op, operand, measure. The agent's name and its
              row count go *inside* the operand rather than beside it: a fourth child lands
              in an implicit column and takes the measure with it. */}
          <span className="t-op">{row.name}</span>
          <span className="t-operand">
            {/* Which agent, ahead of what it was asked: the name decides whether you want to
                read the run, the description is only what it was given. */}
            {row.agent && <span className="t-agent">{row.agent}</span>}
            {row.operand}
            {nested && <span className="t-nested">{run!.rows.length} rows</span>}
          </span>
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
      {/* The subagent's own conversation, indented under the call that started it. Above the
          result, because the result is its last word and reads as the end of it. */}
      {expanded && nested && (
        <div className="t-run">
          {run!.rows.map((child) => (
            <TranscriptRow
              key={child.addr}
              row={child}
              opensTurn={false}
              expanded={expandedRows?.has(child.addr) ?? false}
              onToggle={onToggle}
              onAnswer={onAnswer}
            />
          ))}
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

/**
 * Who else is working, while they are working.
 *
 * Only the running ones. A finished run is still in the transcript under the call that
 * started it, and a list that accumulates every agent of the session stops being the
 * answer to "what is happening now" by the third one.
 *
 * Each chip opens the run rather than toggling it -- see `openRun`.
 */
function AgentList({ runs, onOpen }: { runs: AgentRun[]; onOpen: (addr: number) => void }) {
  return (
    <div className="t-agents">
      {runs.map((run) => (
        <button
          key={run.id}
          type="button"
          className="t-agent-chip"
          title={`${run.task} — click to read what it is doing`}
          onClick={() => onOpen(run.addr)}
        >
          <span className="t-agent-mark" aria-hidden="true" />
          <span className="t-agent-name">{run.name}</span>
          {run.activity && (
            <span className="t-agent-doing">
              {run.activity.verb}
              {run.activity.detail ? ` ${run.activity.detail}` : ""}
            </span>
          )}
          <span className="t-agent-rows">{run.rows.length}</span>
        </button>
      ))}
    </div>
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
  attachments,
  onAttach,
  onDetach,
  onAttachError,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  running: boolean;
  /** What this installation accepts, as the SDK reported it. */
  commands: SlashCommand[];
  /** Waiting to be sent with the next prompt. */
  attachments: Attachment[];
  onAttach: (attachment: Attachment) => void;
  onDetach: (index: number) => void;
  onAttachError: (message: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [highlight, setHighlight] = useState(0);
  const [over, setOver] = useState(false);

  /** Take what was pasted. The clipboard gives a `File` with bytes and no path. */
  const take = useCallback(
    (files: FileList | File[]) => {
      for (const file of Array.from(files)) {
        void toAttachment(file, () => null).then((result) => {
          if ("error" in result) onAttachError(result.error);
          else onAttach(result);
        });
      }
    },
    [onAttach, onAttachError],
  );

  /**
   * Take what was dropped, through Tauri rather than through the DOM.
   *
   * `dragDropEnabled` defaults to true, which means the OS handles the drop and the webview
   * never sees `dragover` or `drop` at all -- the HTML handlers this used to have could not
   * fire. Tauri's event is also the only one that carries a real path, which is what makes a
   * non-image attachable in the first place.
   */
  useEffect(() => {
    if (disabled) return;
    let stop: (() => void) | undefined;
    let gone = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over") setOver(true);
        else if (event.payload.type === "leave") setOver(false);
        else if (event.payload.type === "drop") {
          setOver(false);
          for (const path of event.payload.paths) {
            void fromPath(path, readFileBase64).then((result) => {
              if ("error" in result) onAttachError(result.error);
              else onAttach(result);
            });
          }
        }
      })
      .then((unlisten) => {
        if (gone) unlisten();
        else stop = unlisten;
      });
    return () => {
      gone = true;
      stop?.();
    };
  }, [disabled, onAttach, onAttachError]);

  // Ctrl+2 lands here: the composer is what the transcript column is *for*, and focusing
  // the scrollback instead would put the cursor nowhere useful.
  // Ctrl+2 lands here: the composer is what the transcript column is *for*, and focusing
  // the scrollback instead would put the cursor nowhere useful.
  useFocusTarget("composer", () => ref.current?.focus());

  /** Commands worth offering for what is typed. Only while the draft is one `/word` with
   * no space — past that these are arguments, and a menu over them is in the way. */
  const matches = useMemo(() => {
    const typed = /^\/(\S*)$/.exec(value);
    if (!typed) return [];
    const query = typed[1].toLowerCase();
    // Every match, not a first few: the menu scrolls, and a list that silently stopped at
    // eight read as the installation having eight commands.
    return commands.filter(
      (command) =>
        command.name.toLowerCase().startsWith(query) ||
        command.aliases?.some((alias) => alias.toLowerCase().startsWith(query)),
    );
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
    <div className={`composer${over ? " is-over" : ""}`}>
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((attachment, index) => (
            <button
              key={`${attachmentLabel(attachment)}-${index}`}
              type="button"
              className="chip attachment"
              title={attachment.kind === "file" ? attachment.path : "Remove"}
              onClick={() => onDetach(index)}
            >
              {attachment.kind === "image" ? "▣" : "▤"} {attachmentLabel(attachment)}
              <span className="attachment-remove">×</span>
            </button>
          ))}
        </div>
      )}
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
              {/* Said before you pick it, not after it quietly disagrees with the window. */}
              {ownedCommand(command.name) && (
                <span className="command-where">agentide</span>
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
        onPaste={(event) => {
          // Only when something was actually attached: a paste of ordinary text has files
          // of length zero and must still reach the textarea.
          const files = event.clipboardData?.files;
          if (!files || files.length === 0) return;
          event.preventDefault();
          take(files);
        }}
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
