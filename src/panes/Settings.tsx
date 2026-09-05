import { useCallback, useEffect, useState } from "react";

import type { Appearance } from "../lib/appearance";
import {
  claudeConversationsList,
  claudeProjectsList,
  conversationImport,
  conversationRead,
} from "../lib/bridge";
import { ago, formatSize } from "../lib/format";
import { IconChevron, IconPalette } from "../lib/icons";
import { PALETTES } from "../lib/palette";
import type { Palette } from "../lib/palette";
import { errorMessage } from "../lib/protocol";
import type { ClaudeProject, ConversationEntry, ConversationSummary } from "../lib/protocol";

interface SettingsProps {
  /** The open workspace, for marking its own project and for what import copies into. */
  root: string | null;
  appearance: Appearance;
  onAppearance: (next: Appearance) => void;
  palette: Palette;
  onPalette: (next: Palette) => void;
  /** An imported conversation, by its new id: the next prompt should continue it. */
  onImported: (id: string) => void;
  onClose: () => void;
}

const APPEARANCES: Array<{ id: Appearance; label: string }> = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/**
 * Settings, as an overlay rather than a pane.
 *
 * A pane would cost a permanent tab for something opened a few times a month, and the
 * panes are the work. This is a mode: it takes the keyboard, Escape leaves, and nothing
 * behind it moves.
 *
 * Dense on purpose. Every control here is one this machine's only user already knows the
 * meaning of, so the space goes to the lists rather than to explaining the switches. The
 * one thing that does get a sentence is import, because what it does to a transcript is
 * not guessable from the word.
 */
export function Settings({
  root,
  appearance,
  onAppearance,
  palette,
  onPalette,
  onImported,
  onClose,
}: SettingsProps) {
  useEffect(() => {
    // On the window rather than on the dialog: there are a dozen focusable controls in
    // here, and Escape has to work from all of them, including from none of them.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="settings-backdrop" onPointerDown={onClose}>
      <div
        className="settings"
        role="dialog"
        aria-label="Settings"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="settings-head">
          <span className="legend">Settings</span>
          <span className="measure">Esc</span>
        </header>

        <div className="settings-body">
          <section className="settings-section">
            <h2 className="settings-legend">Appearance</h2>
            <div className="settings-row">
              <span className="settings-label">Theme</span>
              <div className="settings-choices">
                {APPEARANCES.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`settings-choice${option.id === appearance ? " is-on" : ""}`}
                    aria-pressed={option.id === appearance}
                    onClick={() => onAppearance(option.id)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-row">
              <span className="settings-label">Palette</span>
              <div className="settings-choices">
                {PALETTES.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`settings-choice${option.id === palette ? " is-on" : ""}`}
                    aria-pressed={option.id === palette}
                    title={option.note}
                    onClick={() => onPalette(option.id)}
                  >
                    <span className={`palette-chip is-${option.id}`}>
                      <IconPalette id={option.id} size={12} />
                    </span>
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <ImportSection root={root} onImported={onImported} />
        </div>
      </div>
    </div>
  );
}

/**
 * Every project Claude Code has transcripts for, and a way to bring one here.
 *
 * The two listings are separate calls because they cost different amounts. The projects
 * list reads the head of one file per directory; the conversations in a directory cost a
 * full scan of every transcript in it, and the biggest directory on this machine is 182 MB
 * over 79 files. So a directory is only scanned once it is expanded.
 */
function ImportSection({
  root,
  onImported,
}: {
  root: string | null;
  onImported: (id: string) => void;
}) {
  const [projects, setProjects] = useState<ClaudeProject[] | null>(null);
  const [openDir, setOpenDir] = useState<string | null>(null);
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [readingId, setReadingId] = useState<string | null>(null);
  const [entries, setEntries] = useState<ConversationEntry[] | null>(null);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    claudeProjectsList()
      .then((next) => {
        if (!cancelled) setProjects(next);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!openDir) {
      setItems(null);
      return;
    }
    let cancelled = false;
    setItems(null);
    claudeConversationsList(openDir)
      .then((next) => {
        if (!cancelled) setItems(next);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [openDir]);

  useEffect(() => {
    if (!openDir || !readingId) {
      setEntries(null);
      return;
    }
    let cancelled = false;
    setEntries(null);
    conversationRead(readingId, openDir)
      .then((next) => {
        if (!cancelled) setEntries(next);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [openDir, readingId]);

  const bringHere = useCallback(
    async (id: string, dir: string) => {
      setImportingId(id);
      setError(null);
      try {
        onImported(await conversationImport(id, dir));
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setImportingId(null);
      }
    },
    [onImported],
  );

  return (
    <section className="settings-section">
      <h2 className="settings-legend">Claude Code conversations</h2>
      <p className="note">
        Every project Claude Code has a history for, this app&apos;s and the CLI&apos;s alike —
        they share one store. Import copies a transcript into this workspace under a new id:
        the model picks up with the same history, but it becomes a separate conversation and
        the original stays untouched where it is.
      </p>

      {error && <p className="note is-error">{error}</p>}
      {!error && !projects && <p className="note">reading ~/.claude/projects…</p>}
      {projects && projects.length === 0 && (
        <p className="note">no projects — nothing has been said to Claude Code on this machine</p>
      )}
      {!root && projects && projects.length > 0 && (
        <p className="note">open a folder to import into</p>
      )}

      <div className="settings-projects">
        {(projects ?? []).map((project) => {
          const open = openDir === project.dir;
          const here = sameWorkspace(project.cwd, root);
          return (
            <div key={project.dir} className={`settings-project${open ? " is-open" : ""}`}>
              <button
                type="button"
                className="settings-project-open"
                aria-expanded={open}
                onClick={() => {
                  setReadingId(null);
                  setOpenDir(open ? null : project.dir);
                }}
                title={project.cwd}
              >
                <IconChevron open={open} />
                <span className="settings-project-name">{project.cwd}</span>
                <span className="settings-project-meta">
                  {project.conversations} · {formatSize(project.bytes, false)} ·{" "}
                  {ago(project.updatedMs)}
                  {here ? " · this workspace" : ""}
                </span>
              </button>

              {open && !items && <p className="note">reading {project.conversations} transcripts…</p>}
              {open && items && items.length === 0 && (
                <p className="note">nothing here was ever said to</p>
              )}
              {open &&
                items?.map((item) => (
                  <div key={item.id} className="settings-convo">
                    <button
                      type="button"
                      className="convo-open"
                      onClick={() => setReadingId(readingId === item.id ? null : item.id)}
                      title={item.opening ?? item.id}
                    >
                      <span className="convo-name">{item.title ?? item.opening ?? item.id}</span>
                      <span className="convo-meta">
                        {ago(item.updatedMs)} · {item.prompts} prompt
                        {item.prompts === 1 ? "" : "s"} · {formatSize(item.bytes, false)}
                        {item.branch ? ` · ${item.branch}` : ""}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={!root || importingId !== null || here}
                      title={
                        here
                          ? "Already this workspace's own conversation"
                          : "Copy this transcript into the open workspace and continue it"
                      }
                      onClick={() => void bringHere(item.id, project.dir)}
                    >
                      {importingId === item.id ? "Copying…" : "Import here"}
                    </button>
                  </div>
                ))}

              {open && readingId && (
                <div className="settings-preview">
                  {!entries && <p className="note">reading…</p>}
                  {entries && entries.length === 0 && <p className="note">nothing was said in it</p>}
                  {entries && entries.length > 0 && (
                    <div className="convo-read">
                      {entries.map((entry, index) => (
                        <div key={index} className={`convo-message is-${entry.role}`}>
                          <span className="convo-said">{entry.text}</span>
                          {entry.tools.length > 0 && (
                            <span className="convo-tools">{entry.tools.join(", ")}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Is this transcript's `cwd` the workspace that is open?
 *
 * The record's `cwd` is native — `C:\a\b` — and the workspace root is a `WirePath`, so the
 * two never match as written. Rust normalizes properly; this only has to be right enough
 * to label a row, so it does the same three things `WirePath` does and no more.
 */
function sameWorkspace(cwd: string, root: string | null): boolean {
  if (!root) return false;
  const shape = (path: string) =>
    path
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`);
  return shape(cwd) === shape(root);
}
