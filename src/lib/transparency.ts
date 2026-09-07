import { useEffect, useState } from "react";

import { windowChrome } from "./bridge";

/**
 * Glass or a solid panel — the third appearance setting, and the only one that reaches
 * out of the webview.
 *
 * Turning the backdrop off is half the job. The panes are translucent in CSS as well, so
 * a solid window behind 62% surfaces just shows the window's own ground through
 * everything you read. Both halves move together here: `data-opaque="true"` swaps every
 * palette to the flat set `solve-theme.mjs` emits for exactly this, and the window is
 * told to drop mica or blur.
 *
 * Orthogonal to `Appearance` and `Palette` for the same reason those two are orthogonal
 * to each other: every palette is solved twice, glass and flat, in both modes.
 */
export type Transparency = "glass" | "solid";

const KEY = "agentide.transparency";

export function storedTransparency(): Transparency {
  try {
    return localStorage.getItem(KEY) === "solid" ? "solid" : "glass";
  } catch {
    return "glass";
  }
}

/**
 * The setting, applied and remembered.
 *
 * This owns `data-effect`, which is the app's answer to "is there really glass behind
 * me". It has to be this hook rather than `useAppearance`, because the backend's answer
 * moves when this setting does and two readers would race to write the same attribute
 * with different answers. A failed apply is not an error either: the window is opaque
 * whatever was asked for, so the flat set goes on and the app looks like a solid one.
 */
export function useTransparency(): [Transparency, (next: Transparency) => void] {
  const [transparency, setTransparency] = useState<Transparency>(storedTransparency);

  useEffect(() => {
    const root = document.documentElement;
    const solid = transparency === "solid";
    // Glass is the default and is spelled as the absence of the attribute, so the
    // palettes need no `:not()` to stay the case they were designed as.
    const opaque = (on: boolean) => {
      if (on) root.dataset.opaque = "true";
      else root.removeAttribute("data-opaque");
    };
    opaque(solid);
    try {
      if (solid) localStorage.setItem(KEY, "solid");
      else localStorage.removeItem(KEY);
    } catch {
      /* A context that refuses storage still gets the choice for this session. */
    }

    let cancelled = false;
    windowChrome
      .setBackdrop(!solid)
      .then((active) => {
        if (cancelled) return;
        root.dataset.effect = active ? "on" : "off";
        // Asking for glass and not getting it is the worse half of the failure: the
        // window is `transparent: true`, so translucent panes would then sit over the
        // unblurred desktop with nothing between. The flat set goes on regardless of
        // what was chosen -- the setting keeps saying Glass, because that is still what
        // this machine would do if it could.
        if (!active) opaque(true);
      })
      .catch(() => {
        // Unknown means we cannot promise a backdrop, so assume none and paint solid.
        if (cancelled) return;
        root.dataset.effect = "off";
        opaque(true);
      });
    return () => {
      cancelled = true;
    };
  }, [transparency]);

  return [transparency, setTransparency];
}
