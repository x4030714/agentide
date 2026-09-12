import { useCallback, useEffect, useState } from "react";

import type { Appearance } from "../lib/appearance";
import {
  claudeConversationsList,
  claudeProjectsList,
  conversationImport,
  conversationRead,
  memoryReveal,
  memorySeed,
  memoryStats,
  memoryVault,
} from "../lib/bridge";
import { ago, formatSize } from "../lib/format";
import { IconChevron, IconPalette } from "../lib/icons";
import { PALETTES } from "../lib/palette";
import type { Palette } from "../lib/palette";
import {
  COMPACT_CHOICES,
  DEFAULT_COMPACT_WINDOW,
  compactChoiceFor,
  readCompactWindow,
  writeCompactWindow,
  type CompactWindow,
} from "../lib/context-window";
import { errorMessage } from "../lib/protocol";
import type { Layout } from "../lib/layout";
import type { Transparency } from "../lib/transparency";
import type {
  Account,
  AccountInfo,
  ClaudeProject,
  ConversationSummary,
  MemoryStats,
  MemoryVault,
} from "../lib/protocol";
import { saidIn, type Said } from "../lib/transcript";

interface SettingsProps {
  /** The open workspace, for marking its own project and for what import copies into. */
  root: string | null;
  appearance: Appearance;
  onAppearance: (next: Appearance) => void;
  palette: Palette;
  onPalette: (next: Palette) => void;
  transparency: Transparency;
  onTransparency: (next: Transparency) => void;
  /** Which shape the window takes. See `lib/layout.ts`. */
  layout: Layout;
  onLayout: (next: Layout) => void;
  /** An imported conversation, by its new id: the next prompt should continue it. */
  onImported: (id: string) => void;
  onClose: () => void;
  /** Who is signed in, or null until the sidecar has answered. */
  account: Account | null;
  /** Every account that could be picked. One entry means there is nothing to pick. */
  accounts: AccountInfo[];
  /** The key of the account turns currently run under. */
  activeAccount: string;
  /** Run the next turns under this account. */
  onSelectAccount: (key: string) => void;
  /** The outcome of the last sign-out, in the sidecar's own words. */
  accountNote: string | null;
  /** Ask again. Called when the Account section mounts, and after signing out. */
  onAccountRefresh: () => void;
  /** Sign out machine-wide. The section confirms before calling this. */
  onSignOut: () => void;
  /** Run the sign-in command in a terminal tab, where the device code is readable. */
  onSignIn: (command: string) => void;
}

/** The sections, in the order they are worth reaching. */
const SECTIONS = [
  { id: "account", label: "Account" },
  { id: "appearance", label: "Appearance" },
  { id: "context", label: "Context" },
  { id: "memory", label: "Memory" },
  { id: "import", label: "Import" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const APPEARANCES: Array<{ id: Appearance; label: string }> = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const LAYOUTS: Array<{ id: Layout; label: string; note: string }> = [
  {
    id: "workbench",
    label: "Workbench",
    note: "The IDE: tree, transcript, editor and terminal at once.",
  },
  {
    id: "basic",
    label: "Basic",
    note: "The conversation on its own, with past ones beside it. The agent still edits files.",
  },
];

const TRANSPARENCIES: Array<{ id: Transparency; label: string; note: string }> = [
  { id: "glass", label: "Glass", note: "Blurred desktop behind the window, translucent panes." },
  {
    id: "solid",
    label: "Solid",
    note: "No blur and no translucency. Every palette has a flat set solved for this.",
  },
];

/** An overlay, not a pane: a permanent tab is too much for something opened monthly. A
 * mode — it takes the keyboard and Escape leaves. Dense, because the user knows these. */
export function Settings({
  root,
  appearance,
  onAppearance,
  palette,
  onPalette,
  transparency,
  onTransparency,
  layout,
  onLayout,
  onImported,
  onClose,
  account,
  accounts,
  activeAccount,
  onSelectAccount,
  accountNote,
  onAccountRefresh,
  onSignOut,
  onSignIn,
}: SettingsProps) {
  /**
   * Which section is showing. Not remembered across opens: Settings is opened to change
   * one thing, and landing on wherever you were last is landing somewhere arbitrary.
   */
  const [section, setSection] = useState<SectionId>("account");

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
          {/* Sections rather than one scroll: three was already past a screen, and
              reaching Import meant scrolling the whole of Memory. */}
          <nav className="settings-nav" aria-label="Settings sections">
            {SECTIONS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`settings-tab${entry.id === section ? " is-on" : ""}`}
                aria-pressed={entry.id === section}
                onClick={() => setSection(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </nav>

          <div className="settings-panel">
          {section === "account" && (
            <AccountSection
              account={account}
              accounts={accounts}
              active={activeAccount}
              note={accountNote}
              onRefresh={onAccountRefresh}
              onSelect={onSelectAccount}
              onSignOut={onSignOut}
              onSignIn={onSignIn}
            />
          )}
          {section === "appearance" && (
          <section className="settings-section">
            <h2 className="settings-legend">Appearance</h2>
            <div className="settings-row">
              <span className="settings-label">Layout</span>
              <div className="settings-choices">
                {LAYOUTS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`settings-choice${option.id === layout ? " is-on" : ""}`}
                    aria-pressed={option.id === layout}
                    title={option.note}
                    onClick={() => onLayout(option.id)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="note settings-note">
              {LAYOUTS.find((option) => option.id === layout)?.note}
            </p>

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
              <span className="settings-label">Transparency</span>
              <div className="settings-choices">
                {TRANSPARENCIES.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`settings-choice${option.id === transparency ? " is-on" : ""}`}
                    aria-pressed={option.id === transparency}
                    title={option.note}
                    onClick={() => onTransparency(option.id)}
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
          )}

          {section === "context" && <ContextSection />}
          {section === "memory" && <MemorySection />}
          {section === "import" && <ImportSection root={root} onImported={onImported} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/** What the agent remembers, and where. Read-only: the path has a working default, so
 * this names the override rather than growing an editor for a value set once. */

/**
 * Who is signed in, and the two ways to change it.
 *
 * The account is asked for on open rather than held: it is one spawn, it is the only place
 * that shows it, and a cached answer would keep saying "signed in" after the credential went.
 */
function AccountSection({
  account,
  accounts,
  active,
  note,
  onRefresh,
  onSelect,
  onSignOut,
  onSignIn,
}: {
  account: Account | null;
  accounts: AccountInfo[];
  active: string;
  note: string | null;
  onRefresh: () => void;
  onSelect: (key: string) => void;
  onSignOut: () => void;
  onSignIn: (command: string) => void;
}) {
  /**
   * Signing out is confirmed in place rather than in a dialog.
   *
   * It is not scoped to agentide -- it drops the credential the person's own Claude Code
   * uses -- and nothing here can put it back. A second click is cheap; a browser round trip
   * they did not ask for is not.
   */
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    onRefresh();
  }, [onRefresh]);

  // A fresh answer arriving is what ends the confirmation, not the click: the button must
  // not go back to "Sign out" while the sign-out is still running.
  useEffect(() => {
    setConfirming(false);
  }, [account]);

  const waiting = account === null;

  return (
    <section className="settings-section">
      <h2 className="settings-legend">Account</h2>

      {accounts.length > 1 && (
        <div className="settings-row">
          <span className="settings-label">Use</span>
          <div className="settings-choices">
            {accounts.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className={`settings-choice${entry.key === active ? " is-on" : ""}`}
                aria-pressed={entry.key === active}
                // The directory, because switching accounts switches conversation history
                // with it, and that is the part the word "account" does not say.
                title={`${entry.configDir}${entry.used ? "" : " — never signed in"}`}
                onClick={() => onSelect(entry.key)}
              >
                {entry.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="settings-row">
        <span className="settings-label">Signed in</span>
        {waiting ? (
          <span className="note">asking…</span>
        ) : account.loggedIn ? (
          <div className="settings-account">
            <span className="settings-value">{account.email ?? "yes"}</span>
            <span className="note">
              {[account.plan, account.organization].filter(Boolean).join(" · ") || account.method}
            </span>
          </div>
        ) : (
          <span className="note">{account.error ?? "no — turns cannot run"}</span>
        )}
      </div>

      {note && <p className="note settings-note">{note}</p>}

      <div className="settings-row">
        <span className="settings-label" />
        <div className="settings-choices">
          {account?.loginCommand && (
            <button
              type="button"
              className="ghost-button"
              onClick={() => onSignIn(account.loginCommand!)}
            >
              {account.loggedIn ? "Sign in as someone else" : "Sign in"}
            </button>
          )}
          {account?.loggedIn && !confirming && (
            <button type="button" className="ghost-button" onClick={() => setConfirming(true)}>
              Sign out
            </button>
          )}
          {account?.loggedIn && confirming && (
            <>
              <button type="button" className="ghost-button is-warn" onClick={onSignOut}>
                Sign out everywhere
              </button>
              <button type="button" className="ghost-button" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      {confirming && (
        <p className="note settings-note">
          This signs Claude Code out on this whole machine, not just agentide. Signing back in
          needs a browser.
        </p>
      )}

      {accounts.length > 1 && !confirming && (
        <p className="note settings-note">
          An account is a config directory, so switching also switches which conversations
          Resume can see. The next turn starts a new agent process.
        </p>
      )}
    </section>
  );
}

/**
 * Where a conversation gets compacted.
 *
 * Its own section because it is the one setting in here that changes what a turn *costs*.
 * A conversation on Opus 5 reached 925,000 tokens without compacting -- the model's window
 * is a million and Claude Code compacts near the edge of it -- and every request, including
 * the one behind every tool call, carried all of it. Two prompts spent a session allowance.
 * Nothing in the window said so, which is why this is a control and not a constant.
 */
function ContextSection() {
  const [window, setWindow] = useState<CompactWindow>(DEFAULT_COMPACT_WINDOW);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readCompactWindow().then((value) => {
      if (!cancelled) setWindow(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const choose = (value: CompactWindow) => {
    // Optimistic: the control answers immediately and the file follows. A failed write says
    // so and puts the old value back, rather than leaving the two disagreeing.
    const previous = window;
    setWindow(value);
    setSaving(true);
    setError(null);
    void writeCompactWindow(value)
      .catch((err) => {
        setWindow(previous);
        setError(errorMessage(err));
      })
      .finally(() => setSaving(false));
  };

  return (
    <section className="settings-section">
      <h2 className="settings-legend">Context</h2>
      <p className="note">
        A conversation is re-sent in full on every request — including the one behind every
        tool call — until it is compacted. Compacting summarises the older part of it, which
        is what keeps a long session from costing a multiple of a short one.{" "}
        <strong>The status bar shows how full the window is</strong> after each turn.
      </p>

      <div className="settings-row">
        <span className="settings-label">Compact at</span>
        <div className="settings-choices">
          {COMPACT_CHOICES.map((choice) => (
            <button
              key={choice.label}
              type="button"
              className={`settings-choice${choice.value === window ? " is-on" : ""}`}
              aria-pressed={choice.value === window}
              title={choice.note}
              disabled={saving}
              onClick={() => choose(choice.value)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </div>

      <p className={`note settings-note${error ? " is-error" : ""}`}>
        {error ?? compactChoiceFor(window).note}
      </p>
      <p className="note">
        Takes effect on the next prompt. An oversized conversation shrinks on its next turn,
        or immediately with <code>/compact</code>.
      </p>
    </section>
  );
}

function MemorySection() {
  const [vault, setVault] = useState<MemoryVault | null>(null);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const found = await memoryVault();
        if (cancelled) return;
        setVault(found);
        // Seeded here, not at startup: this is the first place the folder is named, so it
        // must exist before Reveal is clicked. Never overwrites, so it costs a stat.
        await memorySeed(found.vault);
        const counted = await memoryStats(found.vault);
        if (!cancelled) setStats(counted);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const reveal = useCallback(() => {
    if (!vault) return;
    memoryReveal(vault.vault).catch((err) => setError(errorMessage(err)));
  }, [vault]);

  return (
    <section className="settings-section">
      <h2 className="settings-legend">Memory</h2>
      <p className="note">
        The agent records what it learns here as it goes — a decision and the reason for it,
        a constraint found the hard way, a fact about this machine — and reads it back in
        later sessions. Every write stops for your approval first, <strong>except in Auto
        mode</strong>: Auto skips every permission prompt, and memory writes are not an
        exception to that.
      </p>
      <p className="note">
        Notes are markdown with frontmatter, linked to each other with [[wikilinks]], so the
        folder opens in Obsidian as a vault. Edit them by hand, and delete one to make the
        agent forget it. To keep the vault somewhere else, put a path in
        ~/.agentide/memory.json.
      </p>

      {error && <p className="note is-error">{error}</p>}
      {vault && !vault.enabled && (
        <p className="note">memory is off — ~/.agentide/memory.json says enabled: false</p>
      )}

      <div className="settings-row">
        <span className="settings-label">Vault</span>
        <div className="settings-vault">
          <span className="settings-path" title={vault?.vault ?? ""}>
            {vault?.vault ?? "…"}
          </span>
          <button
            type="button"
            className="ghost-button"
            disabled={!vault}
            title="Open the vault in the file manager"
            onClick={reveal}
          >
            Reveal
          </button>
        </div>
      </div>
      <div className="settings-row">
        <span className="settings-label">Notes</span>
        <span className="settings-value">
          {!stats && !error && "counting…"}
          {stats && stats.notes === 0 && "nothing recorded yet"}
          {stats && stats.notes > 0 && (
            <>
              {stats.notes} note{stats.notes === 1 ? "" : "s"} · {formatSize(stats.bytes, false)} ·
              newest {ago(stats.newestMs)}
            </>
          )}
        </span>
      </div>
    </section>
  );
}

/** Every project with transcripts, and a way to import one. Two calls because they cost
 * differently: the biggest directory here is 182 MB, so it is scanned only on expand. */
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
  const [entries, setEntries] = useState<Said[] | null>(null);
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
        if (!cancelled) setEntries(saidIn(next));
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

/** Is this transcript's `cwd` the open workspace? The record's is native and the root is a
 * `WirePath`, so they never match as written. Right enough to label a row. */
function sameWorkspace(cwd: string, root: string | null): boolean {
  if (!root) return false;
  const shape = (path: string) =>
    path
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`);
  return shape(cwd) === shape(root);
}
