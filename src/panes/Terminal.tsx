import { FitAddon } from "@xterm/addon-fit";
import { useFocusTarget } from "../lib/keys";
import { WebglAddon } from "@xterm/addon-webgl";
import { CanvasAddon } from "@xterm/addon-canvas";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

import { useResolvedAppearance } from "../lib/appearance";
import {
  AGENT_PTY_ID,
  attachAgentTerminal,
  attachBackground,
  forgetBackground,
  listBackground,
  watchBackground,
} from "../lib/agent-shell";
import type { BackgroundProcess } from "../lib/agent-shell";
import { ptyKill, ptyResize, ptySpawn, ptyWrite } from "../lib/bridge";
import { IconClose } from "../lib/icons";
import { errorMessage } from "../lib/protocol";
import type { PtyEvent, WirePath } from "../lib/protocol";
import { TERMINAL_FONT, terminalTheme } from "../lib/terminal-theme";

interface TerminalProps {
  root: WirePath | null;
}

interface Session {
  id: string;
  label: string;
}

let counter = 0;
const nextSession = (): Session => {
  counter += 1;
  return { id: `t${counter}-${Date.now().toString(36)}`, label: `Shell ${counter}` };
};

/** A command as a tab name: the program, not the whole line. */
function label(command: string): string {
  const first = command.trim().split(/\s+/).slice(0, 2).join(" ");
  return first.length > 18 ? `${first.slice(0, 17)}…` : first;
}

/** Real shells in tabs, plus a read-only tab per agent process. Every session stays
 * mounted: xterm owns the scrollback, so unmounting throws away what you switched to keep. */
export function TerminalPane({ root }: TerminalProps) {
  const [sessions, setSessions] = useState<Session[]>(() => [nextSession()]);
  const [active, setActive] = useState(() => sessions[0].id);
  const [background, setBackground] = useState<BackgroundProcess[]>(() => listBackground());

  // The registry lives outside React because a process has to outlive this pane; this
  // just mirrors it. `watchBackground` fires on start, exit and stop.
  useEffect(() => watchBackground(() => setBackground(listBackground())), []);

  /** Focus the visible terminal through the DOM, not a ref: xterm's own hidden textarea
   * is what must receive the keystroke. */
  const focusTerminal = useCallback(() => {
    // After the state change above, so the newly shown tab is the one queried.
    requestAnimationFrame(() => {
      const panel = document.querySelector(".term-panel:not([hidden])");
      panel?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")?.focus();
    });
  }, []);

  // Focus reaches the pane, which hands it to whichever tab is showing -- and never to
  // the agent's, which takes no input and would swallow the keystroke that follows.
  useFocusTarget("terminal", () => {
    if (active === AGENT_PTY_ID) setActive(sessions[sessions.length - 1].id);
    focusTerminal();
  });

  const close = useCallback(
    (id: string) => {
      void ptyKill(id);
      setSessions((current) => {
        const next = current.filter((session) => session.id !== id);
        // Never leave the pane with no shell — an empty terminal pane is a dead end.
        if (next.length === 0) {
          const fresh = nextSession();
          setActive(fresh.id);
          return [fresh];
        }
        setActive((currentActive) =>
          currentActive === id ? next[next.length - 1].id : currentActive,
        );
        return next;
      });
    },
    [],
  );

  return (
    <div className="pane terminal">
      <div className="pane-header term-tabs" role="tablist">
        {/* The agent's terminal, first and not closable: closing it would let the agent
            run something with nowhere to show it. */}
        <span className={`term-tab${active === AGENT_PTY_ID ? " is-on" : ""}`}>
          <button
            type="button"
            role="tab"
            aria-selected={active === AGENT_PTY_ID}
            className="term-tab-name is-agent"
            onClick={() => setActive(AGENT_PTY_ID)}
            title="Commands the agent runs. Read-only."
          >
            Agent
          </button>
        </span>
        {/* One tab per process the agent left running. A dev server it started is the
            thing worth watching, and asking the agent to read its log back is not that. */}
        {background.map((process) => (
          <span key={process.id} className={`term-tab${process.id === active ? " is-on" : ""}`}>
            <button
              type="button"
              role="tab"
              aria-selected={process.id === active}
              className="term-tab-name is-agent"
              onClick={() => setActive(process.id)}
              title={`${process.command}${process.running ? "" : ` — exited ${process.exitCode ?? "?"}`}`}
            >
              {label(process.command)}
              {process.running ? "" : " ·"}
            </button>
            <button
              type="button"
              className="term-tab-close"
              aria-label={`Stop and close ${process.command}`}
              onClick={() => {
                if (active === process.id) setActive(AGENT_PTY_ID);
                void forgetBackground(process.id);
              }}
            >
              <IconClose />
            </button>
          </span>
        ))}
        {sessions.map((session) => (
          <span key={session.id} className={`term-tab${session.id === active ? " is-on" : ""}`}>
            <button
              type="button"
              role="tab"
              aria-selected={session.id === active}
              className="term-tab-name"
              onClick={() => setActive(session.id)}
            >
              {session.label}
            </button>
            <button
              type="button"
              className="term-tab-close"
              aria-label={`Close ${session.label}`}
              onClick={() => close(session.id)}
            >
              <IconClose />
            </button>
          </span>
        ))}
        <button
          type="button"
          className="term-add"
          aria-label="New shell"
          onClick={() => {
            const fresh = nextSession();
            setSessions((current) => [...current, fresh]);
            setActive(fresh.id);
          }}
        >
          +
        </button>
      </div>

      <div className="term-body">
        <div className="term-panel" hidden={active !== AGENT_PTY_ID}>
          <TerminalView
            id={AGENT_PTY_ID}
            root={root}
            active={active === AGENT_PTY_ID}
            attach={attachAgentTerminal}
          />
        </div>
        {background.map((process) => (
          <div key={process.id} className="term-panel" hidden={process.id !== active}>
            <TerminalView
              id={process.id}
              root={root}
              active={process.id === active}
              attach={(listener) => attachBackground(process.id, listener)}
            />
          </div>
        ))}
        {sessions.map((session) => (
          <div key={session.id} className="term-panel" hidden={session.id !== active}>
            <TerminalView id={session.id} root={root} active={session.id === active} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** One xterm bound to one pty. */
function TerminalView({
  id,
  root,
  active,
  attach,
}: {
  id: string;
  root: WirePath | null;
  active: boolean;
  /** Render an existing stream instead of spawning a shell. A window onto that session:
   * it spawns nothing, kills nothing, and takes no input. */
  attach?: (write: (chunk: Uint8Array) => void) => () => void;
}) {
  const appearance = useResolvedAppearance();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      ...TERMINAL_FONT,
      theme: terminalTheme(appearance),
      // The pane behind is translucent; without this xterm paints an opaque ground.
      allowTransparency: true,
      cursorBlink: true,
      scrollback: 10_000,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    /** WebGL, falling back to canvas. xterm's default DOM renderer cannot keep up with
     * build output, and that is most of the difference from feeling native. */
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        term.loadAddon(new CanvasAddon());
      });
      term.loadAddon(webgl);
    } catch {
      term.loadAddon(new CanvasAddon());
    }

    fit.fit();

    let disposed = false;
    let ready = false;
    let detach: (() => void) | null = null;

    if (attach) {
      detach = attach((chunk) => {
        if (!disposed) term.write(chunk);
      });
    } else
    void ptySpawn(
      {
        id,
        ...(root ? { cwd: root } : {}),
        rows: term.rows,
        cols: term.cols,
      },
      (chunk) => {
        if (!disposed) term.write(chunk);
      },
      (event: PtyEvent) => {
        if (disposed) return;
        // Say so in the terminal itself rather than in chrome: this is where the reader
        // is already looking, and it keeps the scrollback and the verdict together.
        term.write(`\r\n\x1b[2m${event.message}\x1b[0m\r\n`);
      },
    )
      .then(() => {
        ready = true;
      })
      .catch((err) => {
        if (!disposed) setError(errorMessage(err));
      });

    // Read-only when attached: the agent owns that session, and a keystroke landing in
    // the middle of its command is the exact problem a separate terminal exists to avoid.
    const onData = term.onData((data) => {
      if (!attach && ready) void ptyWrite(id, data);
    });

    // The pane is resizable, so the pty must be told or the shell wraps at the wrong
    // width and every subsequent line is garbage.
    const observer = new ResizeObserver(() => {
      if (disposed || host.clientWidth === 0) return;
      // Only act when the size *in cells* changed: a pane drag fires per pixel, and
      // refitting to the size it already is emits another resize — that is the loop.
      const proposed = fit.proposeDimensions();
      if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return;
      if (proposed.cols === term.cols && proposed.rows === term.rows) return;
      fit.fit();
      if (!attach && ready) void ptyResize(id, term.rows, term.cols);
    });
    observer.observe(host);

    return () => {
      disposed = true;
      observer.disconnect();
      onData.dispose();
      detach?.();
      term.dispose();
      // Only a shell this view started is a shell this view may end.
      if (!attach) void ptyKill(id);
    };
    // Once per session id: changing folders does not move a running shell, as anywhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // The theme follows the app, live — a terminal left on the old palette after a
  // light/dark switch is the most obvious way to look unfinished.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = terminalTheme(appearance);
  }, [appearance]);

  // A hidden tab gets no resize events, so it must refit when it comes back.
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      fitRef.current?.fit();
      const term = termRef.current;
      if (term && !attach) void ptyResize(id, term.rows, term.cols);
      if (!attach) term?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, id]);

  return (
    <>
      {error && <p className="note is-error">{error}</p>}
      <div className="term-host" ref={hostRef} />
    </>
  );
}
