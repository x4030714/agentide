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
  /** Mirrored from the panel, not driving it: dragging the separator collapses it too,
   * and the rail has to dim its icon for that as much as for Ctrl+B. */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  /** Where the cursor goes next. The nonce is why jumping twice to the same line works:
   * identical props would make the second jump do nothing. */
  const [reveal, setReveal] = useState<RevealTarget | null>(null);
  /** The conversation the next prompt continues, or null for this session's own. Stays
   * set: the sidecar adopts the id, so every later turn continues the same one. */
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

  /** Clicking the active icon hides the sidebar and brings it back; any other switches
   * to it. What every editor with an activity bar does. */
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

  /** A file the agent just edited, opened behind whatever you are reading. Before tabs
   * this replaced your file, which made a useful feature the fastest way to lose it. */
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

  /** The `ide_*` tools live here: this is the only component holding the root, the
   * language servers and the editor at once. The transcript owns the sidecar, not those. */
  const onToolCall = useCallback(
    (name: string, args: JsonObject): Promise<ToolResult> =>
      answerIdeTool(name, args, {
        root: workspace?.root ?? null,
        lsp: lsp.workspace,
        openFile: openAt,
      }),
    [workspace?.root, lsp.workspace, openAt],
  );

  /** The agent's own entry point, exposed for `scripts/smoke.mjs` to drive the LSP tools
   * without spending a turn. No unit test crosses that seam, and the bugs live there. */
  useEffect(() => {
    (window as unknown as { __ideTool?: typeof onToolCall }).__ideTool = onToolCall;
  }, [onToolCall]);

  // `null` when the checkpoint could not be taken. Stored rather than left alone, or the
  // review queue would compare this turn against a point two turns back.
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

  /** The whole keyboard in one table. Chords match what any editor already put in your
   * fingers, and the number row is positional: panes in the order they appear. */
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
            // Set it resumed so the transcript replays it. Opening the Conversations list
            // instead showed a read-only copy of the thing they asked to carry on with.
            setResumed(id);
            setReviewRevision((n) => n + 1);
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {/* Rail, its view, the transcript, the work column. The transcript is a permanent
          column, not a rail view: one you have to summon is one you consult. */}
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
            {/* All four stay mounted: switching must not drop expanded folders or a diff
                you were reading. Hidden trees stop measuring — see `measure` in FileTree. */}
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
              {/* Mounted only while shown, unlike the four above: this one polls a
                  directory every second, and paying that all session is for nothing. */}
              {view === "models" && (
                <div className="sidebar-view">
                  <LocalModelsView root={workspace?.root ?? null} />
                </div>
              )}
            </div>
          </Panel>
          <Separator className="separator vertical" />
          {/* The agent leads by reading order, not width. At 45% the editor was ~79
              columns — under rustfmt's max_width of 100, so real files scrolled sideways. */}
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

