import { useCallback, useEffect, useState } from "react";

import { windowChrome } from "./bridge";

/**
 * Appearance, the way a Mac app does it: follow the system by default, with an explicit
 * override that wins in both directions.
 *
 * `system` is a real third state, not the absence of a choice — it is why the app tracks
 * the OS setting live rather than reading it once at launch.
 */
export type Appearance = "system" | "light" | "dark";

const KEY = "agentide.appearance";

function stored(): Appearance {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

/**
 * Drives two attributes on the document element:
 *
 * - `data-theme` — the explicit override, absent while following the system, which is
 *   what lets `world.css` express "system dark unless light was chosen" in plain CSS.
 * - `data-effect` — whether the window's translucency actually applied. This one is not
 *   cosmetic: the window is `transparent: true`, so if the blur fails we are clear glass
 *   over the desktop, not an opaque window. `off` swaps the surfaces to solid.
 */
export function useAppearance(): [Appearance, (next: Appearance) => void] {
  const [appearance, setAppearance] = useState<Appearance>(stored);

  useEffect(() => {
    const root = document.documentElement;
    if (appearance === "system") root.removeAttribute("data-theme");
    else root.dataset.theme = appearance;
    try {
      if (appearance === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, appearance);
    } catch {
      /* A context that refuses storage still gets the choice for this session. */
    }
  }, [appearance]);

  useEffect(() => {
    let cancelled = false;
    windowChrome
      .effectActive()
      .then((active) => {
        if (!cancelled) document.documentElement.dataset.effect = active ? "on" : "off";
      })
      .catch(() => {
        // Unknown means we cannot promise a backdrop, so assume none and paint solid.
        if (!cancelled) document.documentElement.dataset.effect = "off";
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const set = useCallback((next: Appearance) => setAppearance(next), []);
  return [appearance, set];
}

/** What is actually on screen right now, override or system. */
export function resolvedAppearance(appearance: Appearance): "light" | "dark" {
  if (appearance !== "system") return appearance;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * What is on screen right now, tracked live.
 *
 * Watches two sources, because either can change without the other: the OS setting
 * (while following it) and our own `data-theme` attribute (when the override moves).
 * Reading `matchMedia` once at mount would leave the editor on the wrong theme the
 * moment Windows switches at sunset.
 */
export function useResolvedAppearance(): "light" | "dark" {
  const [resolved, setResolved] = useState<"light" | "dark">(() =>
    resolvedAppearance(stored()),
  );

  useEffect(() => {
    const root = document.documentElement;
    const read = () => {
      const attr = root.dataset.theme;
      const next =
        attr === "light" || attr === "dark"
          ? attr
          : window.matchMedia?.("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light";
      setResolved(next);
    };

    read();
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener("change", read);
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      media?.removeEventListener("change", read);
      observer.disconnect();
    };
  }, []);

  return resolved;
}
