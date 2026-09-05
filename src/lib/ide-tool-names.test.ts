import { describe, expect, it } from "vitest";

// The sidecar's source, as text. `?raw` rather than an import of the module itself: that
// module pulls in the Agent SDK and a live host link, neither of which belongs in a unit
// test, and what is being checked here is the declaration, not the behaviour.
import sidecarSource from "../../sidecar/src/ide-tools.ts?raw";
import { HOST_TOOL_NAMES } from "./ide-tool-names";

/**
 * The sidecar declares the tools; this frontend answers them. Nothing in either type
 * system connects the two, and the failure when they disagree is silent and permanent:
 * the model is offered a tool whose every call returns "not available in this build".
 *
 * So the declarations themselves are the fixture.
 */
describe("ide tool names", () => {
  /** Every `tool("ide_x", …)` the sidecar builds. */
  const declared = [...sidecarSource.matchAll(/\btool\(\s*"(ide_\w+)"/g)].map((match) => match[1]);

  it("declares at least the tools this build was written against", () => {
    expect(declared.length).toBeGreaterThanOrEqual(13);
  });

  it("answers exactly the tools the sidecar declares", () => {
    expect([...HOST_TOOL_NAMES].sort()).toEqual([...declared].sort());
  });

  it("does not name the server `ide`", () => {
    // Claude Code ships its own MCP server called `ide` for editor integration. Ours used
    // that name and was shadowed by it: connected, zero tools exposed, no error on either
    // side. The model reasoned about `ide_definition`, could not find it, and quietly fell
    // back to Grep. Cost three phases of work being invisible; this line is the guard.
    const name = /IDE_SERVER_NAME = "([^"]+)"/.exec(sidecarSource)?.[1];
    expect(name).toBeTruthy();
    expect(name).not.toBe("ide");
  });

  it("declares each tool once", () => {
    expect(new Set(declared).size).toBe(declared.length);
  });

  it("keeps the routing table in sync with the declarations", () => {
    // `IDE_TOOL_NAMES` is the sidecar's own copy of the list; it drifts the same way.
    const table = /IDE_TOOL_NAMES = \[([^\]]*)\]/.exec(sidecarSource)?.[1] ?? "";
    const listed = [...table.matchAll(/"(ide_\w+)"/g)].map((match) => match[1]);
    expect(listed.sort()).toEqual([...declared].sort());
  });
});
