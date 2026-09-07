/**
 * The picker's grouping rules.
 *
 * Each case is a way the menu was wrong before: two rows meaning "default", a version
 * choice that disappeared once the catalogue arrived, and an alias that would not say
 * which model it was.
 */

import { describe, expect, test } from "vitest";

import { decodeModel, modelLabel, modelMenu, PINNED_MODELS, providerValue } from "./model-menu";
import type { ModelInfo, ProviderInfo } from "./protocol";

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

describe("configured backends", () => {
  const qwen: ProviderInfo = {
    key: "qwen-local",
    models: [{ id: "qwen3-coder-30b", name: "Qwen3 Coder 30B", supportsEffort: false }],
    start: "llama-server -m qwen3.gguf --port 8080",
    host: "127.0.0.1",
    port: 8080,
  };

  test("appear as their own group, under the Anthropic ones", () => {
    const menu = modelMenu(CATALOGUE, [qwen]);
    expect(menu.providers).toHaveLength(1);
    expect(menu.providers[0]?.items[0]?.displayName).toBe("Qwen3 Coder 30B");
  });

  test("appear before the first turn too, because they came from a file", () => {
    // The Anthropic list is provisional until a query has been run. A backend is not: it
    // was read off disk, so it is as true now as it will ever be.
    const menu = modelMenu([], [qwen]);
    expect(menu.known).toBe(false);
    expect(menu.providers).toHaveLength(1);
    expect(menu.all.map((entry) => entry.value)).toContain("qwen-local::qwen3-coder-30b");
  });

  test("carry the backend and the model in one value", () => {
    // Two providers can both offer `qwen3-coder-30b` and mean different files, so a model
    // id alone cannot say which one was picked.
    const menu = modelMenu(CATALOGUE, [qwen]);
    expect(menu.providers[0]?.items[0]?.value).toBe("qwen-local::qwen3-coder-30b");
  });

  test("say where they are, so two backends are distinguishable", () => {
    expect(modelMenu(CATALOGUE, [qwen]).providers[0]?.items[0]?.description).toBe(
      "qwen-local · 127.0.0.1:8080",
    );
  });

  test("the group label is the key alone, however long the note is", () => {
    // A native optgroup label does not wrap, so a sentence there stretches the menu to the
    // width of the sentence and draws as a grey band with the text lost inside it.
    const menu = modelMenu(CATALOGUE, [
      { ...qwen, note: "older, small, and reliable at tool calls — the safe first try" },
    ]);
    expect(menu.providers[0]?.label).toBe("qwen-local");
  });

  test("the note becomes the option's tooltip instead", () => {
    const menu = modelMenu(CATALOGUE, [{ ...qwen, note: "needs 64K context" }]);
    expect(menu.providers[0]?.items[0]?.description).toBe("needs 64K context · 127.0.0.1:8080");
  });

  test("effort follows what the provider declared", () => {
    // Almost always false: effort is an Anthropic concept, and RunControls hides the
    // control entirely rather than offering one the backend ignores.
    expect(modelMenu(CATALOGUE, [qwen]).providers[0]?.items[0]?.supportsEffort).toBe(false);
  });

  test("none configured is simply no groups", () => {
    expect(modelMenu(CATALOGUE, []).providers).toEqual([]);
  });
});

describe("decoding a selection", () => {
  test("an Anthropic model has no provider", () => {
    expect(decodeModel("claude-opus-5")).toEqual({ model: "claude-opus-5" });
  });

  test("a backend's model carries both halves", () => {
    expect(decodeModel("qwen-local::qwen3-coder-30b")).toEqual({
      provider: "qwen-local",
      model: "qwen3-coder-30b",
    });
  });

  test("the default is neither", () => {
    // Which is exactly what an absent `provider` and an absent `model` mean on the wire,
    // so it travels unchanged.
    expect(decodeModel(null)).toEqual({});
    expect(decodeModel("")).toEqual({});
  });

  test("a model id containing a colon still round-trips", () => {
    // `qwen3:30b` is how several runtimes name a tag, and one colon is not the separator.
    expect(decodeModel(providerValue("local", "qwen3:30b"))).toEqual({
      provider: "local",
      model: "qwen3:30b",
    });
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
