import { lspSend, lspStart, lspStop } from "./bridge";
import { LspClient, clientCapabilities } from "./lsp-client";
import type { Json } from "./lsp-client";
import { toFileUri } from "./protocol";
import type { LspEvent, WirePath } from "./protocol";

/**
 * One language server, from spawn to shutdown, with the documents it is told about.
 *
 * The client below owns the protocol; this owns the *session* — which server serves which
 * language, the initialize handshake, keeping open documents in sync, and reporting
 * honestly on a server that is alive but not yet useful.
 */

export interface ServerSpec {
  /** One per language per workspace. */
  id: string;
  /** argv, `command[0]` resolved against PATH. */
  command: string[];
  /** Monaco language ids this server answers for. */
  languages: string[];
  /** Shown when the server cannot start, so the reason names the fix. */
  missingHint: string;
}

/**
 * Only the two languages PRODUCT.md names. Adding a server is adding a row here; there is
 * deliberately no table of these in Rust, because which server serves which language is a
 * frontend decision and splitting it across the boundary would put it in two places.
 */
export const SERVERS: ServerSpec[] = [
  {
    id: "rust",
    command: ["rust-analyzer"],
    languages: ["rust"],
    missingHint: "rust-analyzer is not on PATH. It ships with the Rust toolchain.",
  },
  {
    id: "clangd",
    command: ["clangd", "--background-index", "--clang-tidy"],
    languages: ["c", "cpp", "objective-c", "objective-cpp"],
    missingHint: "clangd is not on PATH. Install LLVM, or add it to PATH.",
  },
];

export function serverFor(language: string): ServerSpec | undefined {
  return SERVERS.find((spec) => spec.languages.includes(language));
}

/**
 * How ready a server is, which is not the same question as whether it is running.
 *
 * A native-codebase server is alive and useless for a long time after it starts, and
 * PRODUCT.md commits to saying so rather than pretending to be instant. `indexing` is a
 * real, common, long-lived state — not a brief blip on the way to `ready`.
 */
export type ServerStatus = "starting" | "indexing" | "ready" | "failed" | "exited";

export interface SessionState {
  status: ServerStatus;
  /** What the server is doing, from its own `$/progress`. */
  detail: string | null;
  /** Its last words when it failed, which is usually the actionable part. */
  error: string | null;
}

interface Doc {
  uri: string;
  languageId: string;
  version: number;
}

export interface SessionHandlers {
  onState: (state: SessionState) => void;
  onDiagnostics: (uri: string, diagnostics: Json[]) => void;
}

export class LspSession {
  readonly spec: ServerSpec;
  readonly client: LspClient;

  #root: WirePath;
  #handlers: SessionHandlers;
  #docs = new Map<string, Doc>();
  #state: SessionState = { status: "starting", detail: null, error: null };
  /** Progress tokens that are open, so `indexing` ends when the last one does. */
  #progress = new Set<string>();
  /**
   * The latest diagnostics per URI, as the server last published them.
   *
   * Kept because the editor is not the only consumer any more. Monaco can only draw
   * markers on files it has a model for, but rust-analyzer reports on the whole crate --
   * and "what else did my edit break?" is a question about the files that are *not*
   * open. Dropping those would make the answer quietly wrong rather than short.
   */
  #diagnostics = new Map<string, Json[]>();
  #stderr: string[] = [];

  constructor(spec: ServerSpec, root: WirePath, handlers: SessionHandlers) {
    this.spec = spec;
    this.#root = root;
    this.#handlers = handlers;
    this.client = new LspClient(
      (message) => {
        // A send to a dead server rejects; the exit event already explains why.
        void lspSend(spec.id, message).catch(() => {});
      },
      {
        onNotification: (method, params) => this.#notification(method, params),
        onLog: (line) => this.#stderr.push(line),
      },
    );
  }

  get state(): SessionState {
    return this.#state;
  }

  #set(next: Partial<SessionState>) {
    this.#state = { ...this.#state, ...next };
    this.#handlers.onState(this.#state);
  }

  async start(): Promise<void> {
    try {
      await lspStart({ id: this.spec.id, command: this.spec.command, root: this.#root }, (event) =>
        this.#event(event),
      );
    } catch (err) {
      const message = err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
      this.#set({
        status: "failed",
        error: /not.?found/i.test(message) ? this.spec.missingHint : message,
      });
      return;
    }

    const result = await this.client.request<{ capabilities?: Json }>("initialize", {
      processId: null,
      clientInfo: { name: "agentide", version: "0.1.0" },
      rootUri: toFileUri(this.#root),
      workspaceFolders: [{ uri: toFileUri(this.#root), name: baseName(this.#root) }],
      capabilities: clientCapabilities(),
    });
    this.client.capabilities = result?.capabilities ?? {};
    this.client.initialized = true;
    this.client.notify("initialized", {});

    // No progress yet does not mean ready: rust-analyzer reports indexing only once it
    // has begun. Anything opened before then still gets synced and re-diagnosed later.
    this.#set({ status: this.#progress.size > 0 ? "indexing" : "ready", error: null });
  }

  #event(event: LspEvent) {
    switch (event.t) {
      case "messages":
        for (const message of event.messages) this.client.receive(message);
        break;
      case "stderr":
        // Kept, not shown: this is where clangd says it cannot find a
        // compile_commands.json, and it is only worth surfacing if the server then dies.
        for (const line of event.lines) this.#stderr.push(line);
        if (this.#stderr.length > 80) this.#stderr.splice(0, this.#stderr.length - 80);
        break;
      case "exited":
        this.client.close(event.message);
        this.#set({
          status: "exited",
          detail: null,
          error: [event.message, this.#stderr[this.#stderr.length - 1]].filter(Boolean).join(" — "),
        });
        break;
    }
  }

  #notification(method: string, params: Json) {
    if (method === "textDocument/publishDiagnostics") {
      const uri = typeof params.uri === "string" ? params.uri : "";
      const diagnostics = Array.isArray(params.diagnostics) ? (params.diagnostics as Json[]) : [];
      if (!uri) return;
      // An empty list is the server saying "this file is clean now", so it replaces the
      // old entry rather than being ignored -- otherwise a fixed error never goes away.
      if (diagnostics.length > 0) this.#diagnostics.set(uri, diagnostics);
      else this.#diagnostics.delete(uri);
      this.#handlers.onDiagnostics(uri, diagnostics);
      return;
    }

    // `$/progress` is how a server says it is alive but not yet useful, which is the
    // state a native codebase spends minutes in.
    if (method === "$/progress") {
      const token = String(params.token ?? "");
      const value = (params.value ?? {}) as Json;
      const kind = value.kind;
      if (kind === "begin") {
        this.#progress.add(token);
        this.#set({ status: "indexing", detail: progressText(value) });
      } else if (kind === "report" && this.#progress.has(token)) {
        this.#set({ detail: progressText(value) });
      } else if (kind === "end") {
        this.#progress.delete(token);
        if (this.#progress.size === 0) this.#set({ status: "ready", detail: null });
      }
    }
  }

  /** Everything this server currently complains about, keyed by URI. */
  get diagnostics(): ReadonlyMap<string, Json[]> {
    return this.#diagnostics;
  }

  /** Whether this server has been told about a file. */
  hasDoc(path: WirePath): boolean {
    return this.#docs.has(toFileUri(path));
  }

  // --- Documents ---------------------------------------------------------------

  /** Tell the server about a file. Safe to call again for one already open. */
  openDoc(path: WirePath, languageId: string, text: string) {
    const uri = toFileUri(path);
    if (this.#docs.has(uri)) return;
    this.#docs.set(uri, { uri, languageId, version: 1 });
    this.client.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  /**
   * Full-text sync on every change.
   *
   * Incremental sync is what a server prefers, but it means deriving ranges from Monaco's
   * change events and one wrong range desynchronises the server silently — every position
   * after it is then wrong, which is worse than the bandwidth. Whole documents are cheap
   * at the size a person edits.
   */
  changeDoc(path: WirePath, text: string) {
    const uri = toFileUri(path);
    const doc = this.#docs.get(uri);
    if (!doc) return;
    doc.version += 1;
    this.client.notify("textDocument/didChange", {
      textDocument: { uri, version: doc.version },
      contentChanges: [{ text }],
    });
  }

  saveDoc(path: WirePath, text: string) {
    const uri = toFileUri(path);
    if (!this.#docs.has(uri)) return;
    this.client.notify("textDocument/didSave", { textDocument: { uri }, text });
  }

  closeDoc(path: WirePath) {
    const uri = toFileUri(path);
    if (!this.#docs.delete(uri)) return;
    this.client.notify("textDocument/didClose", { textDocument: { uri } });
  }

  async stop(): Promise<void> {
    try {
      // The protocol's own goodbye first; `lspStop` would kill it either way, but this
      // is what lets rust-analyzer clean up a `cargo` process it had running.
      await Promise.race([
        this.client.request("shutdown"),
        new Promise((r) => setTimeout(r, 800)),
      ]);
      this.client.notify("exit");
    } catch {
      /* Already gone. */
    }
    await lspStop(this.spec.id).catch(() => {});
  }
}

// --- URIs --------------------------------------------------------------------

/**
 * The inverse of `toFileUri`, which is the app's only path-to-URI function.
 *
 * There is deliberately no second encoder here. A URI makes three trips — we build one,
 * the server echoes its own spelling of it back, and Monaco holds a third spelling on the
 * model — and any two of those disagreeing produces a diagnostic that matches no model.
 * The symptom is "diagnostics never appear", which points nowhere near the cause. So
 * nothing in the adapter compares URI strings: incoming URIs come back through here to a
 * path, and paths are what get matched.
 *
 * Which means this has to accept spellings we would never emit — rust-analyzer sends
 * `file:///c%3A/...` where we sent `file:///C:/...` — and land on the same path.
 */
export function uriToPath(uri: string): WirePath {
  const body = uri.startsWith("file:///")
    ? uri.slice("file:///".length)
    : uri.startsWith("file://")
      ? `//${uri.slice("file://".length)}` // UNC: file://server/share
      : uri;
  let decoded: string;
  try {
    decoded = decodeURIComponent(body);
  } catch {
    decoded = body; // A stray '%' is not worth losing the path over.
  }
  // Windows drive letters are case-insensitive and servers disagree about the case;
  // `WirePath` spells them upper, so normalise or the same file compares unequal.
  return decoded.replace(/^([a-z]):/, (_, letter: string) => `${letter.toUpperCase()}:`) as WirePath;
}

function baseName(path: string): string {
  const parts = path.replace(/\/$/, "").split("/");
  return parts[parts.length - 1] || path;
}

function progressText(value: Json): string | null {
  const title = typeof value.title === "string" ? value.title : null;
  const message = typeof value.message === "string" ? value.message : null;
  const pct = typeof value.percentage === "number" ? `${Math.round(value.percentage)}%` : null;
  return [title, message, pct].filter(Boolean).join(" ") || null;
}
