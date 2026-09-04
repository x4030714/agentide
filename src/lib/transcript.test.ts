import { describe, expect, it } from "vitest";

import {
  formatMeasure,
  initialState,
  operandOf,
  reduce,
  shortToolName,
  toolClass,
  type Row,
  type TranscriptAction,
  type TranscriptState,
} from "./transcript";

/** Fold a sequence, the way the pane does. */
function run(...actions: TranscriptAction[]): TranscriptState {
  return actions.reduce(reduce, initialState());
}

const INIT = {
  t: "event" as const,
  sessionId: "s1",
  msg: {
    type: "system",
    subtype: "init",
    model: "claude-opus-5",
    cwd: "C:/Users/tung/Desktop/agentide",
    tools: ["Read", "Edit", "Bash"],
    permissionMode: "default",
  },
};

function assistant(...content: unknown[]) {
  return {
    t: "event" as const,
    sessionId: "s1",
    msg: { type: "assistant", message: { role: "assistant", content } },
  };
}

/** The SDK hands a tool result back as a *synthetic user message*, not a tool event. */
function toolResult(toolUseId: string, content: unknown, isError = false) {
  return {
    t: "event" as const,
    sessionId: "s1",
    msg: {
      type: "user",
      isSynthetic: true,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
      },
    },
  };
}

const kinds = (s: TranscriptState) => s.rows.map((r) => r.kind);
const tools = (s: TranscriptState) => s.rows.filter((r): r is Row & { kind: "tool" } => r.kind === "tool");

describe("classification", () => {
  it("maps tools to the class that drives their colour", () => {
    expect(toolClass("Read")).toBe("read");
    expect(toolClass("Edit")).toBe("mutate");
    expect(toolClass("Bash")).toBe("exec");
    expect(toolClass("WebSearch")).toBe("net");
    expect(toolClass("Task")).toBe("agent");
    expect(toolClass("Nonesuch")).toBe("other");
  });

  it("sees through the MCP namespace to the semantic class", () => {
    // This is the whole positioning: an ide_* call must not read as a generic tool.
    expect(toolClass("mcp__ide__ide_diagnostics")).toBe("semantic");
    expect(toolClass("ide_open")).toBe("semantic");
    expect(shortToolName("mcp__ide__ide_diagnostics")).toBe("ide_diagnostics");
  });
});

describe("operands", () => {
  const cwd = "C:/Users/tung/Desktop/agentide";

  it("picks the argument worth showing, per tool", () => {
    expect(operandOf("Grep", { pattern: "fn open_workspace", path: "src" })).toBe(
      "fn open_workspace",
    );
    expect(operandOf("WebFetch", { url: "https://example.com", prompt: "x" })).toBe(
      "https://example.com",
    );
  });

  it("renders paths relative to the workspace, on either slash", () => {
    expect(operandOf("Read", { file_path: `${cwd}/src/lib/fs.rs` }, cwd)).toBe("src/lib/fs.rs");
    expect(
      operandOf("Read", { file_path: "C:\\Users\\tung\\Desktop\\agentide\\src\\App.tsx" }, cwd),
    ).toBe("src/App.tsx");
  });

  it("collapses a multi-line command into one row", () => {
    expect(operandOf("Bash", { command: "cargo test \\\n  --lib" })).toBe("cargo test \\ --lib");
  });

  it("falls back to the first string rather than an unactionable blank row", () => {
    expect(operandOf("Mystery", { whatever: "value" })).toBe("value");
    expect(operandOf("Mystery", {})).toBe("");
  });
});

describe("assistant content", () => {
  it("draws text, thinking and tool calls in order", () => {
    const s = run(
      INIT,
      assistant(
        { type: "thinking", thinking: "considering" },
        { type: "text", text: "Renaming it." },
        { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "src/fs.rs" } },
      ),
    );
    expect(kinds(s)).toEqual(["thinking", "text", "tool"]);
    expect(tools(s)[0]).toMatchObject({ name: "Edit", cls: "mutate", status: "running" });
  });

  it("ignores empty text blocks", () => {
    expect(kinds(run(assistant({ type: "text", text: "   " })))).toEqual([]);
  });

  it("surfaces a wrapper-level assistant error", () => {
    const s = run({
      t: "event",
      sessionId: "s1",
      msg: { type: "assistant", error: "rate_limit", message: { content: [] } },
    });
    expect(s.rows[0]).toMatchObject({ kind: "notice", tone: "error" });
  });
});

describe("tool results arrive as synthetic user messages", () => {
  it("resolves the call rather than drawing a user row", () => {
    const s = run(
      INIT,
      assistant({ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.rs" } }),
      toolResult("t1", "hello world"),
    );
    // The critical assertion: no second row appeared for the result.
    expect(kinds(s)).toEqual(["tool"]);
    expect(tools(s)[0]).toMatchObject({ status: "ok", measure: "11", detail: "hello world" });
  });

  it("reads a content-block body as well as a string body", () => {
    const s = run(
      assistant({ type: "tool_use", id: "t1", name: "Grep", input: { pattern: "x" } }),
      toolResult("t1", [{ type: "text", text: "four" }]),
    );
    expect(tools(s)[0].detail).toBe("four");
  });

  it("marks a failed result and does not measure it", () => {
    const s = run(
      assistant({ type: "tool_use", id: "t1", name: "Bash", input: { command: "false" } }),
      toolResult("t1", "exit 1", true),
    );
    expect(tools(s)[0]).toMatchObject({ status: "error", measure: "err" });
  });

  it("ignores a result for a call it never saw", () => {
    const s = run(toolResult("ghost", "x"));
    expect(s.rows).toEqual([]);
  });
});

describe("system subtypes are not one variant", () => {
  it("captures init as metadata, not as a row", () => {
    const s = run(INIT);
    expect(s.rows).toEqual([]);
    expect(s.meta).toMatchObject({ model: "claude-opus-5", toolCount: 3 });
  });

  it("draws api_retry as a warning", () => {
    const s = run({
      t: "event",
      sessionId: "s1",
      msg: {
        type: "system",
        subtype: "api_retry",
        attempt: 2,
        max_retries: 5,
        error_status: 429,
        error: "rate_limit",
      },
    });
    expect(s.rows[0]).toMatchObject({ kind: "notice", tone: "warn" });
    expect((s.rows[0] as Row & { kind: "notice" }).text).toContain("2/5");
  });

  it("draws a compaction boundary with its token span", () => {
    const s = run({
      t: "event",
      sessionId: "s1",
      msg: {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 84000, post_tokens: 12000 },
      },
    });
    expect((s.rows[0] as Row & { kind: "notice" }).text).toContain("84k → 12k");
  });

  it("drops status chatter", () => {
    const s = run({
      t: "event",
      sessionId: "s1",
      msg: { type: "system", subtype: "status", status: "thinking" },
    });
    expect(s.rows).toEqual([]);
  });

  it("drops variants it does not draw, rather than inventing a row", () => {
    for (const type of ["stream_event", "task_started", "hook_started", "rate_limit_event"]) {
      expect(run({ t: "event", sessionId: "s1", msg: { type } }).rows).toEqual([]);
    }
  });
});

describe("progress and permissions", () => {
  it("keeps a long tool visibly alive, but not after it finishes", () => {
    const call = assistant({ type: "tool_use", id: "t1", name: "Bash", input: { command: "x" } });
    const progress = {
      t: "event" as const,
      sessionId: "s1",
      msg: { type: "tool_progress", tool_use_id: "t1", elapsed_time_seconds: 12 },
    };
    expect(tools(run(call, progress))[0].elapsed).toBe(12);
    expect(tools(run(call, toolResult("t1", "done"), progress))[0].elapsed).toBeUndefined();
  });

  it("resolves a permission request and records who answered", () => {
    const s = run(
      { t: "permission_request", id: "p1", sessionId: "s1", tool: "Bash", input: { command: "rm" } },
      { t: "permission_decided", id: "p1", sessionId: "s1", decision: "deny", source: "host" },
    );
    expect(s.rows[0]).toMatchObject({ kind: "permission", status: "deny", source: "host" });
  });
});

describe("an approval belongs to the call it gates", () => {
  const write = assistant({
    type: "tool_use",
    id: "t1",
    name: "Write",
    input: { file_path: "README.md" },
  });
  const ask = {
    t: "permission_request" as const,
    id: "p1",
    sessionId: "s1",
    tool: "Write",
    input: { file_path: "README.md" },
  };

  it("attaches to the tool row instead of drawing a second one", () => {
    // The bug this replaced: one Write appeared twice, at two addresses.
    const s = run(write, ask);
    expect(kinds(s)).toEqual(["tool"]);
    expect(tools(s)[0].permission).toMatchObject({ id: "p1", status: "pending" });
  });

  it("marks the call denied, since a denial means it never ran", () => {
    const s = run(write, ask, {
      t: "permission_decided",
      id: "p1",
      sessionId: "s1",
      decision: "deny",
      source: "ui",
    });
    expect(tools(s)[0]).toMatchObject({ status: "denied" });
    expect(tools(s)[0].permission).toMatchObject({ status: "deny", source: "ui" });
  });

  it("leaves an allowed call running until its result arrives", () => {
    const s = run(write, ask, {
      t: "permission_decided",
      id: "p1",
      sessionId: "s1",
      decision: "allow",
      source: "ui",
    });
    expect(tools(s)[0].status).toBe("running");
  });

  it("picks the right call when two of the same tool are in flight", () => {
    const s = run(
      write,
      assistant({ type: "tool_use", id: "t2", name: "Write", input: { file_path: "b.md" } }),
      ask,
    );
    expect(tools(s)[0].permission).toBeUndefined();
    expect(tools(s)[1].permission).toMatchObject({ id: "p1" });
  });

  it("still draws a standalone row when there is no call to attach to", () => {
    // Better a row with no home than a prompt the person never sees.
    const s = run(ask);
    expect(kinds(s)).toEqual(["permission"]);
  });

  it("clears an attached prompt on shutdown rather than leaving it live", () => {
    const s = run(write, ask, {
      t: "exited",
      code: 1,
      message: "sidecar died",
      pending: ["p1"],
    });
    expect(tools(s)[0]).toMatchObject({ status: "abandoned" });
    expect(tools(s)[0].permission).toMatchObject({ status: "deny", source: "host" });
  });
});

describe("shutdown", () => {
  it("fails exactly what will never be answered", () => {
    const s = run(
      assistant({ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a" } }),
      { t: "permission_request", id: "p1", sessionId: "s1", tool: "Bash", input: {} },
      { t: "exited", code: 1, message: "sidecar died", pending: ["p1"] },
    );
    expect(tools(s)[0].status).toBe("abandoned");
    expect(s.rows[1]).toMatchObject({ kind: "permission", status: "deny" });
    expect(s.status).toBe("exited");
  });
});

describe("a turn closes exactly once", () => {
  const result = {
    t: "event" as const,
    sessionId: "s1",
    msg: {
      type: "result",
      subtype: "success",
      duration_ms: 12420,
      num_turns: 5,
      total_cost_usd: 0.0841,
    },
  };

  it("prefers the SDK result over the protocol's done, which carries less", () => {
    const s = run(
      { t: "prompt_submitted", text: "go" },
      result,
      { t: "done", sessionId: "s1", reason: "success" },
    );
    expect(kinds(s)).toEqual(["prompt", "turn"]);
    expect(s.rows[1]).toMatchObject({ durationMs: 12420, turns: 5 });
    expect(s.status).toBe("ready");
  });

  it("still closes the turn when no result arrived", () => {
    const s = run({ t: "prompt_submitted", text: "go" }, {
      t: "done",
      sessionId: "s1",
      reason: "interrupted",
    });
    expect(kinds(s)).toEqual(["prompt", "turn"]);
  });

  it("does not swallow a done that carries an error the result did not", () => {
    const s = run({ t: "prompt_submitted", text: "go" }, result, {
      t: "done",
      sessionId: "s1",
      reason: "error",
      error: "sidecar refused",
    });
    expect(kinds(s)).toEqual(["prompt", "turn", "turn"]);
  });

  it("reopens for the next turn", () => {
    const s = run(
      { t: "prompt_submitted", text: "one" },
      result,
      { t: "done", sessionId: "s1", reason: "success" },
      { t: "prompt_submitted", text: "two" },
      { t: "done", sessionId: "s1", reason: "success" },
    );
    expect(kinds(s)).toEqual(["prompt", "turn", "prompt", "turn"]);
  });
});

describe("thinking is a live measurement, not a row", () => {
  const thinking = (estimated_tokens: number) => ({
    t: "event" as const,
    sessionId: "s1",
    msg: { type: "system", subtype: "thinking_tokens", estimated_tokens, estimated_tokens_delta: 40 },
  });

  it("tracks the running estimate without consuming an address", () => {
    const s = run({ t: "prompt_submitted", text: "go" }, thinking(120), thinking(1240));
    expect(s.thinking).toBe(1240);
    // The whole point: a transient state must not take an address, which never renumbers.
    expect(kinds(s)).toEqual(["prompt"]);
  });

  it("stops once the reasoning produces content", () => {
    const s = run(thinking(1240), assistant({ type: "text", text: "done reasoning" }));
    expect(s.thinking).toBeNull();
  });

  it("stops when the turn ends, by either path", () => {
    expect(run(thinking(900), { t: "done", sessionId: "s1", reason: "success" }).thinking).toBeNull();
    expect(
      run(thinking(900), {
        t: "event",
        sessionId: "s1",
        msg: { type: "result", subtype: "success", duration_ms: 10 },
      }).thinking,
    ).toBeNull();
  });

  it("stops when the sidecar dies, rather than counting forever", () => {
    const s = run(thinking(900), { t: "exited", code: 1, message: "died", pending: [] });
    expect(s.thinking).toBeNull();
  });

  it("resets between turns", () => {
    const s = run(thinking(900), { t: "prompt_submitted", text: "next" });
    expect(s.thinking).toBeNull();
  });
});

describe("addresses", () => {
  it("never renumber, so a row stays referable", () => {
    const s = run(
      { t: "prompt_submitted", text: "one" },
      assistant({ type: "text", text: "a" }),
      { t: "done", sessionId: "s1", reason: "success" },
      { t: "prompt_submitted", text: "two" },
    );
    expect(s.rows.map((r) => r.addr)).toEqual([1, 2, 3, 4]);
    expect(s.rows.map((r) => r.turn)).toEqual([1, 1, 1, 2]);
  });
});

describe("measure", () => {
  it("uses the same shape as the tree's length column", () => {
    expect(formatMeasure("x".repeat(512))).toBe("512");
    expect(formatMeasure("x".repeat(1536))).toBe("1.5K");
    expect(formatMeasure("x".repeat(20480))).toBe("20K");
  });
});
