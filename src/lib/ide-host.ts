import {
  listBackground,
  readBackground,
  runInAgentTerminal,
  startBackground,
  stopBackground,
} from "./agent-shell";
import { readFile, writeFile } from "./bridge";
import { HOST_TOOL_NAMES } from "./ide-tool-names";
import { lessonPrompt, recordRun } from "./lessons";
import type { Json } from "./lsp-client";
import type { LspWorkspace } from "./lsp-monaco";
// The same inverse the editor uses; see `uriToPath` on why nothing compares URI strings.
import { uriToPath as uriPath } from "./lsp-session";
import { monaco } from "./monaco-setup";
import { toFileUri, toolError, toolOk } from "./protocol";
import type { ToolResult, WirePath } from "./protocol";

export { HOST_TOOL_NAMES };

/** The host half of the `ide_*` tools. Report the buffer not the disk, say when a result may be
 * incomplete (a server mid-index answers partially), and convert LSP's 0-based positions here. */

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

/** What only the editor pane knows: the file it shows and which buffers are dirty. Published, not
 * passed, to avoid threading two values through every component down to the transcript. */
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
      case "ide_rename_symbol":
        return await ideRenameSymbol(args, deps);
      case "ide_run":
        return await ideRun(args, deps);
      case "ide_terminal_read":
        return ideTerminalRead(args);
      case "ide_terminal_stop":
        return await ideTerminalStop(args);
      case "ide_hover":
        return await ideHover(args, deps);
      case "ide_implementations":
        return await ideImplementations(args, deps);
      case "ide_code_actions":
        return await ideCodeActions(args, deps);
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

/** Accept both an absolute path and one relative to the workspace root: results print relative,
 * so a model copying a path from one result into the next call sends a relative one. */
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

// --- Running commands ------------------------------------------------------------

/** Run a command in the terminal the user can see. Replaces the SDK's `Bash`, which runs where
 * nobody can watch — and the difference between compiling and hung is only visible live. */
async function ideRun(args: Json, deps: IdeHostDeps): Promise<ToolResult> {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) return toolError("`command` is required.");

  if (args.background === true) {
    const started = await startBackground(command, deps.root);
    return toolOk(
      [
        `Started ${started.id} in its own terminal tab: ${command}`,
        "It is still running. Read what it has printed with ide_terminal_read, and stop",
        "it with ide_terminal_stop when you are done with it.",
      ].join("\n"),
    );
  }

  const timeoutMs = Math.min(
    Math.max(numberOr(args.timeoutMs, 120_000), 1_000),
    600_000,
  );

  const result = await runInAgentTerminal(command, deps.root, timeoutMs);
  const took = `${(result.ms / 1000).toFixed(1)}s`;

  if (result.timedOut) {
    // Recorded as a failure: a killed command did not do its job, and if the same one
    // later finishes, that is exactly the transition worth learning from.
    recordRun(command, null, result.output);
    // An error, not a success with a note: a command that was killed did not do its job,
    // and a model told otherwise will build on output that stops mid-way.
    return toolError(
      [
        `Killed after ${took}: the command did not finish within its timeout.`,
        "Output up to that point:",
        result.output || "(nothing)",
      ].join("\n"),
    );
  }

  // Before the early return below, so a failure is remembered as well as a pass.
  const lesson = recordRun(command, result.exitCode, result.output);

  const head = `exit ${result.exitCode ?? "?"} in ${took}`;
  const body = result.output || "(no output)";
  if (result.exitCode !== 0) return toolError(`${head}\n${body}`);
  // Appended to the output rather than sent as its own message: the moment the model learns the
  // command passes is the moment it still knows why. See `lessons.ts`.
  return toolOk(lesson ? `${head}\n${body}\n\n${lessonPrompt(lesson)}` : `${head}\n${body}`);
}

/** What a background process printed since the last read, and whether it is up; with no `id`, the
 * running ones — a model that lost a handle would start a second server on the same port. */
function ideTerminalRead(args: Json): ToolResult {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) {
    const all = listBackground();
    if (all.length === 0) {
      return toolOk("No background processes. Start one with ide_run and `background: true`.");
    }
    return toolOk(
      [
        `${all.length} background process${all.length === 1 ? "" : "es"}:`,
        ...all.map(
          (process) =>
            `${process.id}  ${process.running ? "running" : `exited ${process.exitCode ?? "?"}`}` +
            `  ${flatten(process.command)}`,
        ),
      ].join("\n"),
    );
  }

  const read = readBackground(id);
  if (!read) {
    return toolError(`No background process ${id}. Call ide_terminal_read with no id to list them.`);
  }
  const { output, process } = read;
  const state = process.running
    ? "still running"
    : `exited ${process.exitCode ?? "killed"}`;
  return toolOk(
    [
      `${id} (${state}): ${flatten(process.command)}`,
      output ? `\n${output}` : "\n(nothing new since the last read)",
    ].join(""),
  );
}

/** Kill a background process. */
async function ideTerminalStop(args: Json): Promise<ToolResult> {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return toolError("`id` is required.");
  const stopped = await stopBackground(id);
  if (!stopped) {
    return toolError(`No background process ${id}. Call ide_terminal_read with no id to list them.`);
  }
  return toolOk(`Stopped ${id}.`);
}

// --- Reading what the server knows -------------------------------------------------

/** The resolved type and documentation at a position — what inference produced, what a generic
 * resolves to here. Reading the file harder is not a substitute for asking. */
async function ideHover(args: Json, deps: IdeHostDeps): Promise<ToolResult> {
  const at = position(args, deps.root);
  if ("error" in at) return toolError(at.error);
  const lsp = deps.lsp();
  if (!lsp) return toolError("No workspace is open.");

  const result = await lsp.ask<Json>(at.path, "textDocument/hover", {
    position: { line: at.line - 1, character: at.column - 1 },
  });
  if (result && typeof result === "object" && "error" in result) {
    return toolError(String((result as { error: string }).error));
  }

  const text = hoverText((result as Json | null)?.contents);
  const where = `${display(at.path, deps.root)}:${at.line}:${at.column}`;
  if (!text) {
    return toolOk([`Nothing to say about ${where}.`, lsp.statusNote()].filter(Boolean).join("\n"));
  }
  return toolOk([where, "", text, lsp.statusNote()].filter(Boolean).join("\n"));
}

/** `Hover.contents` has four shapes across LSP versions and rust-analyzer and clangd disagree on
 * which. All four collapse to text. */
function hoverText(contents: unknown): string {
  const fence = "```";
  const one = (entry: unknown): string => {
    if (typeof entry === "string") return entry;
    const marked = entry as Json | undefined;
    if (!marked || typeof marked.value !== "string") return "";
    // A `MarkedString` is a code block waiting to be fenced; `MarkupContent` is not.
    return typeof marked.language === "string"
      ? `${fence}${marked.language}\n${marked.value}\n${fence}`
      : marked.value;
  };
  const entries = Array.isArray(contents) ? contents : [contents];
  return entries.map(one).filter(Boolean).join("\n\n").trim();
}

/** Who implements this. Distinct from references, and in Rust the distinction matters: a trait's
 * references are mostly bounds and imports, its impls are the code that runs. */
async function ideImplementations(args: Json, deps: IdeHostDeps): Promise<ToolResult> {
  const at = position(args, deps.root);
  if ("error" in at) return toolError(at.error);
  const lsp = deps.lsp();
  if (!lsp) return toolError("No workspace is open.");

  const result = await lsp.ask<Json | Json[]>(at.path, "textDocument/implementation", {
    position: { line: at.line - 1, character: at.column - 1 },
  });
  if (result && typeof result === "object" && !Array.isArray(result) && "error" in result) {
    return toolError(String((result as { error: string }).error));
  }

  const found = asLocations(result);
  const note = lsp.statusNote();
  if (found.length === 0) {
    return toolOk(
      [
        `No implementations found at ${display(at.path, deps.root)}:${at.line}:${at.column}.`,
        note ?? "Point at a trait or an abstract method; a concrete function has none.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const rows = await Promise.all(
    found.slice(0, 50).map(async (location) => {
      const line = await lineAt(location.path, location.line);
      return `${display(location.path, deps.root)}:${location.line}:${location.column}${
        line ? `  ${flatten(line)}` : ""
      }`;
    }),
  );
  return toolOk(
    [`${found.length} implementation${found.length === 1 ? "" : "s"}:`, ...rows, note]
      .filter(Boolean)
      .join("\n"),
  );
}

/** The fixes the language server offers, and applying one. One tool with an `apply` argument, not
 * two: naming an action back to a second tool means matching titles, which are not identifiers. */
async function ideCodeActions(args: Json, deps: IdeHostDeps): Promise<ToolResult> {
  const at = position(args, deps.root);
  if ("error" in at) return toolError(at.error);
  const lsp = deps.lsp();
  if (!lsp) return toolError("No workspace is open.");

  const endLine = positive(args.endLine) ?? at.line;
  const endColumn = positive(args.endColumn) ?? at.column;
  const range = {
    start: { line: at.line - 1, character: at.column - 1 },
    end: { line: endLine - 1, character: endColumn - 1 },
  };

  // The server needs the diagnostics in range: a quick fix is computed *from* a diagnostic, so
  // omitting them silently drops the most useful half of the list.
  const diagnostics = (lsp.diagnostics().get(at.path) ?? []).filter((diagnostic) => {
    const start = startOf(diagnostic);
    return start.line >= at.line && start.line <= endLine;
  });

  const result = await lsp.ask<Json[]>(at.path, "textDocument/codeAction", {
    range,
    context: { diagnostics },
  });
  if (result && typeof result === "object" && !Array.isArray(result) && "error" in result) {
    return toolError(String((result as { error: string }).error));
  }
  const actions: Json[] = Array.isArray(result) ? result : [];
  if (actions.length === 0) {
    return toolOk(
      [
        `No code actions at ${display(at.path, deps.root)}:${at.line}:${at.column}.`,
        lsp.statusNote(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const titles = actions.map((action, index) => {
    // rust-analyzer leaves `kind` empty on its assists, and ` []` after every title is
    // noise the model has to read past.
    const kind = action.kind ? ` [${String(action.kind)}]` : "";
    return `${index + 1}. ${String(action.title ?? "untitled")}${kind}`;
  });

  if (args.apply === undefined) {
    return toolOk(
      [
        `${actions.length} action${actions.length === 1 ? "" : "s"} available. Call again ` +
          "with `apply` set to one of these numbers to perform it.",
        ...titles,
        lsp.statusNote(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const which = positive(args.apply);
  if (!which || which > actions.length) {
    return toolError(`\`apply\` must be between 1 and ${actions.length}.`);
  }
  let action = actions[which - 1];

  /** An action can arrive without its edit, resolved on demand — that is how rust-analyzer avoids
   * computing every fix per keystroke. Handed the unresolved form, a model applies nothing. */
  if (!action.edit && action.data !== undefined) {
    const resolved = await lsp.ask<Json>(at.path, "codeAction/resolve", action);
    if (resolved && !("error" in resolved)) action = resolved;
  }

  if (!action.edit) {
    // Some actions are a command for the server to run rather than an edit to apply, and
    // running server commands is a surface this build does not have.
    return toolError(
      `'${String(action.title ?? "that action")}' has no edit to apply -- it asks the ` +
        "server to run a command, which this build cannot do. Make the change with Edit.",
    );
  }

  const applied = await applyWorkspaceEdit(action.edit as Json, deps);
  if ("error" in applied) return toolError(applied.error);
  if (applied.written.length === 0) {
    return toolOk(`'${String(action.title)}' produced no change.`);
  }
  return toolOk(
    [
      `Applied '${String(action.title)}': ${applied.edits} edit${
        applied.edits === 1 ? "" : "s"
      } in ${applied.written.length} file${applied.written.length === 1 ? "" : "s"}.`,
      ...applied.written,
    ].join("\n"),
  );
}

// --- Rename ---------------------------------------------------------------------

interface TextEdit {
  start: { line: number; character: number };
  end: { line: number; character: number };
  newText: string;
}

/** Apply a file's edits to its text, back to front. Every range is against the *original* text, so
 * applying forwards shifts each later edit into the wrong place — silently, and plausibly. */
function applyEdits(text: string, edits: TextEdit[]): string {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") lineStarts.push(index + 1);
  }
  const offsetOf = (position: { line: number; character: number }) => {
    const start = lineStarts[Math.min(position.line, lineStarts.length - 1)] ?? 0;
    return Math.min(start + position.character, text.length);
  };

  const ordered = [...edits].sort((a, b) => offsetOf(b.start) - offsetOf(a.start));
  let out = text;
  for (const edit of ordered) {
    out = out.slice(0, offsetOf(edit.start)) + edit.newText + out.slice(offsetOf(edit.end));
  }
  return out;
}

function toTextEdit(value: unknown): TextEdit | null {
  const edit = value as Json;
  if (!edit || !isRange(edit.range)) return null;
  const range = edit.range as unknown as TextEdit;
  return { start: range.start, end: range.end, newText: String(edit.newText ?? "") };
}

function isRange(value: unknown): boolean {
  const range = value as { start?: { line?: unknown }; end?: { line?: unknown } } | undefined;
  return typeof range?.start?.line === "number" && typeof range?.end?.line === "number";
}

interface AppliedEdit {
  /** One line per file, for the tool's answer. */
  written: string[];
  edits: number;
}

/** Apply a `WorkspaceEdit`. Edits go through the editor's buffer when one is open — the server's
 * positions came from that text, not disk. A file operation refuses the whole edit. */
async function applyWorkspaceEdit(
  edit: Json,
  deps: IdeHostDeps,
): Promise<AppliedEdit | { error: string }> {
  const perFile = new Map<WirePath, TextEdit[]>();
  const fileOperations: string[] = [];

  const collect = (uri: unknown, edits: unknown) => {
    if (typeof uri !== "string" || !Array.isArray(edits)) return;
    const path = uriPath(uri);
    const parsed = edits.map(toTextEdit).filter((one): one is TextEdit => one !== null);
    if (parsed.length === 0) return;
    perFile.set(path, [...(perFile.get(path) ?? []), ...parsed]);
  };

  // `documentChanges` is the richer form and the one rust-analyzer sends. Its entries are
  // either a versioned edit or a file operation, told apart by `kind`.
  if (Array.isArray(edit.documentChanges)) {
    for (const change of edit.documentChanges as Json[]) {
      if (typeof change.kind === "string") {
        fileOperations.push(String(change.kind));
        continue;
      }
      collect((change.textDocument as Json)?.uri, change.edits);
    }
  } else if (edit.changes && typeof edit.changes === "object") {
    for (const [uri, edits] of Object.entries(edit.changes as Record<string, unknown>)) {
      collect(uri, edits);
    }
  }

  if (fileOperations.length > 0) {
    return {
      error:
        `This change also needs to ${[...new Set(fileOperations)].join(" and ")} files, ` +
        "which this build cannot do, so nothing was changed. Do it with Edit instead.",
    };
  }
  if (perFile.size === 0) return { written: [], edits: 0 };

  const written: string[] = [];
  let edits = 0;
  for (const [path, fileEdits] of [...perFile].sort(byPath)) {
    const model = monaco.editor.getModel(monaco.Uri.parse(toFileUri(path)));
    const before = model && !model.isDisposed() ? model.getValue() : (await readFile(path)).text;
    const after = applyEdits(before, fileEdits);
    if (after === before) continue;
    await writeFile(path, after);
    if (model && !model.isDisposed()) model.setValue(after);
    written.push(`${display(path, deps.root)}  (${fileEdits.length})`);
    edits += fileEdits.length;
  }
  return { written, edits };
}

async function ideRenameSymbol(args: Json, deps: IdeHostDeps): Promise<ToolResult> {
  const at = position(args, deps.root);
  if ("error" in at) return toolError(at.error);
  const newName = typeof args.newName === "string" ? args.newName.trim() : "";
  if (!newName) return toolError("`newName` is required.");
  const lsp = deps.lsp();
  if (!lsp) return toolError("No workspace is open.");

  const edit = await lsp.ask<Json>(at.path, "textDocument/rename", {
    position: { line: at.line - 1, character: at.column - 1 },
    newName,
  });
  if (!edit) {
    return toolError(
      `Nothing at ${display(at.path, deps.root)}:${at.line}:${at.column} can be renamed. ` +
        "Point at the symbol's name, not at whitespace or a keyword.",
    );
  }
  if ("error" in edit) return toolError(String((edit as { error: string }).error));

  const applied = await applyWorkspaceEdit(edit, deps);
  if ("error" in applied) return toolError(applied.error);
  const { written, edits } = applied;

  if (written.length === 0) return toolOk("The rename produced no change.");
  return toolOk(
    [
      `Renamed to '${newName}': ${edits} edit${edits === 1 ? "" : "s"} in ${written.length} file${
        written.length === 1 ? "" : "s"
      }.`,
      ...written,
      lsp.statusNote(),
    ]
      .filter(Boolean)
      .join("\n"),
  );
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
