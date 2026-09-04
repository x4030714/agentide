import { useEffect, useState } from "react";

import { windowChrome } from "../lib/bridge";
import { IconClose, IconMaximize, IconMinimize, IconRestore, IconTheme } from "../lib/icons";
import { parentOf } from "../lib/protocol";
import type { Workspace } from "../lib/protocol";
import type { Appearance } from "../lib/appearance";

/**
 * The window's own title bar, drawn by us because the OS frame is gone.
 *
 * `data-tauri-drag-region` makes the bar draggable; Tauri's injected script excludes
 * interactive descendants automatically, so the buttons do not need to opt out, and
 * double-click-to-maximize is handled for us. Aero Snap still works, because the drag
 * goes through `WM_NCLBUTTONDOWN(HTCAPTION)` rather than moving the window by hand.
 */
export function TitleBar({
  workspace,
  appearance,
  onAppearance,
}: {
  workspace: Workspace | null;
  appearance: Appearance;
  onAppearance: (next: Appearance) => void;
}) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void windowChrome.isMaximized().then((value) => {
      if (!cancelled) setMaximized(value);
    });
    // Subscribed rather than tracked locally: a Win+Arrow snap or a double-click on the
    // drag region changes this without our buttons ever being pressed.
    void windowChrome.onMaximizedChange((value) => {
      if (!cancelled) setMaximized(value);
    }).then((off) => {
      if (cancelled) off();
      else unlisten = off;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const parent = workspace ? parentOf(workspace.root) : null;
  const dark = appearance === "dark";

  return (
    <header className="titlebar" data-tauri-drag-region="deep">
      <span className="titlebar-mark">agentide</span>

      <span className="titlebar-title" title={workspace?.root}>
        {workspace ? (
          <>
            {parent && <span className="titlebar-parent">{parent}/</span>}
            <span className="titlebar-workspace">{workspace.name}</span>
          </>
        ) : (
          <span className="titlebar-parent">no folder open</span>
        )}
      </span>

      <div className="titlebar-actions">
        <button
          type="button"
          className="win-button"
          title={`Appearance: ${appearance}`}
          aria-label={`Appearance: ${appearance}. Click to change.`}
          onClick={() => onAppearance(nextAppearance(appearance))}
        >
          <IconTheme dark={dark} />
        </button>
        <button
          type="button"
          className="win-button"
          aria-label="Minimize"
          onClick={() => void windowChrome.minimize()}
        >
          <IconMinimize />
        </button>
        <button
          type="button"
          className="win-button"
          aria-label={maximized ? "Restore" : "Maximize"}
          onClick={() => void windowChrome.toggleMaximize()}
        >
          {maximized ? <IconRestore /> : <IconMaximize />}
        </button>
        <button
          type="button"
          className="win-button is-close"
          aria-label="Close"
          onClick={() => void windowChrome.close()}
        >
          <IconClose />
        </button>
      </div>
    </header>
  );
}

/** system → light → dark → system. Three states, so "follow the OS" stays reachable. */
function nextAppearance(current: Appearance): Appearance {
  if (current === "system") return "light";
  if (current === "light") return "dark";
  return "system";
}
