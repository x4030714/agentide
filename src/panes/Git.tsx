import { DiffEditor } from "@monaco-editor/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useResolvedAppearance } from "../lib/appearance";
import {
  checkpointList,
  checkpointRewind,
  gitBranches,
  gitCommit,
  gitFileDiff,
  gitStage,
  gitStatus,
  gitSwitch,
  gitUnstage,
} from "../lib/bridge";
import { themeFor } from "../lib/monaco-setup";
import { baseName, errorMessage } from "../lib/protocol";
import type {
  Checkpoint,
  FsEvent,
  GitBranch,
  GitFile,
  GitFileDiff,
  GitStatus,
} from "../lib/protocol";

interface GitProps {
  /** Re-read when the workspace changes. */
  root: string | null;
  /** Latest batch from the watcher: an edit on disk changes what git would report. */
  changes: FsEvent[];
  /** Bumped when an agent turn ends, which is the other way the tree changes. */
  revision: number;
  onOpenFile: (path: string) => void;
}

const DIFF_OPTIONS = {
  automaticLayout: true,
  fontFamily: '"Iosevka", ui-monospace, "Cascadia Mono", Consolas, monospace',
  fontSize: 13,
  lineHeight: 20,
  fontLigatures: false,
  minimap: { enabled: false },
  renderSideBySide: false,
  readOnly: true,
  scrollBeyondLastLine: false,
  renderOverviewRuler: false,
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
} as const;

/**
 * Git has eight states; the world has four colour roles. This is the mapping, and it is
 * deliberately lossy: the bar answers "is this new, changed, gone or broken", which is
 * what you read a status list for. The exact state is in the row's tooltip for the rare
 * moment it matters.
 *
 * No letters. `A`/`M`/`D` is a legend you have to learn, and the review queue already
 * settled this question the other way.
 */
const TONE: Record<GitFile["state"], string> = {
  added: "added",
  untracked: "added",
  modified: "modified",
  typeChanged: "modified",
  renamed: "modified",
  copied: "modified",
  deleted: "deleted",
  conflicted: "conflicted",
};

/** Said out loud in the tooltip, since the bar cannot distinguish these. */
const LABEL: Record<GitFile["state"], string> = {
  added: "added",
  untracked: "untracked",
  modified: "modified",
  typeChanged: "type changed",
  renamed: "renamed",
  copied: "copied",
  deleted: "deleted",
  conflicted: "conflicted",
};

/**
 * The repository panel: what is staged, what is not, and the controls to move things
 * between the two and commit the result.
 *
 * Two things it deliberately does not do. It does not cache: git is the truth and it is
 * cheap to ask, and a panel showing a stale index is a panel that will make someone
 * commit the wrong thing. And it never forces anything -- when git refuses a switch
 * because it would discard work, the refusal is shown as git wrote it, naming the files,
 * rather than being turned into a button that overrides it.
 */
export function GitPane({ root, changes, revision, onOpenFile }: GitProps) {
  const appearance = useResolvedAppearance();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [selected, setSelected] = useState<{ rel: string; staged: boolean } | null>(null);
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [history, setHistory] = useState<Checkpoint[]>([]);
  /** Which checkpoint is one more click from being restored. */
  const [confirming, setConfirming] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!root) {
      setStatus(null);
      return;
    }
    try {
      const next = await gitStatus();
      setStatus(next);
      setError(null);
    } catch (err) {
      setStatus(null);
      setError(errorMessage(err));
    }
  }, [root]);

  useEffect(() => {
    void reload();
  }, [reload, revision]);

  // The turn history lives beside the repository state because they answer the same
  // question from two directions: what changed, and what can be put back.
  useEffect(() => {
    if (!root) {
      setHistory([]);
      return;
    }
    checkpointList(12)
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [root, revision]);

  // An edit on disk changes what git reports, and the watcher is already telling us.
  useEffect(() => {
    if (changes.length > 0) void reload();
  }, [changes, reload]);

  const staged = useMemo(() => status?.files.filter((file) => file.staged) ?? [], [status]);
  const unstaged = useMemo(() => status?.files.filter((file) => !file.staged) ?? [], [status]);

  // Reading the diff is a second round trip, so it happens only for the selected row.
  useEffect(() => {
    let cancelled = false;
    if (!selected) {
      setDiff(null);
      return;
    }
    gitFileDiff(selected.rel, selected.staged)
      .then((next) => {
        if (!cancelled) setDiff(next);
      })
      .catch((err) => {
        if (!cancelled) {
          setDiff(null);
          setError(errorMessage(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected, revision, changes]);

  const act = useCallback(
    async (run: () => Promise<void>, done?: string) => {
      setBusy(true);
      setError(null);
      try {
        await run();
        setNote(done ?? null);
        await reload();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const commit = useCallback(async () => {
    const text = message.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      const result = await gitCommit(text);
      setMessage("");
      setNote(`${result.sha} ${result.subject}`);
      setSelected(null);
      await reload();
    } catch (err) {
      // A pre-commit hook's own output lands here, which is the useful thing to show.
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [message, reload]);

  const openBranches = useCallback(async () => {
    setBranchesOpen((open) => !open);
    try {
      setBranches(await gitBranches());
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  if (!root) {
    return (
      <div className="pane git">
        <div className="pane-header">
          <span className="legend">Repository</span>
        </div>
        <div className="pane-body">
          <p className="note">no workspace open</p>
        </div>
      </div>
    );
  }

  if (status && !status.isRepo) {
    return (
      <div className="pane git">
        <div className="pane-header">
          <span className="legend">Repository</span>
        </div>
        <div className="pane-body">
          <p className="note">
            this folder is not a git repository — checkpoints still cover the agent's edits
          </p>
        </div>
      </div>
    );
  }

  const rows = (files: GitFile[], isStaged: boolean) =>
    files.map((file) => (
      <div
        key={`${isStaged ? "s" : "u"}:${file.rel}`}
        className={`git-row is-${TONE[file.state]}${
          selected?.rel === file.rel && selected.staged === isStaged ? " is-selected" : ""
        }`}
      >
        <button
          type="button"
          className="git-open"
          onClick={() => setSelected({ rel: file.rel, staged: isStaged })}
          onDoubleClick={() => onOpenFile(file.path)}
          title={`${LABEL[file.state]}${file.from ? ` from ${file.from}` : ""} — ${file.rel}`}
        >
          <span className="change-mark" aria-hidden="true" />
          <span className="change-name">{baseName(file.rel)}</span>
          <span className="change-dir">{file.rel}</span>
        </button>
        {file.state === "conflicted" ? (
          // Staging a conflict would mark it resolved without anyone resolving it.
          <span className="note conflict-note">resolve in the editor</span>
        ) : (
          <button
            type="button"
            className="ghost-button"
            disabled={busy}
            onClick={() =>
              void act(
                () => (isStaged ? gitUnstage([file.rel]) : gitStage([file.rel])),
                `${isStaged ? "Unstaged" : "Staged"} ${baseName(file.rel)}`,
              )
            }
          >
            {isStaged ? "Unstage" : "Stage"}
          </button>
        )}
      </div>
    ));

  return (
    <div className="pane git">
      <div className="pane-header">
        <button type="button" className="ghost-button branch-button" onClick={() => void openBranches()}>
          {status?.detached ? `detached @ ${status.head ?? "?"}` : (status?.branch ?? "…")}
        </button>
        {status && (status.ahead > 0 || status.behind > 0) && (
          <span className="measure" title={status.upstream ?? undefined}>
            {status.ahead > 0 && `↑${status.ahead}`}
            {status.behind > 0 && `↓${status.behind}`}
          </span>
        )}
        <button type="button" className="ghost-button" disabled={busy} onClick={() => void reload()}>
          Refresh
        </button>
      </div>

      {branchesOpen && (
        <div className="branch-list">
          {branches.length === 0 && <p className="note">no branches</p>}
          {branches.map((branch) => (
            <button
              key={branch.name}
              type="button"
              className={`branch-row${branch.current ? " is-on" : ""}`}
              disabled={busy || branch.current}
              onClick={() =>
                void act(() => gitSwitch(branch.name), `Switched to ${branch.name}`).then(() =>
                  setBranchesOpen(false),
                )
              }
            >
              <span className="branch-name">{branch.name}</span>
              <span className="branch-subject">{branch.subject}</span>
            </button>
          ))}
        </div>
      )}

      <div className="pane-body git-body">
        <div className="git-list">
          {error && <p className="note is-error">{error}</p>}
          {note && !error && <p className="note">{note}</p>}

          <div className="change-group">
            <span className="legend">
              Staged{staged.length > 0 ? ` · ${staged.length}` : ""}
            </span>
            {staged.length > 0 && (
              <button
                type="button"
                className="ghost-button"
                disabled={busy}
                onClick={() =>
                  void act(
                    () => gitUnstage(staged.map((file) => file.rel)),
                    `Unstaged ${staged.length} file${staged.length === 1 ? "" : "s"}`,
                  )
                }
              >
                Unstage all
              </button>
            )}
          </div>
          {staged.length === 0 ? <p className="note">nothing staged</p> : rows(staged, true)}

          <div className="change-group">
            <span className="legend">
              Changed{unstaged.length > 0 ? ` · ${unstaged.length}` : ""}
            </span>
            {unstaged.some((file) => file.state !== "conflicted") && (
              <button
                type="button"
                className="ghost-button"
                disabled={busy}
                onClick={() =>
                  void act(
                    () =>
                      gitStage(
                        unstaged
                          .filter((file) => file.state !== "conflicted")
                          .map((file) => file.rel),
                      ),
                    "Staged everything",
                  )
                }
              >
                Stage all
              </button>
            )}
          </div>
          {unstaged.length === 0 ? (
            <p className="note">working tree clean</p>
          ) : (
            rows(unstaged, false)
          )}

        </div>

        {/* Outside the scrolling list on purpose: a commit button you have to scroll to
            find is a commit button people work around by using the terminal. */}
        <div className="commit-box">
            <textarea
              className="commit-input"
              rows={2}
              value={message}
              placeholder={staged.length === 0 ? "stage something first" : "commit message"}
              spellCheck={false}
              disabled={busy}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                // Ctrl+Enter, not Enter: a commit message is a paragraph, and the
                // composer's Enter-to-send would make writing one a fight.
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                  event.preventDefault();
                  void commit();
                }
              }}
            />
            <button
              type="button"
              className="ghost-button"
              disabled={busy || staged.length === 0 || message.trim() === ""}
              onClick={() => void commit()}
            >
              Commit {staged.length > 0 ? `${staged.length}` : ""}
          </button>
        </div>

        {history.length > 0 && (
          <div className="timeline">
            <div className="change-group">
              <span className="legend">Turns</span>
            </div>
            {history.map((point) => (
              <div key={point.id} className="timeline-row">
                <span className="timeline-mark" aria-hidden="true" />
                <span className="timeline-label" title={point.label}>
                  {point.label}
                </span>
                <span className="measure">
                  {point.filesChanged > 0
                    ? `${point.filesChanged} file${point.filesChanged === 1 ? "" : "s"}`
                    : "no changes"}
                </span>
                <button
                  type="button"
                  className={`ghost-button${confirming === point.id ? " is-warn" : ""}`}
                  disabled={busy}
                  onClick={() => {
                    // Two clicks, because this rewrites the working tree. The second one
                    // is still undoable -- rewind takes its own checkpoint first -- but
                    // that is a reason to allow it, not a reason to do it by accident.
                    if (confirming !== point.id) {
                      setConfirming(point.id);
                      return;
                    }
                    setConfirming(null);
                    void act(async () => {
                      await checkpointRewind(point.id);
                    }, `Rewound to ${point.label}`);
                  }}
                >
                  {confirming === point.id ? "Confirm" : "Rewind"}
                </button>
              </div>
            ))}
            <p className="note">
              Rewinding restores files only. Your commits and branches are untouched.
            </p>
          </div>
        )}

        <div className="change-detail">
          {!selected && <p className="note">pick a file to see what changed</p>}
          {selected && diff?.binary && <p className="note">binary file — nothing to show</p>}
          {selected && diff && !diff.binary && (
            <div className="change-diff">
              <DiffEditor
                original={diff.before ?? ""}
                modified={diff.after ?? ""}
                language={undefined}
                theme={themeFor(appearance)}
                options={DIFF_OPTIONS}
                loading={<p className="note">reading…</p>}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
