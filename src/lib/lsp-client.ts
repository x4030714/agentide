/**
 * A minimal LSP client, hand-written.
 *
 * `monaco-languageclient` was the obvious choice and is the wrong one here: at 10.7 it
 * depends on `@codingame/monaco-vscode-editor-api`, a *replacement* for `monaco-editor`,
 * plus the whole `@codingame/monaco-vscode-api` stack. Taking it would mean swapping out
 * our Monaco 0.56 and losing the custom themes, the verified worker wiring and
 * `@monaco-editor/react` with it — for four features. So this file exists instead, and
 * it is deliberately small: correlate requests, dispatch notifications, answer the
 * handful of server-to-client requests that matter, and nothing else.
 *
 * The transport is the same Tauri `Channel` the agent and pty use. Rust does framing and
 * process lifetime; every piece of protocol semantics lives here.
 */

export type Json = Record<string, unknown>;

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  method: string;
}

/** A JSON-RPC error as the server reported it, with its code kept. */
export class LspError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly method: string,
  ) {
    super(`${method}: ${message}`);
    this.name = "LspError";
  }
}

export interface LspHandlers {
  /** `textDocument/publishDiagnostics` and anything else the editor draws. */
  onNotification?: (method: string, params: Json) => void;
  /** Server-to-client requests we do not answer ourselves. Return the result. */
  onRequest?: (method: string, params: Json) => Promise<unknown>;
  /** stderr and transport-level trouble, for the surface that shows server health. */
  onLog?: (line: string) => void;
}

export class LspClient {
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #handlers: LspHandlers;
  #send: (message: Json) => void;
  #closed = false;

  /** True once `initialize` has been answered; requests before that are refused. */
  initialized = false;
  capabilities: Json = {};

  constructor(send: (message: Json) => void, handlers: LspHandlers = {}) {
    this.#send = send;
    this.#handlers = handlers;
  }

  /** Feed every decoded message from the server here, in arrival order. */
  receive(message: Json): void {
    if (this.#closed) return;

    const id = message.id;
    const method = typeof message.method === "string" ? message.method : undefined;

    // A response: has an id and no method.
    if (id !== undefined && method === undefined) {
      const key = typeof id === "number" ? id : Number(id);
      const pending = this.#pending.get(key);
      if (!pending) return;
      this.#pending.delete(key);
      const error = message.error as { code?: number; message?: string } | undefined;
      if (error) {
        pending.reject(
          new LspError(error.code ?? 0, error.message ?? "unknown error", pending.method),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (method === undefined) return;
    const params = (message.params ?? {}) as Json;

    // A request from the server: it has both a method and an id, and it is waiting.
    if (id !== undefined) {
      void this.#answer(id, method, params);
      return;
    }

    this.#handlers.onNotification?.(method, params);
  }

  async #answer(id: unknown, method: string, params: Json): Promise<void> {
    try {
      const result = await this.#serverRequest(method, params);
      this.#send({ jsonrpc: "2.0", id, result });
    } catch (err) {
      this.#send({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  /**
   * The server-to-client requests worth answering without bothering the caller.
   *
   * rust-analyzer will not report progress at all unless `window/workDoneProgress/create`
   * is answered, and it waits on `client/registerCapability` during startup — leaving
   * either unanswered is a server that appears to hang while indexing.
   */
  async #serverRequest(method: string, params: Json): Promise<unknown> {
    switch (method) {
      case "window/workDoneProgress/create":
      case "client/registerCapability":
      case "client/unregisterCapability":
        return null;
      case "workspace/configuration": {
        // One null per item: "no configuration", which every server accepts.
        const items = (params.items as unknown[] | undefined) ?? [];
        return items.map(() => null);
      }
      default: {
        const handled = await this.#handlers.onRequest?.(method, params);
        return handled ?? null;
      }
    }
  }

  request<T = unknown>(method: string, params?: Json): Promise<T> {
    if (this.#closed) return Promise.reject(new Error(`${method}: client is closed`));
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        method,
      });
      this.#send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    });
  }

  notify(method: string, params?: Json): void {
    if (this.#closed) return;
    this.#send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  log(line: string): void {
    this.#handlers.onLog?.(line);
  }

  /**
   * The server is gone. Every in-flight request is failed rather than left pending —
   * a promise that never settles is how a dead server turns into a frozen editor.
   */
  close(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [, pending] of this.#pending) {
      pending.reject(new Error(`${pending.method}: ${reason}`));
    }
    this.#pending.clear();
    this.initialized = false;
  }

  get inFlight(): number {
    return this.#pending.size;
  }
}

/** The capabilities we actually implement. Claiming more invites features we ignore. */
export function clientCapabilities(): Json {
  return {
    textDocument: {
      synchronization: { dynamicRegistration: false, didSave: true },
      publishDiagnostics: { relatedInformation: true, versionSupport: true },
      completion: {
        dynamicRegistration: false,
        completionItem: {
          snippetSupport: true,
          documentationFormat: ["markdown", "plaintext"],
          resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
        },
        contextSupport: true,
      },
      hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
      definition: { dynamicRegistration: false, linkSupport: true },
      implementation: { dynamicRegistration: false, linkSupport: true },
      /**
       * Without `codeActionLiteralSupport` a server must answer with the 1.0 `Command[]`
       * form, which carries no edit -- ide_code_actions would list actions it could never
       * apply. `dataSupport` plus `resolveSupport` is the other half: rust-analyzer sends
       * the actions without their edits and computes each one only when asked, which is
       * why it can offer them at all on a large crate.
       */
      codeAction: {
        dynamicRegistration: false,
        codeActionLiteralSupport: {
          codeActionKind: {
            valueSet: [
              "",
              "quickfix",
              "refactor",
              "refactor.extract",
              "refactor.inline",
              "refactor.rewrite",
              "source",
              "source.organizeImports",
            ],
          },
        },
        isPreferredSupport: true,
        dataSupport: true,
        resolveSupport: { properties: ["edit"] },
      },
      references: { dynamicRegistration: false },
      documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
      rename: { dynamicRegistration: false, prepareSupport: true },
      signatureHelp: {
        dynamicRegistration: false,
        signatureInformation: { documentationFormat: ["markdown", "plaintext"] },
      },
    },
    workspace: {
      workspaceFolders: true,
      configuration: true,
      didChangeConfiguration: { dynamicRegistration: false },
      symbol: { dynamicRegistration: false },
    },
    window: { workDoneProgress: true },
  };
}
