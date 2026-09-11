import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { storedLayout } from "./layout";

/**
 * These tests run in node, where there is no `localStorage`. A stub rather than pulling in a
 * DOM: the function under test reads one key, and the case worth covering is what it does
 * with what comes back.
 */
const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("which layout the window opens in", () => {
  it("is the workbench unless the other was chosen", () => {
    // The IDE is what this app is; Basic is the departure from it.
    expect(storedLayout()).toBe("workbench");
  });

  it("remembers Basic", () => {
    store.set("agentide.layout", "basic");
    expect(storedLayout()).toBe("basic");
  });

  it("falls back rather than trusting whatever is in storage", () => {
    // A value from a future version, or a hand-edited one, must not leave the window in a
    // shape nothing renders.
    store.set("agentide.layout", "zen-mode");
    expect(storedLayout()).toBe("workbench");
  });

  it("survives a context that refuses storage entirely", () => {
    // A private window throws on access rather than returning null.
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem() {
        throw new Error("storage is disabled");
      },
    };
    expect(storedLayout()).toBe("workbench");
  });
});
