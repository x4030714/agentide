import { DiffEditor } from "@monaco-editor/react";
import { useCallback, useEffect, useState } from "react";

import { useResolvedAppearance } from "../lib/appearance";
import {
  checkpointDiff,
  checkpointHunks,
  checkpointRevertFile,
  checkpointRevertHunks,
  checkpointRewind,
} from "../lib/bridge";
import { formatSize } from "../lib/format";
import { themeFor } from "../lib/monaco-setup";
import { baseName, errorMessage } from "../lib/protocol";
import type { Checkpoint, DiffFile, FileHunks, WirePath } from "../lib/protocol";

interface ChangesProps {
  /** The checkpoint the current turn started from, or null before any turn. */
  checkpoint: Checkpoint | null;
  /** Bumped when a turn ends, so the queue re-reads without polling. */
  revision: number;
  onCountChange: (count: number) => void;
}

const DIFF_OPTIONS = {
  automaticLayout: true,
  fontFamily: '"JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, monospace',
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
 * The review queue: what changed since the turn started, and how to put it back. Every read is
 * a fresh query — a stale diff is worse than a slow one when it drives "delete this".
 */
export function ChangesPane({ checkpoint, revision, onCountChange }: ChangesProps) {
  const appearance = useResolvedAppearance();
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [selected, setSelected] = useState<WirePath | null>(null);
  const [hunks, setHunks] = useState<FileHunks | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!checkpoint) {
      setFiles([]);
      return;
    }
    try {
      const diff = await checkpointDiff(checkpoint.id);
      setFiles(diff.files);
      setError(null);
      setSelected((current) =>
        current && diff.files.some((file) => file.path === current) ? current : null,
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [checkpoint]);

  useEffect(() => {
    void reload();
  }, [reload, revision]);

  useEffect(() => {
    onCountChange(files.length);
  }, [files.length, onCountChange]);

  // Hunks are recomputed per selection, never cached: their ids come from the file as
  // it stands, and a reverted hunk changes every id after it.
  useEffect(() => {
    let cancelled = false;
    setPicked(new Set());
    if (!checkpoint || !selected) {
      setHunks(null);
      return;
    }
    checkpointHunks(checkpoint.id, selected)
      .then((next) => {
        if (!cancelled) setHunks(next);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [checkpoint, selected]);

  const act = useCallback(
    async (run: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await run();
        setError(null);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
        await reload();
        // The ids the panel is holding were computed against the previous state.
        setPicked(new Set());
        if (checkpoint && selected) {
          try {
            setHunks(await checkpointHunks(checkpoint.id, selected));
          } catch {
            setHunks(null);
          }
        }
      }
    },
    [reload, checkpoint, selected],
  );

  const file = files.find((entry) => entry.path === selected) ?? null;

  if (!checkpoint) {
    return (
      <div className="pane changes">
        <div className="pane-header">
          <span className="legend">Changes</span>
        </div>
        <div className="pane-body">
          <p className="note">no turn yet — the queue fills once the agent edits something</p>
        </div>
      </div>
    );
  }

  return (
    <div className="pane changes">
      <div className="pane-header">
        <span className="legend">Changes</span>
        {files.length > 0 && <span className="measure">{files.length} files</span>}
        <button
          type="button"
          className="ghost-button is-warn"
          disabled={busy}
          title="Restore the whole tree to this turn's starting point. Takes a safety checkpoint first, so this is itself undoable."
          onClick={() => void act(() => checkpointRewind(checkpoint.id))}
        >
          Rewind turn
        </button>
      </div>

      <div className="pane-body changes-body">
        {error && <p className="note is-error">{error}</p>}
        {files.length === 0 && !error && (
          <p className="note">nothing changed since this turn began</p>
        )}

        {files.length > 0 && (
          <div className="change-list">
            {files.map((entry) => (
              <button
                type="button"
                key={entry.path}
                className={`change-row is-${entry.status}${entry.path === selected ? " is-selected" : ""}`}
                title={entry.relative}
                onClick={() => setSelected(entry.path === selected ? null : entry.path)}
              >
                <span className="change-mark" aria-hidden="true" />
                <span className="change-name">{baseName(entry.path)}</span>
                <span className="change-dir">{dirOf(entry.relative)}</span>
                <span className="change-stat">
                  {entry.omitted ? (
                    <span className="note">{omittedLabel(entry)}</span>
                  ) : (
                    <>
                      <span className="stat-added">+{entry.added}</span>
                      <span className="stat-removed">−{entry.removed}</span>
                    </>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}

        {file && (
          <div className="change-detail">
            <div className="change-actions">
              <span className="legend">{file.relative}</span>
              {hunks && hunks.hunks.length > 1 && (
                <span className="measure">
                  {picked.size > 0 ? `${picked.size} of ${hunks.hunks.length}` : `${hunks.hunks.length} hunks`}
                </span>
              )}
              {picked.size > 0 && (
                <button
                  type="button"
                  className="ghost-button"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      checkpointRevertHunks(checkpoint.id, file.path, [...picked]),
                    )
                  }
                >
                  Revert {picked.size} hunk{picked.size === 1 ? "" : "s"}
                </button>
              )}
              <button
                type="button"
                className="ghost-button is-warn"
                disabled={busy}
                onClick={() => void act(() => checkpointRevertFile(checkpoint.id, file.path))}
              >
                Revert file
              </button>
            </div>

            {hunks && hunks.hunks.length > 0 && (
              <div className="hunk-list">
                {hunks.hunks.map((hunk) => (
                  <label key={hunk.id} className="hunk-row">
                    <input
                      type="checkbox"
                      checked={picked.has(hunk.id)}
                      onChange={(event) =>
                        setPicked((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(hunk.id);
                          else next.delete(hunk.id);
                          return next;
                        })
                      }
                    />
                    <span className="hunk-header">{hunk.header}</span>
                    <span className="change-stat">
                      <span className="stat-added">+{hunk.added}</span>
                      <span className="stat-removed">−{hunk.removed}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}

            <div className="change-diff">
              {file.omitted ? (
                <p className="note">{omittedLabel(file)}</p>
              ) : (
                <DiffEditor
                  original={file.before ?? ""}
                  modified={file.after ?? ""}
                  language={undefined}
                  theme={themeFor(appearance)}
                  options={DIFF_OPTIONS}
                  loading={<p className="note">reading…</p>}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function dirOf(relative: string): string {
  const cut = relative.lastIndexOf("/");
  return cut < 0 ? "" : relative.slice(0, cut);
}

/** Says why the text is missing, rather than showing an empty diff that looks like no change. */
function omittedLabel(file: DiffFile): string {
  switch (file.omitted) {
    case "binary":
      return "binary — not a diff";
    case "tooLarge":
      return `too large to diff (${formatSize(Math.max(file.added, file.removed), false)} lines changed)`;
    case "budget":
      return "left out of the bulk diff — open it to load";
    case "notUtf8":
      return "not UTF-8 text";
    default:
      return "";
  }
}
