import { useEffect, useState } from "react";

import { windowChrome } from "../lib/bridge";
import {
  IconClose,
  IconMaximize,
  IconMinimize,
  IconPalette,
  IconRestore,
  IconSettings,
  IconTheme,
} from "../lib/icons";
import { parentOf } from "../lib/protocol";
import type { Workspace } from "../lib/protocol";
import type { Appearance } from "../lib/appearance";
import { PALETTES } from "../lib/palette";
import type { Palette } from "../lib/palette";
import type { Transparency } from "../lib/transparency";

/**
 * Our own title bar, since the OS frame is gone. `data-tauri-drag-region` keeps Aero Snap and
 * double-click-to-maximize working, and excludes interactive descendants for us.
 */
export function TitleBar({
  workspace,
  appearance,
  onAppearance,
  palette,
  onPalette,
  transparency,
  onTransparency,
  onSettings,
}: {
  workspace: Workspace | null;
  appearance: Appearance;
  onAppearance: (next: Appearance) => void;
  palette: Palette;
  onPalette: (next: Palette) => void;
  transparency: Transparency;
  onTransparency: (next: Transparency) => void;
  onSettings: () => void;
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
  const [pickerOpen, setPickerOpen] = useState(false);

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
        {/* A list, not a cycling button: cycling nine unnamed palettes is a guessing game. */}
        <div className="palette-picker" onPointerDown={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="win-button"
            title={`Palette: ${PALETTES.find((p) => p.id === palette)?.label}`}
            aria-label="Colour palette"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((open) => !open)}
          >
            <IconPalette id={palette} size={13} />
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
                    onPalette(option.id);
                    setPickerOpen(false);
                  }}
                >
                  <span className={`palette-chip is-${option.id}`}>
                    <IconPalette id={option.id} />
                  </span>
                  <span className="palette-label">{option.label}</span>
                  <span className="palette-note">{option.note}</span>
                </button>
              ))}
              {/* Not a palette -- hence the rule above -- but a third title bar icon for one
                  switch would cost more chrome than it saves. */}
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={transparency === "solid"}
                className={`palette-option palette-solid${
                  transparency === "solid" ? " is-on" : ""
                }`}
                onClick={() => {
                  onTransparency(transparency === "solid" ? "glass" : "solid");
                  setPickerOpen(false);
                }}
              >
                <span className="palette-chip" />
                <span className="palette-label">Solid background</span>
                <span className="palette-note">No blur, no translucency. Flat panes.</span>
              </button>
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
          title="Settings (Ctrl+,)"
          aria-label="Settings"
          onClick={onSettings}
        >
          <IconSettings />
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
