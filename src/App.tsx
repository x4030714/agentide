import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { PanelImperativeHandle } from "react-resizable-panels";

import { useAppearance } from "./lib/appearance";
import { openWorkspace, pickFolder } from "./lib/bridge";
import { errorMessage } from "./lib/protocol";
import { answerIdeTool, HOST_TOOL_NAMES } from "./lib/ide-host";
import { requestFocus, useKeybindings } from "./lib/keys";
import { usePalette } from "./lib/palette";
import { closeTab, NO_TABS, openTab, selectTab } from "./lib/tabs";
import type { Tabs } from "./lib/tabs";
import { useTransparency } from "./lib/transparency";
import { useLsp } from "./lib/useLsp";
import type {
  Checkpoint,
  FsEvent,
  JsonObject,
  ToolResult,
  WirePath,
  Workspace,
} from "./lib/protocol";
import { ActivityBar } from "./panes/ActivityBar";
import type { SidebarView } from "./panes/ActivityBar";
import { ChangesPane } from "./panes/Changes";
import { EditorPane } from "./panes/Editor";
import type { RevealTarget } from "./panes/Editor";
import { FileTree } from "./panes/FileTree";
import { ConversationsPane } from "./panes/Conversations";
import { GitPane } from "./panes/Git";
import { LocalModelsView } from "./panes/LocalModelsView";
import { QuickOpen } from "./panes/QuickOpen";
import { Settings } from "./panes/Settings";
import { StatusBar } from "./panes/StatusBar";
import { TitleBar } from "./panes/TitleBar";
import { TerminalPane } from "./panes/Terminal";
import { TranscriptPane } from "./panes/Transcript";
import "./App.css";

/** Reopened on launch so the dev reload loop does not mean re-picking a folder. */
const LAST_WORKSPACE_KEY = "agentide.lastWorkspace";

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [tabs, setTabs] = useState<Tabs>(NO_TABS);
  const activePath = tabs.active;
  const [changes, setChanges] = useState<FsEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [appearance, setAppearance] = useAppearance();
  const [palette, setPalette] = usePalette();
  const [transparency, setTransparency] = useTransparency();
  /** The checkpoint the current turn started from, and what the review queue reads against. */
  const [checkpoint, setCheckpoint] = useState<Checkpoint | null>(null);
  const [reviewRevision, setReviewRevision] = useState(0);
  const [changeCount, setChangeCount] = useState(0);
  /** Which view the sidebar shows. The activity bar sets it; nothing else does. */
  const [view, setView] = useState<SidebarView>("explorer");
  /**
   * Whether the sidebar is put away. Mirrored from the panel rather than driving it:
   * dragging the separator collapses it too, and the rail must dim its icon for that as
   * much as for Ctrl+B.
   */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
  /** The sidebar panel, so Ctrl+B and the rail can collapse it through the layout's own API. */
  const sidebarRef = useRef<PanelImperativeHandle>(null);

  /** Show a view, bringing the sidebar back if it was put away. */
  const showView = useCallback((next: SidebarView) => {
    setView(next);
    sidebarRef.current?.expand();
  }, []);

  /**
   * The rail's own click. The active icon puts the sidebar away and brings it back, which
   * is what every editor with an activity bar does; any other icon switches to it.
   */
  const selectView = useCallback(
    (next: SidebarView) => {
      const panel = sidebarRef.current;
      if (next === view && panel && !panel.isCollapsed()) panel.collapse();
      else showView(next);
    },
    [view, showView],
  );

  /** Open a file in a tab, or focus the tab it is already in. */
  const openFile = useCallback((path: WirePath) => {
    setTabs((previous) => openTab(previous, path));
  }, []);

  /**
   * A file the agent has just edited.
   *
   * Opened behind whatever you are reading. The editor following the agent is worth
   * having, and before tabs it could only do that by replacing your file -- which made
   * the useful feature the fastest way to lose your place.
   */
  const openEdited = useCallback((path: WirePath) => {
    setTabs((previous) => openTab(previous, path, true));
  }, []);

  const selectFile = useCallback((path: WirePath) => {
    setTabs((previous) => selectTab(previous, path));
  }, []);

  const closeFile = useCallback((path: WirePath) => {
    setTabs((previous) => closeTab(previous, path));
  }, []);

  /** Go-to-definition landing in another file. The editor is always on screen, so it lands. */
  const openAt = useCallback(
    (path: WirePath, line?: number, column?: number, endLine?: number, endColumn?: number) => {
      setTabs((previous) => openTab(previous, path));
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
      setTabs(NO_TABS);
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
          describe: "Show or hide the sidebar",
          run: () => {
            const panel = sidebarRef.current;
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
          describe: "Show the file tree and focus it",
          run: () => {
            // A hidden view cannot take focus, and both the switch and the expand are
            // state changes -- so they have to land before the request, not after it.
            flushSync(() => showView("explorer"));
            requestFocus("tree");
          },
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
          run: () => requestFocus("editor"),
        },
        {
          key: "Digit4",
          ctrl: true,
          whileTyping: true,
          describe: "Focus the terminal",
          run: () => requestFocus("terminal"),
        },
      ],
      [showView],
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
        transparency={transparency}
        onTransparency={setTransparency}
        onSettings={() => setSettingsOpen(true)}
      />
      {error && <p className="note is-error app-error">{error}</p>}
      {quickOpen && (
        <QuickOpen
          root={workspace?.root ?? null}
          onOpen={openFile}
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
          transparency={transparency}
          onTransparency={setTransparency}
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
       * The frame, left to right: the icon rail, the view it selects, the transcript, and
       * the work column.
       *
       * The transcript is a permanent column and not a view on the rail, which is the one
       * place this parts company with the editor it borrows its shape from. The agent
       * leads and the editor is the surface it acts on; a transcript you have to summon
       * is a transcript you consult, which is the arrangement every agentic editor
       * already ships and the one this build exists to refuse.
       */}
      <div className="workbench">
        <ActivityBar
          view={view}
          collapsed={sidebarCollapsed}
          changeCount={changeCount}
          onSelect={selectView}
          onSettings={() => setSettingsOpen(true)}
        />
        <Group orientation="horizontal" className="workbench-panels">
          <Panel
            id="sidebar"
            defaultSize="16"
            minSize="10"
            collapsible
            panelRef={sidebarRef}
            onResize={(size) => setSidebarCollapsed(size.asPercentage <= 0)}
          >
            {/**
             * All four views stay mounted. Switching must not drop the tree's expanded
             * folders or re-fetch a diff you were halfway through reading -- and the tree
             * stops measuring itself while it is hidden, so a view nobody is looking at
             * costs no rows. See `measure` in FileTree.
             */}
            <div className="sidebar">
              <div className="sidebar-view" hidden={view !== "explorer"}>
                <FileTree
                  root={workspace?.root ?? null}
                  activePath={activePath}
                  changes={changes}
                  onOpenFile={openFile}
                  onOpenFolder={() => void openFolder()}
                />
              </div>
              <div className="sidebar-view" hidden={view !== "changes"}>
                <ChangesPane
                  checkpoint={checkpoint}
                  revision={reviewRevision}
                  onCountChange={setChangeCount}
                />
              </div>
              {/* Distinct from Changes on purpose: that view is the agent's turn waiting
                  on review, this one is the repository's own state. */}
              <div className="sidebar-view" hidden={view !== "git"}>
                <GitPane
                  root={workspace?.root ?? null}
                  changes={changes}
                  revision={reviewRevision}
                  onOpenFile={(path) => openFile(path as WirePath)}
                />
              </div>
              <div className="sidebar-view" hidden={view !== "conversations"}>
                <ConversationsPane
                  root={workspace?.root ?? null}
                  revision={reviewRevision}
                  resumedId={resumed}
                  onResume={setResumed}
                />
              </div>
              {/**
               * Mounted only when it is the view being shown, unlike the four above.
               *
               * The others are cheap and benefit from staying alive -- the tree keeps its
               * scroll, the transcript its history. This one polls a directory once a
               * second to draw its progress bars, and doing that for the whole session
               * because it was opened once is a cost for nothing.
               */}
              {view === "models" && (
                <div className="sidebar-view">
                  <LocalModelsView root={workspace?.root ?? null} />
                </div>
              )}
            </div>
          </Panel>
          <Separator className="separator vertical" />
          {/**
           * The agent leads by reading order, not by out-measuring the editor. An earlier
           * split gave the transcript 45% and left the editor ~79 columns — under
           * rustfmt's default max_width of 100, so real Rust and C++ files scrolled
           * sideways at the shipped default. Reading-order primacy already carries
           * "agent leads"; taking columns off the primary language to restate it does not.
           */}
          <Panel id="transcript" defaultSize="35" minSize="20" collapsible>
            <TranscriptPane
              root={workspace?.root ?? null}
              onTurnStart={onTurnStart}
              onTurnEnd={onTurnEnd}
              resumeConversation={resumed}
              onNewConversation={() => setResumed(null)}
              onAgentEdit={openEdited}
              onToolCall={onToolCall}
              hostTools={HOST_TOOL_NAMES}
            />
          </Panel>
          <Separator className="separator vertical" />
          <Panel id="work" defaultSize="49" minSize="22">
            <Group orientation="vertical">
              <Panel id="editor" defaultSize="72" minSize="30">
                <EditorPane
                  tabs={tabs.open}
                  path={activePath}
                  changes={changes}
                  reveal={reveal}
                  lsp={lsp}
                  onSelect={selectFile}
                  onClose={closeFile}
                />
              </Panel>
              <Separator className="separator horizontal" />
              <Panel id="terminal" defaultSize="28" minSize="8" collapsible>
                <TerminalPane root={workspace?.root ?? null} />
              </Panel>
            </Group>
          </Panel>
        </Group>
      </div>
      <StatusBar
        root={workspace?.root ?? null}
        changes={changes}
        revision={reviewRevision}
        servers={lsp.servers}
      />
    </div>
  );
}

