/** Which files are open, and which one you are looking at. Two rules the strip lives by:
 * the order never changes once a file is in it, and a background open never steals the view. */

import type { WirePath } from "./protocol";

export interface Tabs {
  /** Open files, in the order they were opened. Never reordered. */
  readonly open: readonly WirePath[];
  /** The one on screen. `null` only when nothing is open. */
  readonly active: WirePath | null;
}

export const NO_TABS: Tabs = { open: [], active: null };

/** Open a file, or focus it if it is already open. `background` is what the agent's own
 * opens use; it is ignored when nothing is open yet, as there is no view to protect. */
export function openTab(tabs: Tabs, path: WirePath, background = false): Tabs {
  if (tabs.open.includes(path)) {
    // Already there: focus it, and leave the order alone.
    return background || tabs.active === path ? tabs : { ...tabs, active: path };
  }
  const open = [...tabs.open, path];
  const keepView = background && tabs.active !== null;
  return { open, active: keepView ? tabs.active : path };
}

/** Close one tab and pick what to look at next: the neighbour to the right, falling back to
 * the left — what the hand expects when closing several in a row from the same spot. */
export function closeTab(tabs: Tabs, path: WirePath): Tabs {
  const index = tabs.open.indexOf(path);
  if (index < 0) return tabs;
  const open = tabs.open.filter((entry) => entry !== path);
  if (tabs.active !== path) {
    // Closing something you were not looking at does not move you.
    return { open, active: tabs.active };
  }
  const next = open[index] ?? open[index - 1] ?? null;
  return { open, active: next };
}

/** Look at a tab that is already open. A path that is not open is ignored. */
export function selectTab(tabs: Tabs, path: WirePath): Tabs {
  if (!tabs.open.includes(path) || tabs.active === path) return tabs;
  return { ...tabs, active: path };
}

/** The tab one step away, for keyboard cycling. Wraps, because a cycle that stops at the
 * end is a cycle you have to look at to use. */
export function neighbourTab(tabs: Tabs, step: 1 | -1): WirePath | null {
  if (tabs.open.length === 0) return null;
  const index = tabs.active ? tabs.open.indexOf(tabs.active) : -1;
  if (index < 0) return tabs.open[0] ?? null;
  const next = (index + step + tabs.open.length) % tabs.open.length;
  return tabs.open[next] ?? null;
}
