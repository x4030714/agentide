import { useCallback, useEffect, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

import { useAppearance } from "./lib/appearance";
import { openWorkspace, pickFolder } from "./lib/bridge";
import { errorMessage } from "./lib/protocol";
import { answerIdeTool, HOST_TOOL_NAMES } from "./lib/ide-host";
import { useLsp } from "./lib/useLsp";
import type {
  Checkpoint,
  FsEvent,
  JsonObject,
  ToolResult,
  WirePath,
  Workspace,
} from "./lib/protocol";
import { ChangesPane } from "./panes/Changes";
import { EditorPane } from "./panes/Editor";
import type { RevealTarget } from "./panes/Editor";
import { FileTree } from "./panes/FileTree";
import { ConversationsPane } from "./panes/Conversations";
import { GitPane } from "./panes/Git";
import { TitleBar } from "./panes/TitleBar";
import { TerminalPane } from "./panes/Terminal";
import { TranscriptPane } from "./panes/Transcript";
import "./App.css";

/** Reopened on launch so the dev reload loop does not mean re-picking a folder. */
const LAST_WORKSPACE_KEY = "agentide.lastWorkspace";

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [activePath, setActivePath] = useState<WirePath | null>(null);
  const [changes, setChanges] = useState<FsEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [appearance, setAppearance] = useAppearance();
  /** The checkpoint the current turn started from, and what the review queue reads against. */
  const [checkpoint, setCheckpoint] = useState<Checkpoint | null>(null);
  const [reviewRevision, setReviewRevision] = useState(0);
  const [changeCount, setChangeCount] = useState(0);
  const [tab, setTab] = useState<"editor" | "changes" | "git" | "conversations">("editor");
  /**
   * Where the editor should put the cursor next. Carries a nonce because jumping twice to
   * the same line is a real thing to ask for -- go to definition, scroll away, go again --
   * and identical props would make the second one do nothing.
   */
  const [reveal, setReveal] = useState<RevealTarget | null>(null);
  /**
   * The past conversation the next prompt continues, or null for this session's own.
   * Stays set once chosen: the sidecar adopts the id, so every following turn continues
   * the same conversation, and a marker that cleared itself would say otherwise.
   */
  const [resumed, setResumed] = useState<string | null>(null);

  /**
   * Go-to-definition landing in another file. The tab switch is part of the answer: a
   * jump that silently changes the editor behind the Changes tab looks like nothing
   * happened.
   */
  const openAt = useCallback(
    (path: WirePath, line?: number, column?: number, endLine?: number, endColumn?: number) => {
      setActivePath(path);
      setTab("editor");
      setReveal((previous) => ({
        path,
        line,
        column,
        endLine,
        endColumn,
        nonce: (previous?.nonce ?? 0) + 1,
      }));
    },
    [],
  );

  const lsp = useLsp(workspace?.root ?? null, openAt);

  /**
   * The `ide_*` tools, answered here because this is the only component that holds all
   * the pieces at once: the workspace root, the language servers and the ability to move
   * the editor. The transcript owns the sidecar but knows none of that.
   */
  const onToolCall = useCallback(
    (name: string, args: JsonObject): Promise<ToolResult> =>
      answerIdeTool(name, args, {
        root: workspace?.root ?? null,
        lsp: lsp.workspace,
        openFile: openAt,
      }),
    [workspace?.root, lsp.workspace, openAt],
  );

  const onTurnStart = useCallback((next: Checkpoint) => {
    setCheckpoint(next);
    setChangeCount(0);
  }, []);

  // A finished turn is the moment the queue becomes worth reading.
  const onTurnEnd = useCallback(() => setReviewRevision((n) => n + 1), []);

  const open = useCallback(async (path: string) => {
    try {
      const opened = await openWorkspace(path, setChanges);
      setWorkspace(opened);
      setActivePath(null);
      setChanges([]);
      // Conversations are per-workspace, so the one being continued cannot survive a move.
      setResumed(null);
      setError(null);
      localStorage.setItem(LAST_WORKSPACE_KEY, opened.root);
    } catch (err) {
      setError(errorMessage(err));
      localStorage.removeItem(LAST_WORKSPACE_KEY);
    }
  }, []);

  useEffect(() => {
    const last = localStorage.getItem(LAST_WORKSPACE_KEY);
    if (last) void open(last);
  }, [open]);

  const openFolder = useCallback(async () => {
    const picked = await pickFolder();
    if (picked) await open(picked);
  }, [open]);

  return (
    <div className="app">
      <TitleBar
        workspace={workspace}
        appearance={appearance}
        onAppearance={setAppearance}
      />
      {error && <p className="note is-error app-error">{error}</p>}

      {/**
       * The agent leads and the editor is the surface it acts on, so the transcript is
       * the widest pane and is read before the editor. A narrow index sits left of it.
       *
       * Putting the agent in a slim right-hand column would be the arrangement every
       * agentic editor already ships, which is the one this build exists to refuse.
       */}
      <Group orientation="horizontal" className="workbench">
        <Panel id="tree" defaultSize="14" minSize="10" collapsible>
          <FileTree
            root={workspace?.root ?? null}
            activePath={activePath}
            changes={changes}
            onOpenFile={setActivePath}
            onOpenFolder={() => void openFolder()}
          />
        </Panel>
        <Separator className="separator vertical" />
        {/**
         * The agent leads by reading order, not by out-measuring the editor. An earlier
         * split gave the transcript 45% and left the editor ~79 columns — under
         * rustfmt's default max_width of 100, so real Rust and C++ files scrolled
         * sideways at the shipped default. Reading-order primacy already carries
         * "agent leads"; taking columns off the primary language to restate it does not.
         */}
        <Panel id="transcript" defaultSize="37" minSize="20" collapsible>
          <TranscriptPane
            root={workspace?.root ?? null}
            onTurnStart={onTurnStart}
            onTurnEnd={onTurnEnd}
            resumeConversation={resumed}
            onToolCall={onToolCall}
            hostTools={HOST_TOOL_NAMES}
          />
        </Panel>
        <Separator className="separator vertical" />
        <Panel id="work" defaultSize="49" minSize="22">
          <Group orientation="vertical">
            <Panel id="editor" defaultSize="72" minSize="30">
              {/**
               * One column, two jobs: the file you are reading and the changes waiting
               * on you. Tabbed rather than split, because reviewing a diff and editing
               * the same file at once is a thing nobody does.
               */}
              <div className="tabbed">
                <div className="tabs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "editor"}
                    className={`tab${tab === "editor" ? " is-on" : ""}`}
                    onClick={() => setTab("editor")}
                  >
                    Editor
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "changes"}
                    className={`tab${tab === "changes" ? " is-on" : ""}`}
                    onClick={() => setTab("changes")}
                  >
                    Changes
                    {changeCount > 0 && <span className="tab-count">{changeCount}</span>}
                  </button>
                  {/* Distinct from Changes on purpose: that tab is the agent's turn
                      waiting on review, this one is the repository's own state. */}
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "git"}
                    className={`tab${tab === "git" ? " is-on" : ""}`}
                    onClick={() => setTab("git")}
                  >
                    Repository
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === "conversations"}
                    className={`tab${tab === "conversations" ? " is-on" : ""}`}
                    onClick={() => setTab("conversations")}
                  >
                    Conversations
                  </button>
                </div>
                <div className="tab-body">
                  {/* Both stay mounted: switching tabs must not drop the editor's
                      undo stack or re-fetch a diff you were halfway through reading. */}
                  <div className="tab-panel" hidden={tab !== "editor"}>
                    <EditorPane
                      path={activePath}
                      changes={changes}
                      reveal={reveal}
                      lsp={lsp}
                    />
                  </div>
                  <div className="tab-panel" hidden={tab !== "changes"}>
                    <ChangesPane
                      checkpoint={checkpoint}
                      revision={reviewRevision}
                      onCountChange={setChangeCount}
                    />
                  </div>
                  <div className="tab-panel" hidden={tab !== "conversations"}>
                    <ConversationsPane
                      root={workspace?.root ?? null}
                      revision={reviewRevision}
                      resumedId={resumed}
                      onResume={setResumed}
                    />
                  </div>
                  <div className="tab-panel" hidden={tab !== "git"}>
                    <GitPane
                      root={workspace?.root ?? null}
                      changes={changes}
                      revision={reviewRevision}
                      onOpenFile={(path) => {
                        setActivePath(path as WirePath);
                        setTab("editor");
                      }}
                    />
                  </div>
                </div>
              </div>
            </Panel>
            <Separator className="separator horizontal" />
            <Panel id="terminal" defaultSize="28" minSize="8" collapsible>
              <TerminalPane root={workspace?.root ?? null} />
            </Panel>
          </Group>
        </Panel>
      </Group>
    </div>
  );
}

