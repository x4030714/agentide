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

const { readTunedPrompt, readPromptAppend, AUTISM_PROMPT } = await import("./promptmode");

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

describe("autism mode", () => {
  it("adds the shape rules on top of the tuned prompt, not instead of it", async () => {
    // The machine facts are as true in this mode as any other. A mode that dropped them
    // to change tone would trade correctness for formatting.
    files.set(USER, "no rust-src on this machine");

    const append = await readPromptAppend("autism", "C:/work/thing" as never);

    expect(append).toContain("no rust-src on this machine");
    expect(append).toContain("How to write the answer");
    expect(append!.indexOf("no rust-src")).toBeLessThan(append!.indexOf("How to write"));
  });

  it("still applies when there is no system.md at all", async () => {
    // Unlike Tuned, this mode is defined by a constant, so it can never be the option that
    // silently does nothing.
    expect(await readPromptAppend("autism", null)).toBe(AUTISM_PROMPT);
  });

  it("changes how the answer is written and nothing about the work", async () => {
    // The line CLAUDE.md draws: latency and tokens come out of the harness, never out of
    // the model. A shape rule that capped effort or skipped a check would be the wrong
    // trade wearing the right label.
    const text = AUTISM_PROMPT.toLowerCase();
    for (const forbidden of ["skip", "don't check", "do not verify", "fewer tool", "shorter search"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).toContain("think exactly as hard");
  });

  it("is short enough to be re-read every turn", async () => {
    // A long instruction about being brief is self-refuting, and on a local backend the
    // whole prefix is reprocessed on every single turn.
    expect(AUTISM_PROMPT.split("\n").length).toBeLessThanOrEqual(40);
  });

  it("stock mode still sends nothing", async () => {
    files.set(USER, "machine facts");
    expect(await readPromptAppend("default", null)).toBeNull();
  });

  it("tuned mode is unchanged by the new option", async () => {
    files.set(USER, "machine facts");
    expect(await readPromptAppend("tuned", null)).toBe("machine facts");
  });
});
