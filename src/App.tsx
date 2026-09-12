import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { PanelImperativeHandle } from "react-resizable-panels";

import { useAppearance } from "./lib/appearance";
import { agentAuth, openWorkspace, pickFolder } from "./lib/bridge";
import { startBackground } from "./lib/agent-shell";
import type { AgentEdit } from "./lib/transcript";
import { errorMessage } from "./lib/protocol";
import { answerIdeTool, HOST_TOOL_NAMES } from "./lib/ide-host";
import { requestFocus, useKeybindings } from "./lib/keys";
import { usePalette } from "./lib/palette";
import { closeTab, NO_TABS, openTab, selectTab } from "./lib/tabs";
import type { Tabs } from "./lib/tabs";
import { useLayout } from "./lib/layout";
import { useTransparency } from "./lib/transparency";
import { useLsp } from "./lib/useLsp";
import type {
  Account,
  AccountInfo,
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
import { SearchPane } from "./panes/Search";
import { Settings } from "./panes/Settings";
import type { AgentEditTarget } from "./panes/Editor";
import { StatusBar } from "./panes/StatusBar";
import { TitleBar } from "./panes/TitleBar";
import { TerminalPane } from "./panes/Terminal";
import { TranscriptPane } from "./panes/Transcript";
import "./App.css";

/** Reopened on launch so the dev reload loop does not mean re-picking a folder. */
const LAST_WORKSPACE_KEY = "agentide.lastWorkspace";

/** How many recent agent edits the editor is asked to draw. Comfortably more than a turn
 * makes, and small enough that it is a queue rather than a log. */
const EDIT_QUEUE = 50;

/** Survives a restart: the account is the control, so it is also the setting. */
const ACCOUNT_KEY = "agentide.account";
/** The machine's own login. Never sent on the wire -- absent means exactly this. */
const DEFAULT_ACCOUNT = "default";

/** The wire wants the key, or nothing at all for the machine's own login. */
function accountArg(key: string): string | undefined {
  return key === DEFAULT_ACCOUNT ? undefined : key;
}

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [tabs, setTabs] = useState<Tabs>(NO_TABS);
  const activePath = tabs.active;
  const [changes, setChanges] = useState<FsEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [appearance, setAppearance] = useAppearance();
  const [palette, setPalette] = usePalette();
  const [transparency, setTransparency] = useTransparency();
  const [layout, setLayout] = useLayout();
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
  /**
   * Who is signed in, and what the last sign-out said.
   *
   * Held here rather than in Settings because the transcript is where the sidecar's channel
   * lands and Settings is its sibling; and null rather than a guess, so the panel can say it
   * is still asking instead of showing an account that may be gone.
   */
  /**
   * Every change the agent has made, newest last.
   *
   * A list rather than one slot. One instruction is routinely five `Edit` calls, and an
   * edit is only fully drawable in two moments -- its removals before the write lands, its
   * additions after -- so a single slot was always overwritten by the next edit before the
   * second moment arrived. Only the last edit of a turn could ever finish, and if that one
   * happened to be a pure deletion nothing was marked at all.
   *
   * Bounded because it is a display queue, not a history: the editor keys off the nonce and
   * skips what it has already drawn.
   */
  const [agentEdits, setAgentEdits] = useState<AgentEditTarget[]>([]);
  const editNonce = useRef(1);
  const [account, setAccount] = useState<Account | null>(null);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [accountNote, setAccountNote] = useState<string | null>(null);
  /** What the open conversation has cost. In the status bar, where the other facts about
   * the session are. */
  const [usage, setUsage] = useState<{
    cost: number;
    context: { tokens: number; max: number } | null;
  }>({ cost: 0, context: null });
  /**
   * Which account turns run under. Survives a restart, because it is the control and so it
   * is also the setting -- coming back to yesterday's account without being told would be
   * the same surprise in the other direction.
   */
  const [activeAccount, setActiveAccount] = useState<string>(() => {
    try {
      return localStorage.getItem(ACCOUNT_KEY) ?? DEFAULT_ACCOUNT;
    } catch {
      return DEFAULT_ACCOUNT;
    }
  });

  const onAccountRefresh = useCallback(() => {
    // A failure leaves it null, which the panel draws as "asking" -- the sidecar may simply
    // not be listening yet, and the section asks again on its next open.
    void agentAuth("status", accountArg(activeAccount)).catch(() => {});
  }, [activeAccount]);

  const onSignOut = useCallback(() => {
    setAccount(null);
    // The selected account, not the machine's: signing out of the one on screen is the
    // only reading of that button that is not a trap.
    void agentAuth("logout", accountArg(activeAccount)).catch(() =>
      setAccountNote("could not reach the agent host"),
    );
  }, [activeAccount]);

  const onSelectAccount = useCallback((key: string) => {
    setActiveAccount(key);
    try {
      localStorage.setItem(ACCOUNT_KEY, key);
    } catch {
      /* A private window; the choice lasts this session. */
    }
    setAccount(null);
    void agentAuth("status", accountArg(key)).catch(() => {});
  }, []);

  const onSignIn = useCallback(
    (command: string) => {
      // A terminal tab, not a hidden spawn: signing in is a device code to read and a
      // browser to click through, and neither is visible in captured output.
      void startBackground(command, workspace?.root ?? null).catch(() => {
        setAccountNote("could not open a terminal to sign in");
      });
    },
    [workspace],
  );
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

  /**
   * A file the agent just edited: opened, brought to the front, and handed to the editor to
   * scroll to and mark.
   *
   * It used to open *behind* what you were reading, because before tabs it replaced your
   * file and that made a useful feature the fastest way to lose one. Tabs settled that --
   * nothing is lost by showing this, your file is a tab away -- and watching the edit land
   * is the reason the pane is on screen at all.
   */
  const openEdited = useCallback((edit: AgentEdit) => {
    const path = edit.path as WirePath;
    setTabs((previous) => openTab(previous, path));
    // A nonce per edit: the same file edited twice must scroll and mark twice, and object
    // identity alone would also replay on every unrelated re-render.
    const next = { path, hunks: edit.hunks, nonce: editNonce.current++ };
    setAgentEdits((was) => [...was, next].slice(-EDIT_QUEUE));
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
          // Ctrl+Shift+F is find-in-files everywhere else. Monaco keeps Ctrl+F for the
          // open file, which is the other half of the same pair.
          key: "f",
          ctrl: true,
          shift: true,
          whileTyping: true,
          describe: "Search the workspace",
          run: () => {
            // Same order as Ctrl+1: the view has to be on screen before it can take focus.
            flushSync(() => showView("search"));
            requestFocus("search");
          },
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

  /**
   * The rail's views, built once and placed by whichever layout is on.
   *
   * Basic is not a smaller app -- it is the same app with the editor out of the way. An
   * earlier version of it dropped the rail on the grounds that there was nothing left to
   * switch between, which was simply wrong: Explorer, Changes, Git and Local models all live
   * there, and hiding the rail made every one of them unreachable.
   */
  const sidebar = (
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
            <div className="sidebar-view" hidden={view !== "search"}>
              <SearchPane root={workspace?.root ?? null} onOpenAt={openAt} />
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
  );

  /** The editor and the terminal. In Basic they appear only once a file is open. */
  const workColumn = (
          <Group orientation="vertical">
            <Panel id="editor" defaultSize="72" minSize="30">
              <EditorPane
                tabs={tabs.open}
                path={activePath}
                changes={changes}
                reveal={reveal}
                agentEdits={agentEdits}
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
  );

  /**
   * The conversation, built once and placed by whichever layout is on.
   *
   * Lifted out of the tree rather than duplicated: it takes a dozen props, and two copies of
   * that list is two things to keep in step for no reason. It also means switching layout
   * does not remount it -- the same element in a different parent keeps its state, so a
   * running turn survives the switch.
   */
  const transcript = (
          <TranscriptPane
            root={workspace?.root ?? null}
            onTurnStart={onTurnStart}
            onTurnEnd={onTurnEnd}
            resumeConversation={resumed}
            onNewConversation={() => setResumed(null)}
            onAgentEdit={openEdited}
            onToolCall={onToolCall}
            hostTools={HOST_TOOL_NAMES}
            account={accountArg(activeAccount)}
            onUsage={setUsage}
            onAccount={(next, key, list, note) => {
              setAccount(next);
              setAccounts(list);
              // The sidecar decides what is selected, not this state: an account removed
              // from the file must not leave the window pointing at it.
              if (!list.some((entry) => entry.key === key)) setActiveAccount(DEFAULT_ACCOUNT);
              // Only a sign-out carries one; a plain status must not clear the last word
              // about what happened, nor keep it forever.
              setAccountNote(note ?? null);
            }}
          />
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
          layout={layout}
          onLayout={setLayout}
          onImported={(id) => {
            // Set it resumed so the transcript replays it. Opening the Conversations list
            // instead showed a read-only copy of the thing they asked to carry on with.
            setResumed(id);
            setReviewRevision((n) => n + 1);
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
          account={account}
          accountNote={accountNote}
          onAccountRefresh={onAccountRefresh}
          onSignOut={onSignOut}
          onSignIn={onSignIn}
          accounts={accounts}
          activeAccount={activeAccount}
          onSelectAccount={onSelectAccount}
        />
      )}

      {/* Rail, its view, the transcript, the work column. The transcript is a permanent
          column, not a rail view: one you have to summon is one you consult. */}
      {layout === "basic" ? (
        /**
         * The same app, with the editor out of the way until there is something in it.
         *
         * Basic is not a smaller agentide. The rail is here, every view it reaches is here,
         * and the agent has the same tools -- what changes is that the conversation gets the
         * middle of the window instead of a third of it, and the editor does not sit there
         * empty waiting to be used.
         *
         * An earlier version dropped the rail entirely, which made Explorer, Changes, Git
         * and Local models unreachable. A layout is a rearrangement, not a subset.
         */
        <div className="workbench is-basic">
          <ActivityBar
            view={view}
            collapsed={sidebarCollapsed}
            changeCount={changeCount}
            onSelect={selectView}
            onSettings={() => setSettingsOpen(true)}
          />
          <Group orientation="horizontal" className="workbench-panels">
            <Panel
              id="basic-sidebar"
              defaultSize="20"
              minSize="14"
              collapsible
              panelRef={sidebarRef}
              onResize={(size) => setSidebarCollapsed(size.asPercentage <= 0)}
            >
              {sidebar}
            </Panel>
            <Separator className="separator vertical" />
            <Panel id="basic-main" defaultSize={tabs.open.length > 0 ? "45" : "80"} minSize="25">
              <main className="basic-main">{transcript}</main>
            </Panel>
            {/* Only once a file is open. An empty editor beside a conversation is a pane
                asking to be filled, which is the thing this layout is for not doing. */}
            {tabs.open.length > 0 && (
              <>
                <Separator className="separator vertical" />
                <Panel id="basic-work" defaultSize="35" minSize="22">
                  {workColumn}
                </Panel>
              </>
            )}
          </Group>
        </div>
      ) : (
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
            /* Percentages, so these are what an 800px-wide window gets: 16% of it was
               130px, which truncated every filename to eight characters and the header to
               "EX...". The floor matters more than the default -- a column narrower than a
               name is not a narrower column, it is a broken one. */
            defaultSize="19"
            minSize="14"
            collapsible
            panelRef={sidebarRef}
            onResize={(size) => setSidebarCollapsed(size.asPercentage <= 0)}
          >
            {/* All four stay mounted: switching must not drop expanded folders or a diff
                you were reading. Hidden trees stop measuring — see `measure` in FileTree. */}
            {sidebar}
          </Panel>
          <Separator className="separator vertical" />
          {/* The agent leads by reading order, not width. At 45% the editor was ~79
              columns — under rustfmt's max_width of 100, so real files scrolled sideways. */}
          <Panel id="transcript" defaultSize="35" minSize="20" collapsible>
            {transcript}
          </Panel>
          <Separator className="separator vertical" />
          <Panel id="work" defaultSize="49" minSize="22">
              {workColumn}
          </Panel>
        </Group>
      </div>
      )}
      <StatusBar
        root={workspace?.root ?? null}
        changes={changes}
        revision={reviewRevision}
        servers={lsp.servers}
        cost={usage.cost}
        context={usage.context}
      />
    </div>
  );
}

