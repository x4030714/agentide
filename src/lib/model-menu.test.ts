/**
 * The picker's grouping rules.
 *
 * Each case is a way the menu was wrong before: two rows meaning "default", a version
 * choice that disappeared once the catalogue arrived, and an alias that would not say
 * which model it was.
 */

import { describe, expect, test } from "vitest";

import { modelLabel, modelMenu, PINNED_MODELS } from "./model-menu";
import type { ModelInfo } from "./protocol";

/** The shape the SDK publishes: aliases, and a default row of its own. */
const CATALOGUE: ModelInfo[] = [
  { value: "default", displayName: "Default (recommended)", description: "" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "" },
  { value: "fable", resolvedModel: "claude-fable-5-1", displayName: "Fable", description: "" },
  { value: "opus", resolvedModel: "claude-opus-5", displayName: "Opus", description: "" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku", description: "" },
];

describe("before the first turn", () => {
  test("the pinned ids are the whole menu", () => {
    const menu = modelMenu([]);
    expect(menu.known).toBe(false);
    expect(menu.catalogue).toEqual([]);
    expect(menu.pinned).toEqual(PINNED_MODELS);
    expect(menu.all).toEqual(PINNED_MODELS);
  });

  test("both Opus versions are selectable", () => {
    const values = modelMenu([]).all.map((entry) => entry.value);
    expect(values).toContain("claude-opus-5");
    expect(values).toContain("claude-opus-4-8");
  });
});

describe("once the catalogue arrives", () => {
  test("its default row is dropped, because the empty option already means that", () => {
    const menu = modelMenu(CATALOGUE);
    expect(menu.catalogue.map((entry) => entry.value)).not.toContain("default");
    expect(menu.catalogue.map((entry) => entry.displayName)).not.toContain("Default (recommended)");
  });

  test("an empty-valued row is dropped for the same reason", () => {
    const menu = modelMenu([{ value: "", displayName: "Default", description: "" }, ...CATALOGUE]);
    expect(menu.catalogue.every((entry) => entry.value !== "")).toBe(true);
  });

  test("the installation's own entries survive, in its order", () => {
    expect(modelMenu(CATALOGUE).catalogue.map((entry) => entry.value)).toEqual([
      "sonnet",
      "fable",
      "opus",
      "haiku",
    ]);
  });

  test("the version choice is not lost to the aliases", () => {
    // The whole point: the catalogue offers "Opus" and cannot say which one, so pinning
    // has to stay reachable after the first turn rather than only before it.
    const menu = modelMenu(CATALOGUE);
    expect(menu.pinned.map((entry) => entry.value)).toContain("claude-opus-5");
    expect(menu.pinned.map((entry) => entry.value)).toContain("claude-opus-4-8");
    expect(menu.all.map((entry) => entry.value)).toContain("opus");
  });

  test("a pinned id the catalogue already offers is not listed twice", () => {
    const menu = modelMenu([
      ...CATALOGUE,
      { value: "claude-opus-5", displayName: "Opus 5", description: "" },
    ]);
    const opusFive = menu.all.filter((entry) => entry.value === "claude-opus-5");
    expect(opusFive).toHaveLength(1);
    // And the installation's own row is the one kept, not ours.
    expect(menu.catalogue.some((entry) => entry.value === "claude-opus-5")).toBe(true);
    expect(menu.pinned.some((entry) => entry.value === "claude-opus-5")).toBe(false);
  });

  test("a catalogue of nothing but a default row still offers the pinned ids", () => {
    const menu = modelMenu([{ value: "default", displayName: "Default", description: "" }]);
    expect(menu.known).toBe(true);
    expect(menu.catalogue).toEqual([]);
    expect(menu.pinned).toEqual(PINNED_MODELS);
  });
});

describe("how a row reads", () => {
  test("an alias says which model it resolves to", () => {
    expect(modelLabel(CATALOGUE[3]!)).toBe("Opus — claude-opus-5");
  });

  test("a pinned id does not repeat itself", () => {
    expect(modelLabel({ value: "claude-opus-4-8", displayName: "Opus 4.8", description: "" })).toBe(
      "Opus 4.8",
    );
  });

  test("a row whose resolved id equals its value says it once", () => {
    expect(
      modelLabel({
        value: "claude-opus-5",
        resolvedModel: "claude-opus-5",
        displayName: "Opus 5",
        description: "",
      }),
    ).toBe("Opus 5");
  });
});
