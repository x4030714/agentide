import { useCallback, useEffect, useState } from "react";

/** Appearance the way a Mac app does it: follow the system by default, explicit override
 * wins. `system` is a real third state, which is why the OS setting is tracked live. */
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

/** Drives `data-theme`: absent while following the system, which is what lets `world.css`
 * say "system dark unless light was chosen". `data-effect` belongs to `useTransparency`. */
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

  const set = useCallback((next: Appearance) => setAppearance(next), []);
  return [appearance, set];
}

/** What is actually on screen right now, override or system. */
export function resolvedAppearance(appearance: Appearance): "light" | "dark" {
  if (appearance !== "system") return appearance;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** What is on screen right now, tracked live. Watches the OS setting and our own
 * `data-theme`, since either moves without the other — read once and sunset breaks it. */
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
