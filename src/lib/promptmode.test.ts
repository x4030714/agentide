import { beforeEach, describe, expect, it, vi } from "vitest";

// The roster's source as text, the way `ide-tool-names.test.ts` reads the sidecar: `?raw`
// keeps the Agent SDK out of a frontend test that only needs the names.
import advancedSource from "../../sidecar/src/advanced.ts?raw";

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

const {
  readTunedPrompt,
  readPromptAppend,
  isPromptMode,
  AUTISM_PROMPT,
  ADVANCED_PROMPT,
  ADVANCED_ANSWER_PROMPT,
  PROMPT_MODES,
} = await import("./promptmode");

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
    // the model. A shape rule that capped effort would be the wrong trade, right label.
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

describe("advanced mode", () => {
  it("stacks the machine facts, then method, then shape, then length", async () => {
    files.set(USER, "no rust-src on this machine");

    const append = await readPromptAppend("advanced", "C:/work/thing" as never);

    expect(append).toContain("no rust-src on this machine");
    expect(append).toContain("How to work");
    expect(append).toContain("How to write the answer");
    expect(append).toContain("Answer length");
    // Each later part is about how to report, so it must be the most recent thing said
    // about it: shape after method, and length after shape, because the shape rules allow
    // a long answer and the length rule is the one that takes that allowance away.
    expect(append!.indexOf("How to work")).toBeLessThan(append!.indexOf("How to write the answer"));
    expect(append!.indexOf("How to write the answer")).toBeLessThan(append!.indexOf("Answer length"));
  });

  it("works on a machine with no system.md, like autism mode", async () => {
    // A mode whose meaning depends on a file that may not exist silently does nothing.
    const append = await readPromptAppend("advanced", null);

    expect(append).toBe(`${ADVANCED_PROMPT}\n\n${AUTISM_PROMPT}\n\n${ADVANCED_ANSWER_PROMPT}`);
  });

  it("keeps the short-answer rules — capability is not licence to write at length", async () => {
    const append = await readPromptAppend("advanced", null);

    expect(append).toContain("Lead with the result");
  });

  it("answers are always short, and the rule is the last word on it", async () => {
    // Stated after the shape rules on purpose: those allow a long answer with a summary on
    // top, and an allowance that came later would be the one followed.
    const append = await readPromptAppend("advanced", null);

    expect(append!.trimEnd().endsWith(ADVANCED_ANSWER_PROMPT)).toBe(true);
    expect(ADVANCED_ANSWER_PROMPT).toContain("Always short");
    expect(ADVANCED_ANSWER_PROMPT).toContain("overrides the allowance for a long answer");
  });

  it("the length rule shortens the answer and nothing about the work", async () => {
    // Same line as the other two constants: latency and tokens come out of the harness,
    // never out of the model. A length rule that cut checking would be the wrong trade.
    const text = ADVANCED_ANSWER_PROMPT.toLowerCase();
    for (const forbidden of ["skip", "don't check", "do not verify", "fewer tool", "lower effort"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).toContain("never about the work");
    expect(text).toContain("think exactly as hard");
  });

  it("autism mode does not pick up the length rule", async () => {
    // Asked for on Advanced only. Autism keeps its own allowance for a long answer with a
    // summary on top.
    expect(await readPromptAppend("autism", null)).toBe(AUTISM_PROMPT);
  });

  it("spends freely on method and never on less checking", async () => {
    // Same line as autism mode, from the other direction: this one may cost anything, so
    // the thing to guard is that it does not buy speed with a worse answer.
    const text = ADVANCED_PROMPT.toLowerCase();
    for (const banned of ["skip", "truncate", "lower effort", "fewer tokens", "smaller model"]) {
      expect(text).not.toContain(banned);
    }
    expect(text).toContain("ide-architect, ide-implementer, ide-reviewer, ide-validator");
  });

  it("names exactly the agents the sidecar defines, no more and no fewer", () => {
    // The prompt is here and the roster is in the sidecar, so renaming one without the
    // other fails nowhere else. A prompt that names an agent the roster lacks sends the
    // model to delegate to nothing; a roster agent the prompt never names is never used.
    const defined = [...advancedSource.matchAll(/^\s*"(ide-[a-z]+)":\s*\{/gm)].map((m) => m[1]);
    const named = [...new Set(ADVANCED_PROMPT.match(/\bide-[a-z]+\b/g) ?? [])];
    expect(defined.length).toBe(4);
    expect(named.sort()).toEqual([...defined].sort());
  });

  it("is restored from a saved choice rather than falling back to stock", async () => {
    // The guard, not the list, is what reads the stored value on launch. A mode missing
    // from it comes back as Stock without a word.
    for (const mode of PROMPT_MODES) expect(isPromptMode(mode)).toBe(true);
    expect(isPromptMode("advanced")).toBe(true);
    expect(isPromptMode("Advanced")).toBe(false);
  });
});
