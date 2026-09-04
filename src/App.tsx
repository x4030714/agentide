import { useCallback, useEffect, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

import { openWorkspace, pickFolder } from "./lib/bridge";
import { errorMessage, parentOf } from "./lib/protocol";
import type { FsEvent, WirePath, Workspace } from "./lib/protocol";
import { EditorPane } from "./panes/Editor";
import { FileTree } from "./panes/FileTree";
import { TranscriptPane } from "./panes/Transcript";
import "./App.css";

/** Reopened on launch so the dev reload loop does not mean re-picking a folder. */
const LAST_WORKSPACE_KEY = "agentide.lastWorkspace";

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [activePath, setActivePath] = useState<WirePath | null>(null);
  const [changes, setChanges] = useState<FsEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(async (path: string) => {
    try {
      const opened = await openWorkspace(path, setChanges);
      setWorkspace(opened);
      setActivePath(null);
      setChanges([]);
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
      <ModuleHeader workspace={workspace} error={error} />

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
          <TranscriptPane root={workspace?.root ?? null} />
        </Panel>
        <Separator className="separator vertical" />
        <Panel id="work" defaultSize="49" minSize="22">
          <Group orientation="vertical">
            <Panel id="editor" defaultSize="72" minSize="30">
              <EditorPane path={activePath} changes={changes} />
            </Panel>
            <Separator className="separator horizontal" />
            {/* Phase 3 fills this with xterm.js over a PTY. */}
            <Panel id="terminal" defaultSize="28" minSize="8" collapsible>
              <UnmappedRegion
                legend="Terminal"
                note="region not mapped — the pty attaches in phase 3"
              />
            </Panel>
          </Group>
        </Panel>
      </Group>
    </div>
  );
}

/**
 * The listing's file header: what is loaded, and from where. The workspace folder is
 * the resolved symbol in the path, so it carries the symbol role; its parents do not.
 */
function ModuleHeader({
  workspace,
  error,
}: {
  workspace: Workspace | null;
  error: string | null;
}) {
  const parent = workspace ? parentOf(workspace.root) : null;

  return (
    <header className="module-header">
      <span className="module-name">agentide</span>
      {workspace ? (
        <span className="module-path" title={workspace.root}>
          {parent && <span className="module-parent">{parent}/</span>}
          <span className="module-workspace">{workspace.name}</span>
        </span>
      ) : (
        <span className="note">no module loaded</span>
      )}
      {error && <span className="module-status is-error">{error}</span>}
    </header>
  );
}

/** A pane whose backing service does not exist yet, stated in the listing's own voice. */
function UnmappedRegion({ legend, note }: { legend: string; note: string }) {
  return (
    <div className="pane">
      <div className="pane-header">
        <span className="legend">{legend}</span>
      </div>
      <div className="pane-body">
        <p className="note">{note}</p>
      </div>
    </div>
  );
}
