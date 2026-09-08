import { useEffect, useState } from "react";

import { windowChrome } from "./bridge";

/** Glass or a solid panel. Both halves move together: the panes are translucent in CSS too,
 * so `data-opaque` swaps in the flat palettes whenever the window backdrop is off. */
export type Transparency = "glass" | "solid";

const KEY = "agentide.transparency";

export function storedTransparency(): Transparency {
  try {
    return localStorage.getItem(KEY) === "solid" ? "solid" : "glass";
  } catch {
    return "glass";
  }
}

/** The setting, applied and remembered. Owns `data-effect`; it must be this hook and not
 * `useAppearance`, or two writers race to answer "is there really glass behind me". */
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
        // Asking for glass and not getting it is the worse half of the failure: the window
        // is `transparent: true`, so panes would sit over the unblurred desktop.
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
