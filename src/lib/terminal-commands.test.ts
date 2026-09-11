import { describe, expect, it } from "vitest";

import { ownedCommand } from "./terminal-commands";

describe("which commands this window answers for itself", () => {
  it("sends everything else to the CLI, which answers its own", () => {
    // Measured, not assumed: `/usage` through the SDK as prompt text came back as the panel
    // with cost 0 and turns 0. The CLI intercepts it; no model call happens. A version of
    // this file that ran these in a terminal tab broke a feature that already worked.
    for (const name of ["usage", "config", "mcp", "doctor", "insights", "context", "compact"]) {
      expect(ownedCommand(name)).toBeNull();
    }
  });

  it("sends a skill to the model, because a skill is a prompt", () => {
    for (const name of ["impeccable", "dataviz", "verify", "simplify", "security-review"]) {
      expect(ownedCommand(name)).toBeNull();
    }
  });

  it("refuses the ones that would change what this window is showing", () => {
    // `/clear` is the sharp one: it empties the CLI's history while the transcript goes on
    // showing it, so the model has forgotten a conversation you can still read.
    expect(ownedCommand("clear")).toBeTruthy();
    // Not compact: the transcript draws the boundary, so the window and the model agree
    // after it, and it is the one command that shrinks an oversized conversation now.
    expect(ownedCommand("compact")).toBeNull();
    expect(ownedCommand("model")).toBeTruthy();
    expect(ownedCommand("effort")).toBeTruthy();
    expect(ownedCommand("fast")).toBeTruthy();
  });

  it("names what does the job here, so the notice can be acted on", () => {
    expect(ownedCommand("clear")).toContain("New");
    expect(ownedCommand("model")).toContain("Model");
    expect(ownedCommand("effort")).toContain("Effort");
  });
});
