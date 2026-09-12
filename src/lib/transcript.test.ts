import { describe, expect, it } from "vitest";

import { editedChange, editedFile, sessionCost,
  agentRuns,
  formatMeasure,
  initialState,
  liveActivity,
  mainRows,
  MCP_CLOSED,
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

  it("keeps an edit's input, because the diff is built from it and not from the result", () => {
    const input = { file_path: "src/fs.rs", old_string: "a", new_string: "b" };
    const s = run(assistant({ type: "tool_use", id: "t1", name: "Edit", input }));
    expect(tools(s)[0].input).toEqual(input);
  });

  it("keeps the whole file a Write sent, since that is the only copy of the addition", () => {
    const input = { file_path: "notes.txt", content: "one\ntwo\n" };
    const s = run(assistant({ type: "tool_use", id: "t1", name: "Write", input }));
    expect(tools(s)[0].input).toEqual(input);
  });

  it("drops the input of a call that changes nothing", () => {
    // Nothing draws it, so holding it would be a session's worth of arguments kept for
    // the length of the session. A `Task` prompt alone is larger than the row it belongs to.
    const s = run(
      assistant(
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.rs" } },
        { type: "tool_use", id: "t2", name: "Bash", input: { command: "cargo test" } },
        { type: "tool_use", id: "t3", name: "Task", input: { prompt: "a long brief" } },
      ),
    );
    expect(tools(s).map((row) => row.input)).toEqual([undefined, undefined, undefined]);
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

  it("counts each MCP server's tools from the flat tool list", () => {
    const s = run({
      t: "event",
      sessionId: "s1",
      msg: {
        type: "system",
        subtype: "init",
        tools: ["Read", "mcp__agentide__ide_hover", "mcp__agentide__ide_run", "mcp__ida__decompile"],
        mcp_servers: [
          { name: "agentide", status: "connected" },
          { name: "ida", status: "connected" },
          { name: "blender", status: "failed" },
        ],
      },
    });
    expect(s.meta.mcpServers).toEqual([
      { name: "agentide", status: "connected", tools: 2 },
      { name: "ida", status: "connected", tools: 1 },
      // A server that never came up contributes nothing, and is still listed.
      { name: "blender", status: "failed", tools: 0 },
    ]);
  });

  it("keeps the held-back servers whichever message lands second", () => {
    // Both halves of the strip arrive at the start of a turn unordered; both directions, because an
    // init carrying no `mcp_servers` used to erase the gated chips on its way past.
    const gated = {
      t: "mcp_gated" as const,
      sessionId: "s1",
      servers: [{ name: "blender", host: "127.0.0.1", port: 9876 }],
    };
    const init = {
      t: "event" as const,
      sessionId: "s1",
      msg: {
        type: "system",
        subtype: "init",
        tools: ["mcp__ida__decompile"],
        mcp_servers: [{ name: "ida", status: "connected" }],
      },
    };
    const expected = [
      { name: "ida", status: "connected", tools: 1 },
      { name: "blender", status: MCP_CLOSED, tools: 0, at: "127.0.0.1:9876" },
    ];

    expect(run(gated, init).meta.mcpServers).toEqual(expected);
    expect(run(init, gated).meta.mcpServers).toEqual(expected);
    // An init with no MCP servers at all is the case that used to wipe the chips.
    expect(run(gated, INIT).meta.mcpServers).toEqual([expected[1]]);
  });

  it("clears last turn's held-back chips when the next turn holds nothing back", () => {
    // The empty list is the whole reason the message is sent unconditionally: the person
    // opened Blender between turns, and the chip saying it was shut has to go.
    const s = run(
      {
        t: "mcp_gated",
        sessionId: "s1",
        servers: [{ name: "blender", host: "127.0.0.1", port: 9876 }],
      },
      {
        t: "event",
        sessionId: "s1",
        msg: {
          type: "system",
          subtype: "init",
          tools: ["mcp__ida__decompile"],
          mcp_servers: [{ name: "ida", status: "connected" }],
        },
      },
      { t: "mcp_gated", sessionId: "s1", servers: [] },
    );
    expect(s.meta.mcpServers).toEqual([{ name: "ida", status: "connected", tools: 1 }]);
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

describe("a note from our own hooks", () => {
  const note = (text: unknown) => ({
    t: "event" as const,
    sessionId: "s1",
    msg: { type: "system", subtype: "agentide_note", text },
  });

  it("draws delegation, which nothing else in the stream reports", () => {
    // Four subagents can work for a minute; without this the pane says nothing and it
    // reads as a hang.
    const s = run({ t: "prompt_submitted", text: "go" }, note("architect started"));
    expect(kinds(s)).toEqual(["prompt", "notice"]);
    expect(s.rows[s.rows.length - 1]).toMatchObject({ kind: "notice", tone: "info", text: "architect started" });
  });

  it("takes no address when there is nothing to say", () => {
    const s = run({ t: "prompt_submitted", text: "go" }, note(""), note(42));
    expect(kinds(s)).toEqual(["prompt"]);
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

describe("continuing a past conversation", () => {
  it("replays its messages as rows so the person can read what the model already knows", () => {
    const state = reduce(initialState(), {
      t: "conversation_loaded",
      id: "abc-123",
      entries: [
        { role: "user", text: "the passphrase is TANGERINE", atMs: 1, tools: [] },
        { role: "assistant", text: "Noted.", atMs: 2, tools: [] },
      ],
    });

    expect(state.rows.map((row) => row.kind)).toEqual(["prompt", "text", "notice"]);
    expect(state.rows[0]).toMatchObject({ kind: "prompt", text: "the passphrase is TANGERINE" });
    expect(state.rows[1]).toMatchObject({ kind: "text", text: "Noted." });
  });

  it("names the conversation and where its history ends", () => {
    const state = reduce(initialState(), {
      t: "conversation_loaded",
      id: "abc-123",
      entries: [{ role: "user", text: "hello", atMs: 1, tools: [] }],
    });

    const last = state.rows[state.rows.length - 1];
    expect(last.kind).toBe("notice");
    expect(last.kind === "notice" && last.text).toContain("abc-123");
    expect(last.kind === "notice" && last.text).toContain("1 message");
  });

  it("names the tools a reply used rather than drawing an empty row", () => {
    // A turn that only called tools has no text of its own, and dropping it would make
    // the replay claim the model said nothing when it did the work.
    const state = reduce(initialState(), {
      t: "conversation_loaded",
      id: "x",
      entries: [{ role: "assistant", text: "   ", atMs: 1, tools: ["ide_definition", "Read"] }],
    });

    expect(state.rows[0]).toMatchObject({ kind: "text", text: "(used ide_definition, Read)" });
  });

  it("replaces whatever was on screen, so two histories never stack", () => {
    const started = reduce(initialState(), { t: "prompt_submitted", text: "an earlier thing" });
    const state = reduce(started, {
      t: "conversation_loaded",
      id: "y",
      entries: [{ role: "user", text: "the resumed one", atMs: 1, tools: [] }],
    });

    expect(state.rows.some((row) => row.kind === "prompt" && row.text === "an earlier thing")).toBe(
      false,
    );
  });
});

describe("a turn with no checkpoint", () => {
  it("says so on its own line rather than leaving it unsaid", () => {
    // A workspace whose checkpoint cannot be taken still runs — what must not happen is running as
    // if the safety net were there.
    const state = reduce(initialState(), {
      t: "local_notice",
      tone: "warn",
      text: "no checkpoint — nothing in this turn can be reverted (permission denied)",
    });

    const row = state.rows[0];
    expect(row.kind).toBe("notice");
    expect(row.kind === "notice" && row.tone).toBe("warn");
    expect(row.kind === "notice" && row.text).toContain("can be reverted");
  });

  it("takes an address like any other row, so it can be referred to later", () => {
    const started = reduce(initialState(), { t: "prompt_submitted", text: "do a thing" });
    const state = reduce(started, { t: "local_notice", tone: "warn", text: "no checkpoint" });

    expect(state.rows.map((row) => row.addr)).toEqual([1, 2]);
    expect(state.nextAddr).toBe(3);
  });
});

describe("opening the file the agent is editing", () => {
  const assistant = (name: string, input: Record<string, unknown>) => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t1", name, input }] },
  });

  it("names the file a Write is about to change", () => {
    expect(editedFile(assistant("Write", { file_path: "C:/work/a.rs" }))).toBe("C:/work/a.rs");
  });

  it("spells the path the way the rest of the app does", () => {
    // The model types Windows paths and the editor and watcher match by string, so two spellings
    // mean the file opens and then never refreshes.
    expect(editedFile(assistant("Edit", { file_path: "c:\\work\\a.rs" }))).toBe("C:/work/a.rs");
  });

  it("ignores a tool that only reads, so the view is not yanked around mid-turn", () => {
    expect(editedFile(assistant("Read", { file_path: "C:/work/a.rs" }))).toBeNull();
    expect(editedFile(assistant("Grep", { pattern: "x" }))).toBeNull();
  });

  it("ignores a message that is not the assistant's", () => {
    expect(editedFile({ type: "user", message: { content: [] } })).toBeNull();
  });

  const ROOT = "C:/work/thing";

  it("resolves the relative path the model usually writes", () => {
    // `Write sample.txt` is at least as common as the full path, and everything downstream
    // matches by string: the tab, the file the editor loaded, and the watcher's events were
    // three spellings of one file, so nothing about it ever matched again.
    expect(editedChange(assistant("Write", { file_path: "sample.txt" }), undefined, ROOT)?.path).toBe(
      "C:/work/thing/sample.txt",
    );
    expect(
      editedChange(assistant("Edit", { file_path: "src\\main.rs" }), undefined, ROOT)?.path,
    ).toBe("C:/work/thing/src/main.rs");
  });

  it("leaves an absolute path alone", () => {
    expect(
      editedChange(assistant("Write", { file_path: "D:/other/a.rs" }), undefined, ROOT)?.path,
    ).toBe("D:/other/a.rs");
  });

  it("keeps a relative path as-is when no workspace is open", () => {
    // Nothing to resolve against. Better a path that opens nothing than one invented from
    // whatever the process's current directory happens to be.
    expect(editedChange(assistant("Write", { file_path: "sample.txt" }))?.path).toBe("sample.txt");
  });

  it("carries the change itself, so the editor can scroll to it and mark it", () => {
    // The hunks come from the tool's *input*: `Edit` answers in prose, and by the time a
    // result arrives the write has landed and there is nothing left to diff against.
    const edit = editedChange(
      assistant("Edit", {
        file_path: "C:/work/a.rs",
        old_string: "let x = 1;",
        new_string: "let x = 2;",
      }),
    );
    expect(edit?.path).toBe("C:/work/a.rs");
    expect(edit?.hunks.length).toBeGreaterThan(0);
    // The anchor is the new side, which is what `locateHunks` searches the file for.
    expect(edit?.hunks[0]?.anchor).toContain("let x = 2;");
  });

  it("still names the file when the tool's input describes no diff we can draw", () => {
    // A path with nothing to place is better than no edit at all: the file should still
    // open, it just cannot be scrolled to a hunk.
    const edit = editedChange(assistant("NotebookEdit", { notebook_path: "C:/w/n.ipynb" }));
    expect(edit?.path).toBe("C:/w/n.ipynb");
    expect(edit?.hunks).toEqual([]);
  });

  it("takes the notebook path when that is what the tool was given", () => {
    expect(editedFile(assistant("NotebookEdit", { notebook_path: "C:/w/n.ipynb" }))).toBe(
      "C:/w/n.ipynb",
    );
  });

  const VAULT = "C:/Users/tung/agentide-vault";

  it("leaves the editor alone when the write is a memory note", () => {
    // A note is an ordinary Write. Without this, recording something mid-turn takes the
    // view off the code the turn is about and puts it on the agent's own bookkeeping.
    const write = assistant("Write", { file_path: `${VAULT}/machine/rust-has-no-rust-src.md` });
    expect(editedFile(write, VAULT)).toBeNull();
    // The same message with no vault known still opens: this is an exclusion, not a
    // change to what counts as an edit.
    expect(editedFile(write)).toBe(`${VAULT}/machine/rust-has-no-rust-src.md`);
  });

  it("matches the vault whatever case the model typed it in", () => {
    // The core normalizes the vault to an upper-case drive; a case-sensitive compare would read a
    // lower-case drive letter as a different tree and let every note through.
    expect(editedFile(assistant("Edit", { file_path: "c:\\users\\tung\\agentide-vault\\a.md" }), VAULT)).toBeNull();
  });

  it("still opens a project file whose path merely starts like the vault's", () => {
    // `agentide-vault-backup` is not inside `agentide-vault`; a bare prefix test would
    // say it is and silently stop opening a whole directory of real files.
    expect(editedFile(assistant("Write", { file_path: `${VAULT}-backup/notes.md` }), VAULT)).toBe(
      `${VAULT}-backup/notes.md`,
    );
  });
});

describe("memory recalled into a turn", () => {
  const recall = (memories: unknown[], mode = "select") => ({
    t: "event" as const,
    sessionId: "s1",
    msg: { type: "system", subtype: "memory_recall", mode, memories },
  });

  it("says which notes were surfaced, so recall is not mistaken for guessing", () => {
    const s = run(
      recall([
        { path: "C:/Users/tung/agentide-vault/airlock.md", scope: "personal" },
        { path: "C:/Users/tung/agentide-vault/machine/no-rust-src.md", scope: "personal" },
      ]),
    );

    expect(s.rows).toHaveLength(1);
    const row = s.rows[0];
    expect(row.kind).toBe("notice");
    expect(row.kind === "notice" && row.tone).toBe("info");
    // Basenames only: every entry shares the vault prefix, so it distinguishes nothing
    // and would push the row past the pane.
    expect(row.kind === "notice" && row.text).toBe(
      "recalled from memory — airlock.md, no-rust-src.md",
    );
  });

  it("names a synthesis for what it is rather than printing its sentinel", () => {
    // `synthesize` mode has no file behind it -- the path is `<synthesis:DIR>` -- and
    // rendering that raw reads as a bug in the transcript.
    const s = run(recall([{ path: "<synthesis:C:/Users/tung/agentide-vault>" }], "synthesize"));

    expect(s.rows[0].kind === "notice" && s.rows[0].text).toBe("recalled from memory — a synthesis");
  });

  it("takes the last segment of an organization memory's URL", () => {
    const s = run(recall([{ path: "https://memories.example/team/build-flags/", scope: "organization" }]));

    expect(s.rows[0].kind === "notice" && s.rows[0].text).toBe("recalled from memory — build-flags");
  });

  it("says one note once when two scopes surface the same file", () => {
    const s = run(
      recall([
        { path: "C:/v/airlock.md", scope: "personal" },
        { path: "D:/team/airlock.md", scope: "team" },
      ]),
    );

    expect(s.rows[0].kind === "notice" && s.rows[0].text).toBe("recalled from memory — airlock.md");
  });

  it("draws nothing when nothing was recalled", () => {
    // An empty recall is not an event. A row saying so would appear on turns where memory
    // did nothing at all, which is most of them.
    expect(run(recall([])).rows).toEqual([]);
    expect(run(recall([{ scope: "personal" }])).rows).toEqual([]);
  });
});

// --- streaming ------------------------------------------------------------------------

/** One raw stream event, wrapped the way every other event reaches the reducer. */
function streamEvent(event: unknown) {
  return { t: "event" as const, sessionId: "s1", msg: { type: "stream_event", event } };
}

/** The finished message that a preview is replaced by. */
function assistantText(text: string) {
  return assistant({ type: "text", text });
}

const textDelta = (text: string) =>
  streamEvent({ type: "content_block_delta", delta: { type: "text_delta", text } });
const textStart = () =>
  streamEvent({ type: "content_block_start", content_block: { type: "text" } });

describe("the answer as it arrives", () => {
  it("shows text before the message carrying it lands", () => {
    // The whole point: an answer that takes twenty seconds should not be twenty seconds
    // of blank pane.
    let state = reduce(initialState(), textStart());
    state = reduce(state, textDelta("Hello"));
    state = reduce(state, textDelta(", world"));
    expect(state.streaming).toBe("Hello, world");
    expect(state.rows).toHaveLength(0);
  });

  it("draws nothing twice when the message finally lands", () => {
    // The preview and the row are the same words; showing both would be the answer
    // printed twice.
    let state = reduce(initialState(), textStart());
    state = reduce(state, textDelta("done"));
    state = reduce(state, assistantText("done"));
    expect(state.streaming).toBeNull();
    expect(state.rows.filter((row) => row.kind === "text")).toHaveLength(1);
  });

  it("gives the same transcript whether or not a single delta arrived", () => {
    // The property that makes this safe on a surface that already rendered correctly: a
    // dropped, malformed or missing delta costs a preview, never a wrong transcript.
    const withStream = reduce(
      reduce(reduce(initialState(), textStart()), textDelta("partial")),
      assistantText("the whole answer"),
    );
    const without = reduce(initialState(), assistantText("the whole answer"));
    expect(withStream.rows).toEqual(without.rows);
  });

  it("starts a second block over rather than running the two together", () => {
    // Two text blocks in one message are separate paragraphs. Concatenating them would
    // show a sentence that was never written.
    let state = reduce(initialState(), textStart());
    state = reduce(state, textDelta("first"));
    state = reduce(state, textStart());
    state = reduce(state, textDelta("second"));
    expect(state.streaming).toBe("second");
  });

  it("ignores an event that is not text", () => {
    // Thinking has its own live measure, and a tool call cannot be drawn until its
    // arguments are whole -- a half-parsed path is worse than a pause.
    let state = reduce(initialState(), textStart());
    state = reduce(state, streamEvent({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hm" } }));
    expect(state.streaming).toBe("");
  });

  it("survives an event with nothing in it", () => {
    expect(reduce(initialState(), streamEvent(undefined)).streaming).toBeNull();
  });
});

// --- delegation -----------------------------------------------------------------------

/** A message the SDK tagged as a subagent's. */
function fromAgent(parent: string, ...content: unknown[]) {
  return {
    t: "event" as const,
    sessionId: "s1",
    msg: {
      type: "assistant",
      parent_tool_use_id: parent,
      message: { role: "assistant", content },
    },
  };
}

/** The `Task` call that starts a run. */
const delegate = (id: string, agent: string, description: string) =>
  assistant({
    type: "tool_use",
    id,
    name: "Task",
    input: { subagent_type: agent, description, prompt: "a long prompt nobody reads here" },
  });

const reading = (id: string, path: string) =>
  ({ type: "tool_use", id, name: "Read", input: { file_path: path } }) as const;

describe("a delegated run", () => {
  it("attributes a subagent's rows to the run instead of to the conversation", () => {
    // The bug this fixes: every row was pushed at the top level whatever produced it, so
    // four agents' calls arrived interleaved and unlabelled and the transcript read as the
    // main agent having done all of it.
    const s = run(
      { t: "prompt_submitted", text: "build it" },
      INIT,
      delegate("t1", "ide-implementer", "write the search"),
      fromAgent("t1", { type: "text", text: "reading the walk first" }),
      fromAgent("t1", reading("r1", "src-tauri/src/fs.rs")),
    );

    expect(kinds(s)).toEqual(["prompt", "tool", "text", "tool"]);
    // Drawn, though: the rows still exist, they are just someone else's.
    expect(mainRows(s).map((row) => row.kind)).toEqual(["prompt", "tool"]);

    const runs = agentRuns(s);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: "t1", name: "ide-implementer", task: "write the search" });
    expect(runs[0].rows.map((row) => row.kind)).toEqual(["text", "tool"]);
  });

  it("names the agent, not just what it was asked", () => {
    // `ide-implementer` is what decides whether you want to read the run; the description
    // is only what it was handed.
    const s = run({ t: "prompt_submitted", text: "go" }, delegate("t1", "ide-reviewer", "review the diff"));
    expect(tools(s)[0]).toMatchObject({ cls: "agent", agent: "ide-reviewer" });
    // The prompt is still dropped: only `mutate` rows keep their input.
    expect(tools(s)[0].input).toBeUndefined();
  });

  it("says what the run is doing now, and stops when it stops", () => {
    const started = run(
      { t: "prompt_submitted", text: "go" },
      delegate("t1", "ide-validator", "run the tests"),
      fromAgent("t1", { type: "tool_use", id: "c1", name: "Bash", input: { command: "cargo test" } }),
    );
    expect(agentRuns(started)[0].activity).toMatchObject({ verb: "running", detail: "cargo test" });

    // The run ends when its `Task` call returns, not when its last tool does.
    const finished = reduce(started, toolResult("t1", "130 passed"));
    expect(agentRuns(finished)[0].status).toBe("ok");
    expect(agentRuns(finished)[0].activity).toBeNull();
  });

  it("keeps the turn's own activity on the delegation rather than on the delegate", () => {
    // Otherwise the line reads as the main agent reading files itself, and the delegation --
    // the reason the pane is otherwise quiet for a minute -- is never said at all.
    const s = run(
      { t: "prompt_submitted", text: "go" },
      delegate("t1", "ide-architect", "plan the change"),
      fromAgent("t1", reading("r1", "src/App.tsx")),
    );
    expect(liveActivity(s)).toMatchObject({ verb: "delegating", detail: "plan the change" });
  });

  it("does not let a subagent's text overwrite the answer being written", () => {
    // `streaming` is the one reply at the foot of the transcript. A forwarded delegate's
    // preview would replace it with text that belongs inside a run.
    let s = run({ t: "prompt_submitted", text: "go" }, delegate("t1", "ide-implementer", "edit"));
    s = reduce(s, textStart());
    s = reduce(s, textDelta("here is what I found"));
    s = reduce(s, {
      t: "event",
      sessionId: "s1",
      msg: {
        type: "stream_event",
        parent_tool_use_id: "t1",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "subagent noise" } },
      },
    });
    expect(s.streaming).toBe("here is what I found");
  });

  it("drops a row whose run it has never seen, rather than promoting it", () => {
    // A nested delegation, or a message that overtook its `Task` call. Promoting it to the
    // top level is exactly the interleaving this structure exists to remove.
    const s = run({ t: "prompt_submitted", text: "go" }, fromAgent("unknown", reading("r1", "a.ts")));
    expect(agentRuns(s)).toEqual([]);
    expect(mainRows(s).map((row) => row.kind)).toEqual(["prompt"]);
  });

  it("leaves a conversation with no delegation exactly as it was", () => {
    // `mainRows` is on the hot path of every render, and a conversation that never
    // delegated -- which is most of them -- must not pay for a copy of its rows.
    const s = run({ t: "prompt_submitted", text: "go" }, assistant({ type: "text", text: "done" }));
    expect(mainRows(s)).toBe(s.rows);
  });
});

describe("what a fresh install is missing", () => {
  it("is held out of the rows, so it cannot scroll away", () => {
    // It describes the machine, not the conversation, and someone needs it before their
    // first prompt — which is exactly when a row would be scrolled past.
    const state = reduce(initialState(), {
      t: "readiness",
      problems: [{ severity: "blocked", title: "Not signed in", fix: "Run /login" }],
    } as never);
    expect(state.rows).toHaveLength(0);
    expect(state.problems).toHaveLength(1);
    expect(state.problems[0]?.fix).toBe("Run /login");
  });

  it("a later check replaces the earlier one rather than adding to it", () => {
    // Signing in should clear the banner, not leave a stale copy under a fresh one.
    let state = reduce(initialState(), {
      t: "readiness",
      problems: [{ severity: "blocked", title: "Not signed in", fix: "Run /login" }],
    } as never);
    state = reduce(state, { t: "readiness", problems: [] } as never);
    expect(state.problems).toEqual([]);
  });

  it("starts empty, so nothing is claimed before the check has run", () => {
    expect(initialState().problems).toEqual([]);
  });
});

describe("a prompt that carried attachments", () => {
  it("says what went with it", () => {
    // Without this the transcript shows the question and no sign of the file it was about,
    // so scrolling back gives you a prompt that reads as a non-sequitur.
    const s = run({
      t: "prompt_submitted",
      text: "what is in this file",
      sent: [{ kind: "file", label: "antiaim.txt" }],
    });
    expect(s.rows[0]).toMatchObject({
      kind: "prompt",
      text: "what is in this file",
      sent: [{ kind: "file", label: "antiaim.txt" }],
    });
  });

  it("carries nothing when nothing was attached", () => {
    // An empty array must not become an empty strip under every ordinary prompt.
    const s = run({ t: "prompt_submitted", text: "go", sent: [] });
    expect(s.rows[0]).not.toHaveProperty("sent");
  });
});

describe("what the conversation has cost", () => {
  const result = (total: number) => ({
    t: "event" as const,
    sessionId: "s1",
    msg: { type: "result", subtype: "success", total_cost_usd: total },
  });

  it("takes the latest figure, because the SDK's is already cumulative", () => {
    // Each result carries the running total for its query. Adding them up charges the first
    // turn once for every turn after it — 0.10 + 0.25 + 0.40 would read as 0.75.
    const s = run(result(0.1), result(0.25), result(0.4));
    expect(sessionCost(s)).toBeCloseTo(0.4);
  });

  it("banks the old total when the query restarts its count", () => {
    // Switching model, backend or account rebuilds the query, and the running figure starts
    // again from zero — but the turns before it still cost what they cost.
    const s = run(result(0.1), result(0.25), result(0.05), result(0.09));
    expect(sessionCost(s)).toBeCloseTo(0.34);
  });

  it("is zero before any turn, and zero again on a new conversation", () => {
    expect(sessionCost(run())).toBe(0);
    expect(sessionCost(run(result(0.5), { t: "conversation_reset" }))).toBe(0);
  });

  it("survives a result that reports no cost at all", () => {
    // A crash or startup-error result carries zeroed values; that must not bank a total
    // that was never spent.
    const s = run(result(0.3), { t: "event", sessionId: "s1", msg: { type: "result", subtype: "error" } });
    expect(sessionCost(s)).toBeCloseTo(0.3);
  });
});

describe("how full the window is", () => {
  it("is unknown until a turn has been measured", () => {
    // The sidecar cannot measure an empty query, and a made-up zero would read as "plenty
    // of room" on a conversation that was resumed at 900k.
    expect(run().context).toBeNull();
  });

  it("keeps the latest measurement", () => {
    const s = run(
      { t: "context", sessionId: "s1", tokens: 41476, max: 200000 },
      { t: "context", sessionId: "s1", tokens: 88000, max: 200000 },
    );
    expect(s.context).toEqual({ tokens: 88000, max: 200000 });
  });

  it("forgets it on a new conversation", () => {
    const s = run({ t: "context", sessionId: "s1", tokens: 88000, max: 200000 }, { t: "conversation_reset" });
    expect(s.context).toBeNull();
  });
});
