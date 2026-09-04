import type {
  IDisposable,
  IMarkdownString,
  IPosition,
  IRange,
  MarkerSeverity,
  editor as MonacoNs,
  languages,
} from "monaco-editor";

import { readFile } from "./bridge";
import type { Json } from "./lsp-client";
import { LspSession, SERVERS, serverFor, uriToPath } from "./lsp-session";
import type { ServerSpec, SessionState } from "./lsp-session";
import { monaco } from "./monaco-setup";
import { baseName, toFileUri } from "./protocol";
import type { WirePath } from "./protocol";

/**
 * Where the language servers meet the editor.
 *
 * `lsp-client` owns the protocol and `lsp-session` owns one server; this owns the join:
 * which models are synced, where diagnostics are drawn, and which Monaco providers ask
 * which server. It is the only file that imports both sides.
 *
 * Two decisions shape it:
 *
 * 1. **Document sync is driven off Monaco's model events, not off the editor pane.** The
 *    server is then told about exactly the text Monaco holds, by construction. Driving it
 *    from the pane instead means every new way of opening a file is a new way to forget,
 *    and a server that is one edit behind reports errors on lines that have moved.
 * 2. **A provider that cannot answer returns null, quietly.** These run on every
 *    keystroke, and a server mid-index legitimately refuses requests (`ContentModified`
 *    is normal, not a fault). Surfacing that would be noise on a schedule; server health
 *    is reported once, by status, instead.
 */

export interface WorkspaceHandlers {
  /** Server health, per server id, for the status surface. */
  onState: (id: string, spec: ServerSpec, state: SessionState) => void;
  /** Navigate the app to a file — go-to-definition landing in another file. */
  openFile: (path: WirePath, line?: number, column?: number) => void;
}

/**
 * Monaco's provider registry is global and per-language, so two attached workspaces would
 * register two of every provider and every completion would arrive twice. One at a time
 * is not a convenience here, it is the shape of the thing being wrapped.
 */
let attached: LspWorkspace | null = null;

export class LspWorkspace {
  #root: WirePath;
  #handlers: WorkspaceHandlers;
  #sessions = new Map<string, LspSession>();
  /** In-flight starts, so two models of one language do not spawn two servers. */
  #starting = new Map<string, Promise<void>>();
  #disposables: IDisposable[] = [];
  #modelSubs = new Map<string, IDisposable[]>();
  #disposed = false;

  constructor(root: WirePath, handlers: WorkspaceHandlers) {
    this.#root = root;
    this.#handlers = handlers;
  }

  /** Attach to Monaco. One workspace may be attached at a time. */
  start(): void {
    if (attached && attached !== this) {
      throw new Error("an LspWorkspace is already attached; dispose it first");
    }
    attached = this;
    for (const language of languagesWeServe()) {
      this.#registerProviders(language);
    }
    this.#disposables.push(
      monaco.editor.onDidCreateModel((model) => this.#adopt(model)),
      monaco.editor.registerEditorOpener({
        openCodeEditor: (source, resource, selectionOrPosition) =>
          this.#openEditor(source, resource, selectionOrPosition),
      }),
    );
    // Models that existed before we attached — the editor mounts before this does.
    for (const model of monaco.editor.getModels()) this.#adopt(model);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    if (attached === this) attached = null;
    // Models outlive us -- Monaco owns them globally, and switching workspace does not
    // dispose them. Leaving our markers behind would show the last project's errors on
    // this project's files, with no server running to ever correct them.
    for (const model of monaco.editor.getModels()) {
      for (const spec of SERVERS) monaco.editor.setModelMarkers(model, `lsp:${spec.id}`, []);
    }
    for (const disposable of this.#disposables) disposable.dispose();
    this.#disposables = [];
    for (const [, subs] of this.#modelSubs) for (const sub of subs) sub.dispose();
    this.#modelSubs.clear();
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(sessions.map((session) => session.stop()));
  }

  /** Every server that has been asked for, running or not, for the status surface. */
  get sessions(): LspSession[] {
    return [...this.#sessions.values()];
  }

  // --- Documents ---------------------------------------------------------------

  #adopt(model: MonacoNs.ITextModel): void {
    const path = modelPath(model);
    if (!path || !this.#inWorkspace(path)) return;
    const spec = serverFor(model.getLanguageId());
    if (!spec) return;

    const subs = [
      model.onDidChangeContent(() => {
        const session = this.#sessions.get(spec.id);
        session?.changeDoc(path, model.getValue());
      }),
      model.onWillDispose(() => {
        this.#sessions.get(spec.id)?.closeDoc(path);
        for (const sub of this.#modelSubs.get(model.uri.toString()) ?? []) sub.dispose();
        this.#modelSubs.delete(model.uri.toString());
      }),
    ];
    this.#modelSubs.set(model.uri.toString(), subs);

    void this.#ensureSession(spec).then(() => {
      // The model can be gone by the time a cold server has started.
      if (model.isDisposed()) return;
      this.#sessions
        .get(spec.id)
        ?.openDoc(path, model.getLanguageId(), model.getValue());
    });
  }

  /**
   * Tell the server a file was written.
   *
   * Not derivable from Monaco: a model has no notion of saved. It matters because
   * rust-analyzer's `cargo check` diagnostics — the type errors, as opposed to the
   * parse errors — are produced on save and on nothing else.
   */
  didSave(path: WirePath, text: string): void {
    for (const session of this.#sessions.values()) session.saveDoc(path, text);
  }

  #inWorkspace(path: WirePath): boolean {
    const root = this.#root.replace(/\/$/, "");
    return path === root || path.startsWith(`${root}/`);
  }

  // --- For the agent's tools ---------------------------------------------------
  //
  // The editor only ever asks about a model it already has. A tool asks about a path,
  // which may be a file nobody has opened -- so everything below starts by making sure
  // some server has been told the file exists.

  /**
   * Get a server ready to answer about `path`, opening the document if needed.
   *
   * Returns the reason it cannot, rather than throwing, because "no server for .py" and
   * "rust-analyzer is still indexing" are both answers the model can act on, and an
   * exception here would read to it as a broken tool.
   */
  async ensureOpen(path: WirePath): Promise<{ session: LspSession } | { error: string }> {
    if (!this.#inWorkspace(path)) {
      return { error: `${path} is outside the open workspace.` };
    }
    const language = languageForPath(path);
    const spec = language ? serverFor(language) : undefined;
    if (!spec || !language) {
      return { error: `No language server is configured for ${baseName(path)}.` };
    }
    await this.#ensureSession(spec);
    const session = this.#sessions.get(spec.id);
    if (!session) return { error: `${spec.id} could not be started.` };
    if (session.state.status === "failed" || session.state.status === "exited") {
      return { error: session.state.error ?? `${spec.id} is not running.` };
    }
    if (!session.client.initialized) return { error: `${spec.id} is still starting.` };

    if (!session.hasDoc(path)) {
      // Prefer the editor's buffer: a tool that answers about the file on disk while the
      // user is looking at unsaved changes is answering about a file nobody has.
      const model = monaco.editor.getModel(monaco.Uri.parse(toFileUri(path)));
      const text = model ? model.getValue() : (await readFile(path)).text;
      session.openDoc(path, language, text);
    }
    return { session };
  }

  /** One LSP request about a file, for a tool rather than for a provider. */
  async ask<T>(path: WirePath, method: string, params: Json): Promise<T | { error: string }> {
    const ready = await this.ensureOpen(path);
    if ("error" in ready) return ready;
    try {
      return await ready.session.client.request<T>(method, {
        textDocument: { uri: toFileUri(path) },
        ...params,
      });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Symbols across the project, from every server that is running. */
  async workspaceSymbols(query: string): Promise<Json[]> {
    const running = [...this.#sessions.values()].filter((session) => session.client.initialized);
    const results = await Promise.all(
      running.map((session) =>
        session.client
          .request<Json[] | null>("workspace/symbol", { query })
          .catch(() => null),
      ),
    );
    return results.flatMap((result) => (Array.isArray(result) ? result : []));
  }

  /**
   * Every diagnostic every server currently holds, by path.
   *
   * Not read from Monaco's markers: those exist only for files with a model, and the
   * question a tool is asking is usually about the files that are not open.
   */
  diagnostics(): Map<WirePath, Json[]> {
    const merged = new Map<WirePath, Json[]>();
    for (const session of this.#sessions.values()) {
      for (const [uri, diagnostics] of session.diagnostics) {
        const path = uriToPath(uri);
        const existing = merged.get(path);
        if (existing) existing.push(...diagnostics);
        else merged.set(path, [...diagnostics]);
      }
    }
    return merged;
  }

  /** Server health as one line, so a tool can say why an answer is thin. */
  statusNote(): string | null {
    const busy = [...this.#sessions.values()].filter(
      (session) => session.state.status === "starting" || session.state.status === "indexing",
    );
    if (busy.length === 0) return null;
    return `${busy
      .map((session) => `${session.spec.id} is ${session.state.status}`)
      .join(", ")} — results may be incomplete.`;
  }

  // --- Servers -----------------------------------------------------------------

  #ensureSession(spec: ServerSpec): Promise<void> {
    const existing = this.#starting.get(spec.id);
    if (existing) return existing;
    if (this.#sessions.has(spec.id)) return Promise.resolve();

    const session = new LspSession(spec, this.#root, {
      onState: (state) => this.#handlers.onState(spec.id, spec, state),
      onDiagnostics: (uri, diagnostics) => this.#diagnostics(spec, uri, diagnostics),
    });
    this.#sessions.set(spec.id, session);
    this.#handlers.onState(spec.id, spec, session.state);

    const started = session
      .start()
      .catch(() => {
        /* `start` reports its own failure through `onState`. */
      })
      .finally(() => {
        this.#starting.delete(spec.id);
        if (this.#disposed) void session.stop();
      });
    this.#starting.set(spec.id, started);
    return started;
  }

  #session(model: MonacoNs.ITextModel): LspSession | null {
    const spec = serverFor(model.getLanguageId());
    if (!spec) return null;
    const session = this.#sessions.get(spec.id);
    if (!session || !session.client.initialized) return null;
    return session;
  }

  /**
   * The `textDocument` a request is about, or `null` when the model is not a file --
   * a diff view or a scratch buffer can carry a language we serve, and asking a server
   * about a document it was never told exists is a protocol error, not a missing answer.
   */
  #doc(model: MonacoNs.ITextModel): Json | null {
    const path = modelPath(model);
    return path ? { uri: toFileUri(path) } : null;
  }

  async #request<T>(
    model: MonacoNs.ITextModel,
    method: string,
    params: Json,
  ): Promise<T | null> {
    const session = this.#session(model);
    if (!session) return null;
    try {
      return await session.client.request<T>(method, params);
    } catch {
      // `ContentModified` while typing, or a server that just died. Both mean "no answer
      // for this keystroke", and neither is worth a popup.
      return null;
    }
  }

  // --- Diagnostics -------------------------------------------------------------

  #diagnostics(spec: ServerSpec, uri: string, diagnostics: Json[]): void {
    const path = uriToPath(uri);
    const model = monaco.editor.getModel(monaco.Uri.parse(toFileUri(path)));
    // A file we have not opened: rust-analyzer reports on the whole crate, so most of
    // these are for files with no model. Nothing to draw them on.
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      `lsp:${spec.id}`,
      diagnostics.map((diagnostic) => toMarker(diagnostic)),
    );
  }

  // --- Navigation --------------------------------------------------------------

  #openEditor(
    source: MonacoNs.ICodeEditor | null,
    resource: { toString(): string; scheme?: string },
    selectionOrPosition?: IRange | IPosition,
  ): boolean {
    const target = resource.toString();
    const line =
      selectionOrPosition && "startLineNumber" in selectionOrPosition
        ? selectionOrPosition.startLineNumber
        : (selectionOrPosition as IPosition | undefined)?.lineNumber;
    const column =
      selectionOrPosition && "startColumn" in selectionOrPosition
        ? selectionOrPosition.startColumn
        : (selectionOrPosition as IPosition | undefined)?.column;

    // Same file: reveal it here. Monaco consults the opener before its own handling, so
    // returning false for this case would silently drop the jump.
    const current = source?.getModel();
    if (current && current.uri.toString() === target) {
      if (line) {
        source?.setPosition({ lineNumber: line, column: column ?? 1 });
        source?.revealLineInCenter(line);
      }
      return true;
    }
    if (!target.startsWith("file:")) return false;
    this.#handlers.openFile(uriToPath(target), line, column);
    return true;
  }

  // --- Providers ---------------------------------------------------------------

  #registerProviders(language: string): void {
    const self = this;

    this.#disposables.push(
      monaco.languages.registerCompletionItemProvider(language, {
        // A conservative superset: servers advertise their own in
        // `completionProvider.triggerCharacters`, but that arrives after registration,
        // and re-registering per server would leave a window with no completions at all.
        triggerCharacters: [".", ":", ">", "-", "&", "#", "<", '"', "/", "'", "(", "@"],
        async provideCompletionItems(model, position, _context, _token) {
          const doc = self.#doc(model);
          if (!doc) return { suggestions: [] };
          const result = await self.#request<Json | Json[]>(model, "textDocument/completion", {
            textDocument: doc,
            position: toLspPosition(position),
          });
          if (!result) return { suggestions: [] };
          const list = Array.isArray(result) ? result : ((result.items as Json[]) ?? []);
          const incomplete = !Array.isArray(result) && result.isIncomplete === true;
          const word = model.getWordUntilPosition(position);
          const fallback: IRange = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };
          return {
            incomplete,
            suggestions: list.map((item) => toCompletion(item, fallback)),
          };
        },
        async resolveCompletionItem(item, _token) {
          const original = (item as CompletionWithSource).__lsp;
          const model = (item as CompletionWithSource).__model;
          if (!original || !model || model.isDisposed()) return item;
          const resolved = await self.#request<Json>(model, "completionItem/resolve", original);
          if (!resolved) return item;
          const documentation = toMarkdown(resolved.documentation);
          return {
            ...item,
            detail: typeof resolved.detail === "string" ? resolved.detail : item.detail,
            documentation: documentation ?? item.documentation,
            additionalTextEdits: toTextEdits(resolved.additionalTextEdits),
          };
        },
      }),

      monaco.languages.registerHoverProvider(language, {
        async provideHover(model, position) {
          const doc = self.#doc(model);
          if (!doc) return null;
          const result = await self.#request<Json>(model, "textDocument/hover", {
            textDocument: doc,
            position: toLspPosition(position),
          });
          if (!result) return null;
          const contents = hoverContents(result.contents);
          if (contents.length === 0) return null;
          return {
            contents,
            range: isRange(result.range) ? toMonacoRange(result.range) : undefined,
          };
        },
      }),

      monaco.languages.registerDefinitionProvider(language, {
        async provideDefinition(model, position) {
          const doc = self.#doc(model);
          if (!doc) return [];
          const result = await self.#request<Json | Json[]>(model, "textDocument/definition", {
            textDocument: doc,
            position: toLspPosition(position),
          });
          return toLocations(result);
        },
      }),

      monaco.languages.registerReferenceProvider(language, {
        async provideReferences(model, position, context) {
          const doc = self.#doc(model);
          if (!doc) return [];
          const result = await self.#request<Json[]>(model, "textDocument/references", {
            textDocument: doc,
            position: toLspPosition(position),
            context: { includeDeclaration: context.includeDeclaration },
          });
          return toLocations(result);
        },
      }),

      monaco.languages.registerSignatureHelpProvider(language, {
        signatureHelpTriggerCharacters: ["(", ","],
        async provideSignatureHelp(model, position) {
          const doc = self.#doc(model);
          if (!doc) return null;
          const result = await self.#request<Json>(model, "textDocument/signatureHelp", {
            textDocument: doc,
            position: toLspPosition(position),
          });
          const signatures = Array.isArray(result?.signatures) ? (result.signatures as Json[]) : [];
          if (signatures.length === 0) return null;
          return {
            value: {
              signatures: signatures.map((signature) => ({
                label: String(signature.label ?? ""),
                documentation: toMarkdown(signature.documentation),
                parameters: (Array.isArray(signature.parameters) ? signature.parameters : []).map(
                  (parameter) => {
                    const p = parameter as Json;
                    return {
                      label: (p.label as string | [number, number]) ?? "",
                      documentation: toMarkdown(p.documentation),
                    };
                  },
                ),
              })),
              activeSignature: numberOr(result?.activeSignature, 0),
              activeParameter: numberOr(result?.activeParameter, 0),
            },
            dispose() {},
          };
        },
      }),
    );
  }
}

// --- Conversions ---------------------------------------------------------------
//
// LSP counts lines and characters from zero; Monaco counts from one. Every boundary
// crossing below is that off-by-one, and getting one wrong puts a squiggle on the line
// above the mistake -- which looks like the server being wrong, not us.

/**
 * The language id Monaco would give this file, asked of Monaco itself rather than kept
 * as a second extension table here. A tool can name a file nobody has opened, so there
 * is no model to read the language off -- but the answer still has to match the one the
 * editor would produce, or a tool and the editor would disagree about which server owns
 * a file.
 */
function languageForPath(path: WirePath): string | null {
  const name = baseName(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = name.slice(dot);
  for (const language of monaco.languages.getLanguages()) {
    if (language.extensions?.some((candidate) => candidate.toLowerCase() === extension)) {
      return language.id;
    }
  }
  return null;
}

function languagesWeServe(): string[] {
  return [...new Set(SERVERS.flatMap((spec) => spec.languages))];
}

/** `null` for anything that is not a real file: diff views, scratch models. */
function modelPath(model: MonacoNs.ITextModel): WirePath | null {
  if (model.uri.scheme !== "file") return null;
  return uriToPath(model.uri.toString());
}

function toLspPosition(position: IPosition): Json {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

function isRange(value: unknown): value is LspRange {
  const range = value as LspRange | undefined;
  return !!range && typeof range.start?.line === "number" && typeof range.end?.line === "number";
}

function toMonacoRange(range: LspRange): IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

const SEVERITY: Record<number, MarkerSeverity> = {
  1: monaco.MarkerSeverity.Error,
  2: monaco.MarkerSeverity.Warning,
  3: monaco.MarkerSeverity.Info,
  4: monaco.MarkerSeverity.Hint,
};

function toMarker(diagnostic: Json): MonacoNs.IMarkerData {
  const range = isRange(diagnostic.range)
    ? toMonacoRange(diagnostic.range)
    : { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
  const code = diagnostic.code;
  return {
    ...range,
    // An absent severity means Error in LSP, which is also the safest default: a real
    // error shown as a hint is a missed error.
    severity: SEVERITY[numberOr(diagnostic.severity, 1)] ?? monaco.MarkerSeverity.Error,
    message: String(diagnostic.message ?? ""),
    source: typeof diagnostic.source === "string" ? diagnostic.source : undefined,
    code:
      typeof code === "string" || typeof code === "number"
        ? String(code)
        : typeof (code as Json)?.value === "string"
          ? String((code as Json).value)
          : undefined,
    relatedInformation: Array.isArray(diagnostic.relatedInformation)
      ? (diagnostic.relatedInformation as Json[])
          .map((related) => {
            const location = related.location as Json | undefined;
            if (!location || !isRange(location.range)) return null;
            return {
              resource: monaco.Uri.parse(toFileUri(uriToPath(String(location.uri)))),
              message: String(related.message ?? ""),
              ...toMonacoRange(location.range),
            };
          })
          .filter((related): related is NonNullable<typeof related> => related !== null)
      : undefined,
  };
}

/**
 * LSP and Monaco both have a `CompletionItemKind`, and they number them differently.
 * Mapping by name rather than by value, so a new kind in either enum cannot silently
 * turn a method into a colour swatch.
 */
const LSP_COMPLETION_KINDS = [
  "Text", "Method", "Function", "Constructor", "Field", "Variable", "Class", "Interface",
  "Module", "Property", "Unit", "Value", "Enum", "Keyword", "Snippet", "Color", "File",
  "Reference", "Folder", "EnumMember", "Constant", "Struct", "Event", "Operator",
  "TypeParameter",
] as const;

function completionKind(kind: unknown): languages.CompletionItemKind {
  const name = LSP_COMPLETION_KINDS[numberOr(kind, 1) - 1];
  const kinds = monaco.languages.CompletionItemKind as unknown as Record<string, number>;
  return (name && name in kinds ? kinds[name] : kinds.Text) as languages.CompletionItemKind;
}

interface CompletionWithSource extends languages.CompletionItem {
  __lsp?: Json;
  __model?: MonacoNs.ITextModel;
}

function toCompletion(item: Json, fallback: IRange): languages.CompletionItem {
  const label = typeof item.label === "string" ? item.label : String(item.label ?? "");
  const edit = item.textEdit as Json | undefined;
  const insertText = String(edit?.newText ?? item.insertText ?? label);

  let range: languages.CompletionItem["range"] = fallback;
  if (edit) {
    if (isRange(edit.range)) {
      range = toMonacoRange(edit.range);
    } else if (isRange(edit.insert) && isRange(edit.replace)) {
      // `InsertReplaceEdit`: Monaco takes both and picks by whether the user held the
      // modifier, which is exactly what the two ranges are for.
      range = { insert: toMonacoRange(edit.insert), replace: toMonacoRange(edit.replace) };
    }
  }

  const completion: CompletionWithSource = {
    label,
    kind: completionKind(item.kind),
    insertText,
    range,
    detail: typeof item.detail === "string" ? item.detail : undefined,
    documentation: toMarkdown(item.documentation),
    filterText: typeof item.filterText === "string" ? item.filterText : undefined,
    sortText: typeof item.sortText === "string" ? item.sortText : undefined,
    preselect: item.preselect === true,
    insertTextRules:
      item.insertTextFormat === 2
        ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
        : undefined,
    additionalTextEdits: toTextEdits(item.additionalTextEdits),
    __lsp: item,
  };
  return completion;
}

function toTextEdits(value: unknown): MonacoNs.ISingleEditOperation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const edits = value
    .map((entry) => {
      const edit = entry as Json;
      if (!isRange(edit.range)) return null;
      return { range: toMonacoRange(edit.range), text: String(edit.newText ?? "") };
    })
    .filter((edit): edit is NonNullable<typeof edit> => edit !== null);
  return edits.length > 0 ? edits : undefined;
}

function toMarkdown(value: unknown): IMarkdownString | undefined {
  if (typeof value === "string") return value ? { value } : undefined;
  const markup = value as Json | undefined;
  if (markup && typeof markup.value === "string" && markup.value) return { value: markup.value };
  return undefined;
}

/**
 * `Hover.contents` has four shapes across LSP versions, and rust-analyzer and clangd do
 * not pick the same one. All four collapse to markdown.
 */
function hoverContents(value: unknown): IMarkdownString[] {
  const one = (entry: unknown): IMarkdownString | null => {
    if (typeof entry === "string") return entry ? { value: entry } : null;
    const marked = entry as Json | undefined;
    if (!marked || typeof marked.value !== "string" || !marked.value) return null;
    // A `MarkedString` is a code block waiting to be fenced; `MarkupContent` is not.
    return typeof marked.language === "string"
      ? { value: `\`\`\`${marked.language}\n${marked.value}\n\`\`\`` }
      : { value: marked.value };
  };
  const entries = Array.isArray(value) ? value : [value];
  return entries.map(one).filter((entry): entry is IMarkdownString => entry !== null);
}

/** `Location`, `Location[]` and `LocationLink[]` all mean the same thing to Monaco. */
function toLocations(value: unknown): languages.Location[] {
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  return entries
    .map((entry) => {
      const location = entry as Json;
      const uri = location.uri ?? location.targetUri;
      const range = isRange(location.targetSelectionRange)
        ? location.targetSelectionRange
        : isRange(location.targetRange)
          ? location.targetRange
          : location.range;
      if (typeof uri !== "string" || !isRange(range)) return null;
      return {
        uri: monaco.Uri.parse(toFileUri(uriToPath(uri))),
        range: toMonacoRange(range),
      };
    })
    .filter((location): location is languages.Location => location !== null);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
