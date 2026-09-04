import { describe, expect, it, vi } from "vitest";

import { LspClient, LspError, clientCapabilities } from "./lsp-client";
import type { Json } from "./lsp-client";

/** A client wired to a sent-message log, which is the whole observable surface. */
function harness(handlers: Parameters<typeof makeClient>[1] = {}) {
  const sent: Json[] = [];
  const client = makeClient(sent, handlers);
  return { sent, client };
}

function makeClient(sent: Json[], handlers: ConstructorParameters<typeof LspClient>[1]) {
  return new LspClient((message) => sent.push(message), handlers);
}

/** Wait for the microtasks an async server-request answer goes through. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("requests", () => {
  it("correlates a response to its request", async () => {
    const { sent, client } = harness();
    const pending = client.request<{ ok: boolean }>("textDocument/hover", { x: 1 });
    expect(sent[0]).toMatchObject({ jsonrpc: "2.0", id: 1, method: "textDocument/hover" });

    client.receive({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("correlates out of order, which is the normal case under load", async () => {
    const { client } = harness();
    const first = client.request("a");
    const second = client.request("b");

    client.receive({ jsonrpc: "2.0", id: 2, result: "second" });
    client.receive({ jsonrpc: "2.0", id: 1, result: "first" });

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });

  it("rejects with the server's own code, not a generic failure", async () => {
    const { client } = harness();
    const pending = client.request("textDocument/definition");
    client.receive({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32801, message: "content modified" },
    });
    await expect(pending).rejects.toBeInstanceOf(LspError);
    await expect(pending).rejects.toMatchObject({ code: -32801 });
  });

  it("ignores a response to an id it never sent", () => {
    const { client } = harness();
    expect(() => client.receive({ jsonrpc: "2.0", id: 99, result: null })).not.toThrow();
  });

  it("does not leak a pending entry once answered", async () => {
    const { client } = harness();
    const pending = client.request("a");
    expect(client.inFlight).toBe(1);
    client.receive({ jsonrpc: "2.0", id: 1, result: null });
    await pending;
    expect(client.inFlight).toBe(0);
  });
});

describe("notifications", () => {
  it("dispatches a server notification", () => {
    const onNotification = vi.fn();
    const { client } = harness({ onNotification });
    client.receive({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri: "file:///a.rs", diagnostics: [] },
    });
    expect(onNotification).toHaveBeenCalledWith("textDocument/publishDiagnostics", {
      uri: "file:///a.rs",
      diagnostics: [],
    });
  });

  it("sends one without an id", () => {
    const { sent, client } = harness();
    client.notify("initialized", {});
    expect(sent[0]).toEqual({ jsonrpc: "2.0", method: "initialized", params: {} });
    expect(sent[0]).not.toHaveProperty("id");
  });
});

describe("server-to-client requests", () => {
  it("answers workDoneProgress/create, which rust-analyzer waits on", async () => {
    // Leaving this unanswered is a server that appears to hang while indexing.
    const { sent, client } = harness();
    client.receive({ jsonrpc: "2.0", id: 7, method: "window/workDoneProgress/create", params: {} });
    await settle();
    expect(sent[0]).toEqual({ jsonrpc: "2.0", id: 7, result: null });
  });

  it("answers workspace/configuration with one null per item", async () => {
    const { sent, client } = harness();
    client.receive({
      jsonrpc: "2.0",
      id: 3,
      method: "workspace/configuration",
      params: { items: [{ section: "rust-analyzer" }, { section: "other" }] },
    });
    await settle();
    expect(sent[0]).toEqual({ jsonrpc: "2.0", id: 3, result: [null, null] });
  });

  it("hands an unknown request to the caller", async () => {
    const onRequest = vi.fn().mockResolvedValue({ answered: true });
    const { sent, client } = harness({ onRequest });
    client.receive({ jsonrpc: "2.0", id: 4, method: "window/showMessageRequest", params: {} });
    await settle();
    expect(onRequest).toHaveBeenCalledWith("window/showMessageRequest", {});
    expect(sent[0]).toMatchObject({ id: 4, result: { answered: true } });
  });

  it("replies with an error rather than leaving the server waiting", async () => {
    const onRequest = vi.fn().mockRejectedValue(new Error("nope"));
    const { sent, client } = harness({ onRequest });
    client.receive({ jsonrpc: "2.0", id: 5, method: "window/showMessageRequest", params: {} });
    await settle();
    expect(sent[0]).toMatchObject({ id: 5, error: { code: -32603, message: "nope" } });
  });
});

describe("shutdown", () => {
  it("fails everything in flight instead of leaving it pending", async () => {
    // A promise that never settles is how a dead server becomes a frozen editor.
    const { client } = harness();
    const first = client.request("a");
    const second = client.request("b");
    client.close("server exited");

    await expect(first).rejects.toThrow("server exited");
    await expect(second).rejects.toThrow("server exited");
    expect(client.inFlight).toBe(0);
  });

  it("refuses new requests and drops late messages", async () => {
    const { sent, client } = harness();
    client.close("gone");
    await expect(client.request("a")).rejects.toThrow("closed");
    client.notify("b");
    client.receive({ jsonrpc: "2.0", method: "whatever", params: {} });
    expect(sent).toHaveLength(0);
  });

  it("is safe to close twice", () => {
    const { client } = harness();
    client.close("one");
    expect(() => client.close("two")).not.toThrow();
  });
});

describe("capabilities", () => {
  it("claims only what the adapter implements", () => {
    const caps = clientCapabilities() as {
      textDocument: Record<string, unknown>;
      window: Record<string, unknown>;
    };
    for (const feature of ["completion", "hover", "definition", "references", "rename"]) {
      expect(caps.textDocument[feature]).toBeDefined();
    }
    // Progress must be claimed or rust-analyzer never reports indexing at all.
    expect(caps.window.workDoneProgress).toBe(true);
  });
});
