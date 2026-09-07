/**
 * Which files are open in the editor, and which one you are looking at.
 *
 * The editor is one Monaco instance with a model per path, so a tab is not a second
 * editor -- it is a name in a list and a model swap. That makes the list the whole
 * feature, and the list has rules that are easy to get subtly wrong, so they live here
 * where a test can hold them rather than inside a component.
 *
 * Two of them are worth stating outright, because both were the reason tabs were worth
 * building at all:
 *
 * The order never changes once a file is in it. A strip that reorders on selection means
 * the tab you want is somewhere new every time you look, and muscle memory never forms --
 * the reason "most recently used" ordering keeps being tried and keeps being removed.
 *
 * A background open does not steal the view. The agent opens files as it edits them, and
 * that is useful precisely because you can carry on reading what you were reading. Before
 * tabs it could only replace your file, which made the good feature the fastest way to
 * lose your place.
 */

import type { WirePath } from "./protocol";

export interface Tabs {
  /** Open files, in the order they were opened. Never reordered. */
  readonly open: readonly WirePath[];
  /** The one on screen. `null` only when nothing is open. */
  readonly active: WirePath | null;
}

export const NO_TABS: Tabs = { open: [], active: null };

/**
 * Open a file, or focus it if it is already open.
 *
 * `background` is what the agent's own opens use: the tab appears so you can get to it,
 * and the file you are reading stays in front of you. It is ignored when nothing is open
 * yet -- there is no view to protect, and an empty editor beside a tab strip with one
 * unopened tab in it is just broken.
 */
export function openTab(tabs: Tabs, path: WirePath, background = false): Tabs {
  if (tabs.open.includes(path)) {
    // Already there: focus it, and leave the order alone.
    return background || tabs.active === path ? tabs : { ...tabs, active: path };
  }
  const open = [...tabs.open, path];
  const keepView = background && tabs.active !== null;
  return { open, active: keepView ? tabs.active : path };
}

/**
 * Close one tab and pick what to look at next.
 *
 * The neighbour to the right, falling back to the left when the last tab was closed --
 * which is what every editor does, and what the hand expects when closing several in a
 * row from the same spot.
 */
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

/**
 * The tab one step away, for keyboard cycling. Wraps, because a cycle that stops at the
 * end is a cycle you have to look at to use.
 */
export function neighbourTab(tabs: Tabs, step: 1 | -1): WirePath | null {
  if (tabs.open.length === 0) return null;
  const index = tabs.active ? tabs.open.indexOf(tabs.active) : -1;
  if (index < 0) return tabs.open[0] ?? null;
  const next = (index + step + tabs.open.length) % tabs.open.length;
  return tabs.open[next] ?? null;
}
