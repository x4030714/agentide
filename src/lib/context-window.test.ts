import { describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: async () => "C:/Users/tung",
}));

vi.mock("./bridge", () => ({
  readFile: async (path: string) => {
    const text = files.get(path);
    if (text === undefined) throw new Error(`no such file: ${path}`);
    return { text };
  },
  writeFile: async (path: string, contents: string) => {
    files.set(path, contents);
    return { size: contents.length };
  },
}));

const { readCompactWindow, writeCompactWindow, compactChoiceFor, DEFAULT_COMPACT_WINDOW } =
  await import("./context-window");

const PATH = "C:/Users/tung/.agentide/context.json";

describe("reading the compaction point", () => {
  it("is 200k when the file does not exist", async () => {
    files.clear();
    expect(await readCompactWindow()).toBe(DEFAULT_COMPACT_WINDOW);
  });

  it("reads a configured value", async () => {
    files.set(PATH, JSON.stringify({ compactWindow: 500000 }));
    expect(await readCompactWindow()).toBe(500_000);
  });

  it("treats an explicit null as the whole window, not as absent", async () => {
    // The difference matters: `null` is someone choosing 1M on purpose, and defaulting it
    // back to 200k would silently overrule them.
    files.set(PATH, JSON.stringify({ compactWindow: null }));
    expect(await readCompactWindow()).toBeNull();
  });

  it("falls back rather than trusting a broken file", async () => {
    files.set(PATH, "{ not json");
    expect(await readCompactWindow()).toBe(DEFAULT_COMPACT_WINDOW);
    files.set(PATH, JSON.stringify({ compactWindow: "lots" }));
    expect(await readCompactWindow()).toBe(DEFAULT_COMPACT_WINDOW);
  });
});

describe("writing it", () => {
  it("keeps keys it did not put there", async () => {
    // The file is the user's; this pane is one way in, not the owner.
    files.clear();
    files.set(PATH, JSON.stringify({ somethingElse: true, compactWindow: 100000 }));
    await writeCompactWindow(500_000);
    expect(JSON.parse(files.get(PATH)!)).toEqual({ somethingElse: true, compactWindow: 500_000 });
  });

  it("creates the file when there is none", async () => {
    files.clear();
    await writeCompactWindow(null);
    expect(JSON.parse(files.get(PATH)!)).toEqual({ compactWindow: null });
  });

  it("round-trips through the reader", async () => {
    files.clear();
    await writeCompactWindow(100_000);
    expect(await readCompactWindow()).toBe(100_000);
  });
});

describe("what the control says", () => {
  it("names every choice, including the whole window", () => {
    expect(compactChoiceFor(200_000).label).toBe("200k");
    expect(compactChoiceFor(null).label).toBe("Full");
  });

  it("falls back to the default's note for a value no button has", () => {
    // A hand-edited 313k is valid to the sidecar; the panel must still render something.
    expect(compactChoiceFor(313_000).label).toBe("200k");
  });
});
