import { beforeEach, describe, expect, it } from "vitest";

import { forgetOrder, inOrder } from "./in-order";

beforeEach(() => {
  forgetOrder("term");
  forgetOrder("other");
});

/** Resolves after `ms`, recording when it started and finished. */
function step(log: string[], name: string, ms: number) {
  return () =>
    new Promise<string>((resolve) => {
      log.push(`${name} start`);
      setTimeout(() => {
        log.push(`${name} end`);
        resolve(name);
      }, ms);
    });
}

describe("ordering calls that share a key", () => {
  it("runs them one after another, however long the first takes", async () => {
    // The terminal case: spawn, kill, spawn for one id. Unordered, the kill reaches the
    // session the second spawn just registered and the shell comes up dead.
    const log: string[] = [];
    const spawn1 = inOrder("term", step(log, "spawn1", 20));
    const kill = inOrder("term", step(log, "kill", 0));
    const spawn2 = inOrder("term", step(log, "spawn2", 0));
    await Promise.all([spawn1, kill, spawn2]);

    expect(log).toEqual([
      "spawn1 start",
      "spawn1 end",
      "kill start",
      "kill end",
      "spawn2 start",
      "spawn2 end",
    ]);
  });

  it("does not order calls for different keys against each other", async () => {
    // Two terminals must not wait on one another; the queue is per id, not global.
    const log: string[] = [];
    await Promise.all([
      inOrder("term", step(log, "slow", 20)),
      inOrder("other", step(log, "fast", 0)),
    ]);
    expect(log.indexOf("fast end")).toBeLessThan(log.indexOf("slow end"));
  });

  it("keeps running after one call rejects", async () => {
    // A shell that fails to start must not strand every later call for that terminal.
    const failed = inOrder("term", () => Promise.reject(new Error("no pty")));
    await expect(failed).rejects.toThrow("no pty");
    await expect(inOrder("term", () => Promise.resolve("still here"))).resolves.toBe("still here");
  });

  it("gives each caller its own result", async () => {
    const [a, b] = await Promise.all([
      inOrder("term", () => Promise.resolve("a")),
      inOrder("term", () => Promise.resolve("b")),
    ]);
    expect([a, b]).toEqual(["a", "b"]);
  });
});
