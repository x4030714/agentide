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
  /** What the open conversation has cost, in USD. Zero until a turn has finished. */
  cost: number;
  /** How much of the window the conversation fills. Null until a turn has finished. */
  context: { tokens: number; max: number } | null;
}

export function StatusBar({ root, changes, revision, servers, cost, context }: StatusBarProps) {
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
      {/**
       * What this conversation has cost so far.
       *
       * Here rather than in the transcript because it is a fact about the session, like the
       * branch and the language servers beside it -- and because the place you want it is
       * before you send the next turn, not buried in the last one.
       *
       * Three decimals: turns land in the tens of cents and a two-decimal figure would sit
       * at $0.00 through the first few, which reads as free rather than as cheap.
       */}
      {cost > 0 && (
        <span className="status-cost" title="Estimated cost of this conversation">
          ${cost.toFixed(3)}
        </span>
      )}
      {/**
       * How full the window is.
       *
       * The number that was missing when a conversation reached 925k tokens and every tool
       * call re-read all of it. Shown as a share of the window the SDK will compact at, so
       * it answers "how close to compaction", and coloured only past 80% -- a warning that is
       * always on is not a warning.
       */}
      {context && (
        <span
          className={`status-context${context.tokens / context.max >= 0.8 ? " is-high" : ""}`}
          title={`${context.tokens.toLocaleString()} of ${context.max.toLocaleString()} tokens in the window — compaction happens at the limit`}
        >
          {Math.round((context.tokens / context.max) * 100)}% ctx
        </span>
      )}
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
