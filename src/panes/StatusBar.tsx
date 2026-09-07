import { useEffect, useState } from "react";

import { gitStatus } from "../lib/bridge";
import { useCursor } from "../lib/cursor";
import type { FsEvent, GitStatus, WirePath } from "../lib/protocol";
import type { ServerRow } from "../lib/useLsp";

/**
 * The bar across the bottom: what branch you are on, what the language servers are doing,
 * and where the caret is.
 *
 * It sits on `--chrome` rather than on VS Code's blue. The blue bar is a strong opinion
 * about which colour owns the bottom of the window, and this palette already has an
 * answer -- `--sym` is the accent, and it is spent on the one thing in view that is
 * active. A field of it under everything would make it mean nothing.
 *
 * Nothing here is a control. A status bar you can click is a toolbar wearing a disguise,
 * and every one of these has a real home: the branch switcher is in the repository view,
 * the server detail is in its tooltip.
 */
interface StatusBarProps {
  root: WirePath | null;
  /** Latest batch from the watcher: a branch switch rewrites files, which is how we hear about it. */
  changes: FsEvent[];
  /** Bumped when a turn ends, the other way the repository moves under us. */
  revision: number;
  servers: ServerRow[];
}

export function StatusBar({ root, changes, revision, servers }: StatusBarProps) {
  const [git, setGit] = useState<GitStatus | null>(null);
  const cursor = useCursor();

  useEffect(() => {
    let cancelled = false;
    if (!root) {
      setGit(null);
      return;
    }
    // Asked rather than cached, like the repository panel: git is cheap and a stale
    // branch name in the corner is worse than no branch name. A failure is silent here
    // -- a folder that is not a repository is the ordinary case, and the panel is where
    // a real git error belongs.
    gitStatus()
      .then((next) => {
        if (!cancelled) setGit(next.isRepo ? next : null);
      })
      .catch(() => {
        if (!cancelled) setGit(null);
      });
    return () => {
      cancelled = true;
    };
  }, [root, changes, revision]);

  const branch = git?.detached ? `detached @ ${git.head ?? "?"}` : (git?.branch ?? null);

  return (
    <div className="status-bar">
      {branch && (
        <span className="status-branch" title={git?.upstream ?? undefined}>
          {branch}
          {git && git.ahead > 0 && ` ↑${git.ahead}`}
          {git && git.behind > 0 && ` ↓${git.behind}`}
        </span>
      )}
      <ServerStatus servers={servers} />
      {cursor && (
        <span className="status-cursor">
          Ln {cursor.line}, Col {cursor.column}
        </span>
      )}
    </div>
  );
}

/**
 * What the language servers are doing.
 *
 * `indexing` is the state this exists for. A server that is running but cannot answer yet
 * is the normal condition for the first minutes on a native codebase, and the alternative
 * to saying so is an editor that appears to have no completions and no explanation. The
 * wording matches `statusNote`, which is what the agent is told at the same moment.
 */
function ServerStatus({ servers }: { servers: ServerRow[] }) {
  if (servers.length === 0) return null;
  return (
    <span className="lsp-status">
      {servers.map(({ spec, state }) => (
        <span
          key={spec.id}
          className={`lsp-server is-${state.status}`}
          title={state.error ?? state.detail ?? `${spec.id} is ${state.status}`}
        >
          <span className="lsp-dot" aria-hidden="true" />
          {spec.id}
          {(state.status === "starting" || state.status === "indexing") && (
            // The server's own progress line when it has one -- "Indexing 42%" says more
            // than the word does, and the word is in the tooltip either way.
            <span className="lsp-detail">{state.detail ?? state.status}</span>
          )}
          {(state.status === "failed" || state.status === "exited") && (
            <span className="lsp-detail">{state.status}</span>
          )}
        </span>
      ))}
    </span>
  );
}
