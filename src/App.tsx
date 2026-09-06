import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { PanelImperativeHandle } from "react-resizable-panels";

import { useAppearance } from "./lib/appearance";
import { openWorkspace, pickFolder } from "./lib/bridge";
import { errorMessage } from "./lib/protocol";
import { answerIdeTool, HOST_TOOL_NAMES } from "./lib/ide-host";
import { requestFocus, useKeybindings } from "./lib/keys";
import { usePalette } from "./lib/palette";
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
import { QuickOpen } from "./panes/QuickOpen";
import { Settings } from "./panes/Settings";
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
  const [palette, setPalette] = usePalette();
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
  const [quickOpen, setQuickOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** The tree panel, so Ctrl+B can collapse it through the layout's own API. */
  const treeRef = useRef<PanelImperativeHandle>(null);

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

  /**
   * The same entry point the agent uses, reachable from the debug console.
   *
   * `scripts/smoke.mjs` calls it to exercise the language-server tools without spending
   * a turn. That seam -- our client capabilities, the server's answer shape, the tool's
   * formatting -- is not crossed by any unit test, and it is where this project's bugs
   * keep being found. A hook is a cheap price for covering it.
   */
  useEffect(() => {
    (window as unknown as { __ideTool?: typeof onToolCall }).__ideTool = onToolCall;
  }, [onToolCall]);

  // `null` when the turn is running without one -- a workspace whose checkpoint could not
  // be taken. Stored as null rather than left alone, so the review queue compares against
  // nothing instead of against a point two turns back.
  const onTurnStart = useCallback((next: Checkpoint | null) => {
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

  /**
   * The app's keyboard, in one table.
   *
   * Chords chosen to match what a person coming from any editor already has in their
   * fingers: Ctrl+P for a file, Ctrl+B for the sidebar, Ctrl+` for the terminal. The
   * number row moves focus between the four panes in the order they appear on screen,
   * so the mapping is positional rather than something to memorise.
   */
  useKeybindings(
    useMemo(
      () => [
        {
          key: "p",
          ctrl: true,
          whileTyping: true,
          describe: "Open a file by name",
          run: () => setQuickOpen(true),
        },
        {
          // Ctrl+, is settings in every other editor, so it is settings here.
          key: ",",
          ctrl: true,
          whileTyping: true,
          describe: "Open settings",
          run: () => setSettingsOpen(true),
        },
        {
          key: "b",
          ctrl: true,
          describe: "Show or hide the file tree",
          run: () => {
            const panel = treeRef.current;
            if (!panel) return;
            // Asked of the layout rather than tracked separately: dragging the
            // separator collapses it too, and two sources of truth would disagree.
            if (panel.isCollapsed()) panel.expand();
            else panel.collapse();
          },
        },
        {
          // Ctrl+` is the terminal everywhere else, so it is the terminal here.
          key: "`",
          ctrl: true,
          whileTyping: true,
          describe: "Focus the terminal",
          run: () => requestFocus("terminal"),
        },
        {
          key: "Digit1",
          ctrl: true,
          whileTyping: true,
          describe: "Focus the file tree",
          run: () => requestFocus("tree"),
        },
        {
          key: "Digit2",
          ctrl: true,
          whileTyping: true,
          describe: "Focus the composer",
          run: () => requestFocus("composer"),
        },
        {
          key: "Digit3",
          ctrl: true,
          whileTyping: true,
          describe: "Focus the editor",
          run: () => {
            setTab("editor");
            requestFocus("editor");
          },
        },
        {
          key: "Digit4",
          ctrl: true,
          whileTyping: true,
          describe: "Focus the terminal",
          run: () => requestFocus("terminal"),
        },
      ],
      [],
    ),
  );

  return (
    <div className="app">
      <TitleBar
        workspace={workspace}
        appearance={appearance}
        onAppearance={setAppearance}
        palette={palette}
        onPalette={setPalette}
        onSettings={() => setSettingsOpen(true)}
      />
      {error && <p className="note is-error app-error">{error}</p>}
      {quickOpen && (
        <QuickOpen
          root={workspace?.root ?? null}
          onOpen={(path) => {
            setActivePath(path);
            setTab("editor");
          }}
          onClose={() => setQuickOpen(false)}
        />
      )}
      {settingsOpen && (
        <Settings
          root={workspace?.root ?? null}
          appearance={appearance}
          onAppearance={setAppearance}
          palette={palette}
          onPalette={setPalette}
          onImported={(id) => {
            // The imported conversation belongs in the transcript, which is where it is
            // continued -- setting it as resumed makes that pane replay it. Sending the
            // person to the Conversations list instead showed them a read-only copy of
            // the thing they had just asked to carry on with, which is the wrong half.
            // The list still needs re-reading, because the file is new.
            setResumed(id);
            setReviewRevision((n) => n + 1);
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {/**
       * The agent leads and the editor is the surface it acts on, so the transcript is
       * the widest pane and is read before the editor. A narrow index sits left of it.
       *
       * Putting the agent in a slim right-hand column would be the arrangement every
       * agentic editor already ships, which is the one this build exists to refuse.
       */}
      <Group orientation="horizontal" className="workbench">
        <Panel id="tree" defaultSize="14" minSize="10" collapsible panelRef={treeRef}>
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
            onNewConversation={() => setResumed(null)}
            onAgentEdit={openAt}
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

