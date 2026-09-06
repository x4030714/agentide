import { beforeEach, describe, expect, it, vi } from "vitest";

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
}));

const { readTunedPrompt } = await import("./promptmode");

const USER = "C:/Users/tung/.agentide/system.md";
const PROJECT = "C:/work/thing/.agentide/system.md";

beforeEach(() => files.clear());

describe("the tuned prompt", () => {
  it("applies in a workspace that has no file of its own", async () => {
    // The whole point: what it says is true of the machine, not of one folder.
    files.set(USER, "no rust-src on this machine");

    expect(await readTunedPrompt("C:/work/thing" as never)).toBe("no rust-src on this machine");
  });

  it("applies with no workspace open at all", async () => {
    files.set(USER, "machine facts");

    expect(await readTunedPrompt(null)).toBe("machine facts");
  });

  it("lets a project add to the machine's rather than replace it", async () => {
    files.set(USER, "machine facts");
    files.set(PROJECT, "this codebase is C++");

    expect(await readTunedPrompt("C:/work/thing" as never)).toBe(
      "machine facts\n\nthis codebase is C++",
    );
  });

  it("sends the same text once when both files hold it", async () => {
    // Two copies double the tokens and read as deliberate repetition.
    files.set(USER, "same words");
    files.set(PROJECT, "same words");

    expect(await readTunedPrompt("C:/work/thing" as never)).toBe("same words");
  });

  it("is null when neither file exists, so Tuned can say it adds nothing", async () => {
    expect(await readTunedPrompt("C:/work/thing" as never)).toBeNull();
  });
});
