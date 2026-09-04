import { useEffect, useState } from "react";

import { windowChrome } from "../lib/bridge";
import { IconClose, IconMaximize, IconMinimize, IconRestore, IconTheme } from "../lib/icons";
import { parentOf } from "../lib/protocol";
import type { Workspace } from "../lib/protocol";
import type { Appearance } from "../lib/appearance";
import { PALETTES, applyPalette, storedPalette } from "../lib/palette";
import type { Palette } from "../lib/palette";

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
  const [palette, setPalette] = useState<Palette>(storedPalette);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Applied on mount as well as on change, so a remembered palette is on screen before
  // the first paint rather than flashing the default first.
  useEffect(() => {
    applyPalette(palette);
  }, [palette]);

  // A click anywhere else closes it. Attached only while open, so the app is not
  // listening to every click in order to support a menu nobody has opened.
  useEffect(() => {
    if (!pickerOpen) return;
    const close = () => setPickerOpen(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [pickerOpen]);

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
        {/* Not a cycling button like appearance: four options with names need a list,
            and a button that cycles through unnamed palettes is a guessing game. */}
        <div className="palette-picker" onPointerDown={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="win-button"
            title={`Palette: ${PALETTES.find((p) => p.id === palette)?.label}`}
            aria-label="Colour palette"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((open) => !open)}
          >
            <span className="palette-swatch" aria-hidden="true" />
          </button>
          {pickerOpen && (
            <div className="palette-menu" role="menu">
              {PALETTES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={option.id === palette}
                  className={`palette-option${option.id === palette ? " is-on" : ""}`}
                  onClick={() => {
                    setPalette(option.id);
                    setPickerOpen(false);
                  }}
                >
                  <span className={`palette-chip is-${option.id}`} aria-hidden="true" />
                  <span className="palette-label">{option.label}</span>
                  <span className="palette-note">{option.note}</span>
                </button>
              ))}
            </div>
          )}
        </div>
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
