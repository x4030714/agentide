import { useEffect, useState } from "react";

import { gitStatus } from "../lib/bridge";
import { useCursor } from "../lib/cursor";
import type { FsEvent, GitStatus, WirePath } from "../lib/protocol";
import type { ServerRow } from "../lib/useLsp";

/**
 * Branch, language servers, caret. On `--chrome` rather than VS Code's blue: `--sym` is the
 * accent, spent on the one active thing. Nothing here is a control; each has a real home.
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
    // Asked, not cached: git is cheap and a stale branch name is worse than none. Failure is
    // silent -- a folder that is not a repository is ordinary, and git errors belong in the panel.
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
 * `indexing` is the state this exists for: a server that is up but cannot answer yet is normal
 * for minutes, and unsaid it looks like an editor with no completions. Wording matches `statusNote`.
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
