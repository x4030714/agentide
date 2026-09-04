import { readFile } from "./bridge";
import { HOST_TOOL_NAMES } from "./ide-tool-names";
import type { Json } from "./lsp-client";
import type { LspWorkspace } from "./lsp-monaco";
// The same inverse the editor uses; see `uriToPath` on why nothing compares URI strings.
import { uriToPath as uriPath } from "./lsp-session";
import { monaco } from "./monaco-setup";
import { toFileUri, toolError, toolOk } from "./protocol";
import type { ToolResult, WirePath } from "./protocol";

export { HOST_TOOL_NAMES };

/**
 * The host half of the `ide_*` tools.
 *
 * The sidecar declares these tools and proxies every call here, because the answers only
 * exist on this side: what the user has selected, which buffers are open, and what the
 * language servers currently believe. This file is where an agent stops guessing about
 * the editor and starts reading it.
 *
 * Three rules shape every answer below:
 *
 * 1. **Report the buffer, not the disk.** If the user has unsaved changes, an answer
 *    about the file on disk is an answer about a file that exists for nobody.
 * 2. **Say when the answer is thin.** A server that is still indexing returns real but
 *    incomplete results, and a model that is not told will read "no references" as proof
 *    rather than as "not yet". Every result that could be incomplete says so.
 * 3. **Positions are 1-based going out.** LSP counts from zero; the user's editor, the
 *    transcript's `path:line` links and every error message a compiler prints count from
 *    one. The conversion happens here, once.
 */

export interface IdeHostDeps {
  root: WirePath | null;
  /** The attached workspace, or `null` before one is open. */
  lsp: () => LspWorkspace | null;
  openFile: (
    path: WirePath,
    line?: number,
    column?: number,
    endLine?: number,
    endColumn?: number,
  ) => void;
}

/**
 * What only the editor pane knows: which file it is showing and which buffers have
 * unsaved edits. Published rather than passed, because the alternative is threading two
 * values through every component between the pane and the transcript.
 */
export interface EditorFacts {
  activePath: WirePath | null;
  dirty: ReadonlySet<WirePath>;
}

let editorFacts: EditorFacts = { activePath: null, dirty: new Set() };

export function publishEditorFacts(next: EditorFacts): void {
  editorFacts = next;
}

export async function answerIdeTool(
  name: string,
  args: Json,
  deps: IdeHostDeps,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "ide_open":
        return ideOpen(args, deps);
      case "ide_selection":
        return ideSelection(deps);
      case "ide_open_editors":
        return ideOpenEditors(deps);
      case "ide_diagnostics":
        return ideDiagnostics(args, deps);
      case "ide_definition":
        return await ideDefinition(args, deps);
      case "ide_references":
        return await ideReferences(args, deps);
      case "ide_document_symbols":
        return await ideDocumentSymbols(args, deps);
      case "ide_workspace_symbols":
        return await ideWorkspaceSymbols(args, deps);
      default:
        return toolError(`${name} is not a tool this build answers.`);
    }
  } catch (err) {
    // A thrown error here would leave the call unanswered and stall the turn until the
    // sidecar's timeout. Failing in a way the model can read is always better.
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

// --- The tools -----------------------------------------------------------------

function ideOpen(args: Json, deps: IdeHostDeps): ToolResult {
  const path = resolve(args.path, deps.root);
  if (!path) return toolError("`path` is required.");
  const line = positive(args.line);
  const column = positive(args.column);
  deps.openFile(path, line, column, positive(args.endLine), positive(args.endColumn));
  const where = line ? ` at line ${line}${column ? `:${column}` : ""}` : "";
  return toolOk(`Opened ${display(path, deps.root)}${where} in the user's editor.`);
}

function ideSelection(deps: IdeHostDeps): ToolResult {
  const editor = activeEditor();
  const model = editor?.getModel();
  const selection = editor?.getSelection();
  if (!editor || !model || !selection) {
    return toolOk("No file is open in the editor, so there is no selection.");
  }
  const path = uriPath(model.uri.toString());
  const header = `${display(path, deps.root)}:${selection.startLineNumber}:${selection.startColumn}`;
  if (selection.isEmpty()) {
    return toolOk(
      [
        `Cursor at ${header} (nothing selected).`,
        `Line ${selection.startLineNumber}: ${model.getLineContent(selection.startLineNumber)}`,
      ].join("\n"),
    );
  }
  const text = model.getValueInRange(selection);
  return toolOk(
    [
      `Selected ${header}-${selection.endLineNumber}:${selection.endColumn}`,
      `(${countLines(text)} lines, ${text.length} characters)`,
      "",
      text,
    ].join("\n"),
  );
}

function ideOpenEditors(deps: IdeHostDeps): ToolResult {
  const models = monaco.editor
    .getModels()
    .filter((model) => model.uri.scheme === "file" && !model.isDisposed());
  if (models.length === 0) return toolOk("No files are open in the editor.");

  const active = editorFacts.activePath;
  const rows = models.map((model) => {
    const path = uriPath(model.uri.toString());
    const marks = [
      path === active ? "focused" : null,
      editorFacts.dirty.has(path) ? "unsaved changes" : null,
    ].filter(Boolean);
    return `${display(path, deps.root)}  (${model.getLineCount()} lines${
      marks.length > 0 ? `, ${marks.join(", ")}` : ""
    })`;
  });
  return toolOk(
    [`${models.length} file${models.length === 1 ? "" : "s"} open:`, ...rows].join("\n"),
  );
}

const SEVERITY_NAMES = ["error", "warning", "info", "hint"] as const;

function ideDiagnostics(args: Json, deps: IdeHostDeps): ToolResult {
  const lsp = deps.lsp();
  if (!lsp) return toolError("No workspace is open.");

  const only = args.path === undefined ? null : resolve(args.path, deps.root);
  if (args.path !== undefined && !only) return toolError("`path` is not a usable path.");
  const floor = SEVERITY_NAMES.indexOf(
    (typeof args.severity === "string" ? args.severity : "warning") as (typeof SEVERITY_NAMES)[number],
  );
  const maxSeverity = floor < 0 ? 2 : floor + 1;

  // A whole-workspace query on a crate mid-refactor can be hundreds of diagnostics, and
  // dumping them costs the model more context than the answer is worth.
  const CAP = 200;
  const lines: string[] = [];
  let shown = 0;
  let total = 0;
  for (const [path, diagnostics] of [...lsp.diagnostics()].sort(byPath)) {
    if (only && path !== only) continue;
    const kept = diagnostics
      .filter((diagnostic) => numberOr(diagnostic.severity, 1) <= maxSeverity)
      .sort((a, b) => lineOf(a) - lineOf(b));
    total += kept.length;
    for (const diagnostic of kept) {
      if (shown >= CAP) continue;
      const start = startOf(diagnostic);
      const severity = SEVERITY_NAMES[numberOr(diagnostic.severity, 1) - 1] ?? "error";
      const source = typeof diagnostic.source === "string" ? ` [${diagnostic.source}]` : "";
      lines.push(
        `${display(path, deps.root)}:${start.line}:${start.column}  ${severity}${source}  ${flatten(
          String(diagnostic.message ?? ""),
        )}`,
      );
      shown += 1;
    }
  }

  const note = lsp.statusNote();
  if (shown === 0) {
    const scope = only ? display(only, deps.root) : "the workspace";
    return toolOk(
      [`No diagnostics at or above '${SEVERITY_NAMES[maxSeverity - 1]}' in ${scope}.`, note]
        .filter(Boolean)
        .join("\n"),
    );
  }
  const truncated =
    total > shown ? `… ${total - shown} more not listed; narrow with \`path\`.` : null;
  return toolOk(
    [`${total} diagnostic${total === 1 ? "" : "s"}:`, ...lines, truncated, note]
      .filter(Boolean)
      .join("\n"),
  );
}

async function ideDefinition(args: Json, deps: IdeHostDeps): Promise<ToolResult> {
  const at = position(args, deps.root);
  if ("error" in at) return toolError(at.error);
  const lsp = deps.lsp();
  if (!lsp) return toolError("No workspace is open.");

  const result = await lsp.ask<Json | Json[]>(at.path, "textDocument/definition", {
    position: { line: at.line - 1, character: at.column - 1 },
  });
  if (result && typeof result === "object" && "error" in result) {
    return toolError(String((result as { error: string }).error));
  }
  const locations = asLocations(result);
  if (locations.length === 0) {
    return toolOk(
      [
        `No definition found at ${display(at.path, deps.root)}:${at.line}:${at.column}.`,
        lsp.statusNote(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  const rows = await Promise.all(
    locations.slice(0, 20).map(async (location) => {
      const text = await lineAt(location.path, location.line);
      return `${display(location.path, deps.root)}:${location.line}:${location.column}${
        text ? `  ${flatten(text)}` : ""
      }`;
    }),
  );
  return toolOk([`${locations.length} definition${locations.length === 1 ? "" : "s"}:`, ...rows].join("\n"));
}

async function ideReferences(args: Json, deps: IdeHostDeps): Promise<ToolResult> {
  const at = position(args, deps.root);
  if ("error" in at) return toolError(at.error);
  const lsp = deps.lsp();
  if (!lsp) return toolError("No workspace is open.");

  const result = await lsp.ask<Json[]>(at.path, "textDocument/references", {
    position: { line: at.line - 1, character: at.column - 1 },
    context: { includeDeclaration: args.includeDeclaration !== false },
  });
  if (result && !Array.isArray(result) && "error" in result) {
    return toolError(String((result as { error: string }).error));
  }
  const locations = asLocations(result);
  const note = lsp.statusNote();
  if (locations.length === 0) {
    return toolOk(
      [`No references found at ${display(at.path, deps.root)}:${at.line}:${at.column}.`, note]
        .filter(Boolean)
        .join("\n"),
    );
  }

  // Grouped by file, because "which files does this touch" is the question behind almost
  // every reference search, and a flat list of 200 lines buries it.
  const byFile = new Map<WirePath, typeof locations>();
  for (const location of locations) {
    const bucket = byFile.get(location.path);
    if (bucket) bucket.push(location);
    else byFile.set(location.path, [location]);
  }
  const CAP = 200;
  const lines: string[] = [];
  let shown = 0;
  for (const [path, group] of [...byFile].sort(byPath)) {
    lines.push(`${display(path, deps.root)}  (${group.length})`);
    for (const location of group) {
      if (shown >= CAP) break;
      lines.push(`  :${location.line}:${location.column}`);
      shown += 1;
    }
  }
  const truncated = locations.length > shown ? `… ${locations.length - shown} more not listed.` : null;
  return toolOk(
    [
      `${locations.length} reference${locations.length === 1 ? "" : "s"} in ${byFile.size} file${
        byFile.size === 1 ? "" : "s"
      }:`,
      ...lines,
      truncated,
      note,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

/** LSP `SymbolKind`, 1-based. Names, because a number means nothing in a tool result. */
const SYMBOL_KINDS = [
  "file", "module", "namespace", "package", "class", "method", "property", "field",
  "constructor", "enum", "interface", "function", "variable", "constant", "string",
  "number", "boolean", "array", "object", "key", "null", "enum member", "struct",
  "event", "operator", "type parameter",
];

function symbolKind(kind: unknown): string {
  return SYMBOL_KINDS[numberOr(kind, 0) - 1] ?? "symbol";
}

async function ideDocumentSymbols(args: Json, deps: IdeHostDeps): Promise<ToolResult> {
  const path = resolve(args.path, deps.root);
  if (!path) return toolError("`path` is required.");
  const lsp = deps.lsp();
  if (!lsp) return toolError("No workspace is open.");

  const result = await lsp.ask<Json[]>(path, "textDocument/documentSymbol", {});
  if (result && !Array.isArray(result) && "error" in result) {
    return toolError(String((result as { error: string }).error));
  }
  const symbols = Array.isArray(result) ? result : [];
  if (symbols.length === 0) {
    return toolOk(
      [`No symbols reported for ${display(path, deps.root)}.`, lsp.statusNote()]
        .filter(Boolean)
        .join("\n"),
    );
  }

  // `DocumentSymbol` nests and `SymbolInformation` does not; servers pick either. The
  // nested form is the useful one, so flatten it with indentation that keeps the shape.
  const lines: string[] = [];
  const walk = (entries: Json[], depth: number) => {
    for (const entry of entries) {
      const range = (entry.selectionRange ?? entry.range ?? (entry.location as Json)?.range) as Json;
      const start = startOf({ range });
      const detail = typeof entry.detail === "string" && entry.detail ? `  ${entry.detail}` : "";
      lines.push(
        `${"  ".repeat(depth)}:${start.line}  ${symbolKind(entry.kind)}  ${String(entry.name ?? "")}${detail}`,
      );
      if (Array.isArray(entry.children)) walk(entry.children as Json[], depth + 1);
    }
  };
  walk(symbols, 0);
  return toolOk([`${display(path, deps.root)}:`, ...lines].join("\n"));
}

async function ideWorkspaceSymbols(args: Json, deps: IdeHostDeps): Promise<ToolResult> {
  const query = typeof args.query === "string" ? args.query : "";
  if (!query) return toolError("`query` is required.");
  const lsp = deps.lsp();
  if (!lsp) return toolError("No workspace is open.");

  const symbols = await lsp.workspaceSymbols(query);
  const note = lsp.statusNote();
  if (symbols.length === 0) {
    return toolOk(
      [
        `No symbols matching '${query}'.`,
        note ?? "Servers index lazily; a symbol in a file nobody has opened may not be known yet.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  const CAP = 100;
  const rows = symbols.slice(0, CAP).map((symbol) => {
    const location = (symbol.location ?? {}) as Json;
    const uri = typeof location.uri === "string" ? location.uri : String(symbol.uri ?? "");
    const start = startOf({ range: (location.range ?? symbol.range) as Json });
    const container =
      typeof symbol.containerName === "string" && symbol.containerName
        ? `${symbol.containerName}::`
        : "";
    const where = uri ? `${display(uriPath(uri), deps.root)}:${start.line}` : "?";
    return `${where}  ${symbolKind(symbol.kind)}  ${container}${String(symbol.name ?? "")}`;
  });
  const truncated = symbols.length > CAP ? `… ${symbols.length - CAP} more not listed.` : null;
  return toolOk(
    [`${symbols.length} symbol${symbols.length === 1 ? "" : "s"}:`, ...rows, truncated, note]
      .filter(Boolean)
      .join("\n"),
  );
}

// --- Shared ---------------------------------------------------------------------

/**
 * Accept both an absolute path and one relative to the workspace root.
 *
 * The schemas ask for absolute, but results are printed workspace-relative because that
 * is what a person reads -- so a model copying a path out of one result into the next
 * call sends a relative one. Rejecting that would be pedantry with a retry attached.
 */
function resolve(value: unknown, root: WirePath | null): WirePath | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const path = value.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[A-Za-z]:\//.test(path) || path.startsWith("//")) {
    return path.replace(/^([a-z]):/, (_, letter: string) => `${letter.toUpperCase()}:`) as WirePath;
  }
  if (!root) return null;
  return `${root.replace(/\/$/, "")}/${path.replace(/^\.?\//, "")}` as WirePath;
}

/** Workspace-relative for reading; absolute only when it is outside the workspace. */
function display(path: WirePath, root: WirePath | null): string {
  if (!root) return path;
  const base = `${root.replace(/\/$/, "")}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

function position(
  args: Json,
  root: WirePath | null,
): { path: WirePath; line: number; column: number } | { error: string } {
  const path = resolve(args.path, root);
  if (!path) return { error: "`path` is required." };
  const line = positive(args.line);
  if (!line) return { error: "`line` is required and is 1-based." };
  return { path, line, column: positive(args.column) ?? 1 };
}

function activeEditor(): ReturnType<typeof monaco.editor.getEditors>[number] | null {
  const editors = monaco.editor.getEditors().filter((editor) => {
    const model = editor.getModel();
    return model && !model.isDisposed() && model.uri.scheme === "file";
  });
  // The focused one if any has focus, else the only one there is.
  return editors.find((editor) => editor.hasTextFocus()) ?? editors[0] ?? null;
}

interface Located {
  path: WirePath;
  line: number;
  column: number;
}

/** `Location`, `Location[]` and `LocationLink[]`, all reduced to 1-based positions. */
function asLocations(value: unknown): Located[] {
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  const out: Located[] = [];
  for (const entry of entries) {
    const location = entry as Json;
    const uri = location.uri ?? location.targetUri;
    if (typeof uri !== "string") continue;
    const range = (location.targetSelectionRange ?? location.targetRange ?? location.range) as Json;
    const start = startOf({ range });
    out.push({ path: uriPath(uri), line: start.line, column: start.column });
  }
  return out;
}

/** The buffer's line if the file is open, the disk's if it is not, `null` if neither. */
async function lineAt(path: WirePath, line: number): Promise<string | null> {
  const model = monaco.editor.getModel(monaco.Uri.parse(toFileUri(path)));
  if (model && !model.isDisposed()) {
    if (line < 1 || line > model.getLineCount()) return null;
    return model.getLineContent(line).trim();
  }
  try {
    const contents = await readFile(path);
    return contents.text.split("\n")[line - 1]?.trim() ?? null;
  } catch {
    return null;
  }
}

function startOf(holder: { range?: unknown } | Json): { line: number; column: number } {
  const range = (holder as Json).range as Json | undefined;
  const start = (range?.start ?? {}) as Json;
  return { line: numberOr(start.line, 0) + 1, column: numberOr(start.character, 0) + 1 };
}

function lineOf(diagnostic: Json): number {
  return startOf(diagnostic).line;
}

function byPath(a: [WirePath, unknown], b: [WirePath, unknown]): number {
  return a[0].localeCompare(b[0]);
}

/** One line: a message with newlines in it wrecks a `path:line  message` listing. */
function flatten(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

function countLines(text: string): number {
  return text.split("\n").length;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
