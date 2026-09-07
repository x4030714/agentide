/**
 * The tab list's rules.
 *
 * Each case is a way a tab strip is annoying to use rather than a way it crashes: tabs
 * that reorder under the pointer, an agent's edit stealing the file you were reading, a
 * close that drops you somewhere unrelated.
 */

import { describe, expect, test } from "vitest";

import { closeTab, neighbourTab, NO_TABS, openTab, selectTab } from "./tabs";
import type { Tabs } from "./tabs";
import type { WirePath } from "./protocol";

const a = "C:/work/a.rs" as WirePath;
const b = "C:/work/b.rs" as WirePath;
const c = "C:/work/c.rs" as WirePath;

/** Three open, looking at the middle one. */
function three(): Tabs {
  return { open: [a, b, c], active: b };
}

describe("opening", () => {
  test("the first file opens and is looked at", () => {
    expect(openTab(NO_TABS, a)).toEqual({ open: [a], active: a });
  });

  test("a new file is added at the end and focused", () => {
    expect(openTab({ open: [a], active: a }, b)).toEqual({ open: [a, b], active: b });
  });

  test("opening a file that is already open focuses it without moving it", () => {
    // The order never changes: a strip that reorders on selection puts the tab you want
    // somewhere new every time you look at it.
    expect(openTab(three(), a)).toEqual({ open: [a, b, c], active: a });
  });

  test("re-opening the file you are on changes nothing at all", () => {
    const tabs = three();
    expect(openTab(tabs, b)).toBe(tabs);
  });
});

describe("a background open, which is what the agent's edits use", () => {
  test("adds the tab without taking the view", () => {
    expect(openTab({ open: [a], active: a }, b, true)).toEqual({ open: [a, b], active: a });
  });

  test("does not move you when the file is already open", () => {
    expect(openTab(three(), c, true)).toEqual({ open: [a, b, c], active: b });
  });

  test("still opens in front when nothing is open, since there is no view to protect", () => {
    expect(openTab(NO_TABS, a, true)).toEqual({ open: [a], active: a });
  });
});

describe("closing", () => {
  test("closing the active tab moves to its right neighbour", () => {
    expect(closeTab(three(), b)).toEqual({ open: [a, c], active: c });
  });

  test("closing the last tab falls back to the left", () => {
    expect(closeTab({ open: [a, b, c], active: c }, c)).toEqual({ open: [a, b], active: b });
  });

  test("closing one you were not looking at leaves you where you are", () => {
    expect(closeTab(three(), a)).toEqual({ open: [b, c], active: b });
  });

  test("closing the only tab leaves nothing open", () => {
    expect(closeTab({ open: [a], active: a }, a)).toEqual({ open: [], active: null });
  });

  test("closing a file that is not open is ignored", () => {
    const tabs = three();
    expect(closeTab(tabs, "C:/work/never.rs" as WirePath)).toBe(tabs);
  });

  test("closing several from the same spot keeps working rightwards", () => {
    // The hand stays still and the tabs come to it, which is the point of the rule above.
    let tabs: Tabs = { open: [a, b, c], active: a };
    tabs = closeTab(tabs, a);
    expect(tabs.active).toBe(b);
    tabs = closeTab(tabs, b);
    expect(tabs.active).toBe(c);
  });
});

describe("selecting", () => {
  test("moves to an open tab", () => {
    expect(selectTab(three(), c)).toEqual({ open: [a, b, c], active: c });
  });

  test("ignores a file that is not open", () => {
    const tabs = three();
    expect(selectTab(tabs, "C:/work/never.rs" as WirePath)).toBe(tabs);
  });
});

describe("cycling", () => {
  test("goes forwards and wraps", () => {
    expect(neighbourTab(three(), 1)).toBe(c);
    expect(neighbourTab({ open: [a, b, c], active: c }, 1)).toBe(a);
  });

  test("goes backwards and wraps", () => {
    expect(neighbourTab(three(), -1)).toBe(a);
    expect(neighbourTab({ open: [a, b, c], active: a }, -1)).toBe(c);
  });

  test("has nowhere to go with nothing open", () => {
    expect(neighbourTab(NO_TABS, 1)).toBeNull();
  });

  test("a single tab cycles to itself rather than to nothing", () => {
    expect(neighbourTab({ open: [a], active: a }, 1)).toBe(a);
  });
});
