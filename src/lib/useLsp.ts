import { useCallback, useEffect, useRef, useState } from "react";

import { LspWorkspace } from "./lsp-monaco";
import type { ServerSpec, SessionState } from "./lsp-session";
import type { WirePath } from "./protocol";

export interface ServerRow {
  spec: ServerSpec;
  state: SessionState;
}

export interface Lsp {
  /** One row per server that has been asked for, in the order they were started. */
  servers: ServerRow[];
  /** Call after writing a file: rust-analyzer's type errors only arrive on save. */
  didSave: (path: WirePath, text: string) => void;
  /** The attached workspace, or `null` when none is. A getter, so a holder neither
   * re-renders on every server state change nor keeps one that has been disposed. */
  workspace: () => LspWorkspace | null;
}

/** Language servers for the open workspace, tied to its lifetime. They start lazily, and
 * shut down on switch: a leaked rust-analyzer holds `cargo` and hundreds of megabytes. */
export function useLsp(
  root: WirePath | null,
  openFile: (path: WirePath, line?: number, column?: number) => void,
): Lsp {
  const [servers, setServers] = useState<ServerRow[]>([]);
  const workspaceRef = useRef<LspWorkspace | null>(null);

  // `openFile` comes from a component; keeping it in a ref means a new identity does not
  // tear down and restart the servers.
  const openFileRef = useRef(openFile);
  useEffect(() => {
    openFileRef.current = openFile;
  }, [openFile]);

  useEffect(() => {
    setServers([]);
    if (!root) {
      workspaceRef.current = null;
      return;
    }
    const workspace = new LspWorkspace(root, {
      onState: (id, spec, state) => {
        setServers((rows) => {
          const next = rows.filter((row) => row.spec.id !== id);
          next.push({ spec, state });
          return next;
        });
      },
      openFile: (path, line, column) => openFileRef.current(path, line, column),
    });
    workspaceRef.current = workspace;
    workspace.start();
    return () => {
      workspaceRef.current = null;
      void workspace.dispose();
    };
  }, [root]);

  const didSave = useCallback((path: WirePath, text: string) => {
    workspaceRef.current?.didSave(path, text);
  }, []);

  const getWorkspace = useCallback(() => workspaceRef.current, []);

  return { servers, didSave, workspace: getWorkspace };
}
