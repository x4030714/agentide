/** The `agentide` MCP server. Every handler is a pure proxy -- emit `tool_call`, await
 * `tool_reply` -- because the truth lives in the webview and Rust core, not here. */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { HostLink, TOOL_TIMEOUT_MS } from "./host.ts";
import type { JsonObject, ToolResult } from "./protocol.ts";

/** Tools reach the model as `mcp__agentide__<tool>`. Not "ide" -- Claude Code ships its own
 * server under that name and silently shadowed ours down to zero tools. */
export const IDE_SERVER_NAME = "agentide";

const INSTRUCTIONS = [
  "Tools for the editor the user is working in, backed by a live language server.",
  "Prefer them over guessing from the filesystem: ide_selection and ide_open_editors tell",
  "you what the user is actually looking at, and ide_diagnostics reports the language",
  "server's live view of a file without running a build.",
  "For anything about a symbol -- where it is defined, who uses it, what a file contains --",
  "prefer ide_definition, ide_references, ide_document_symbols and ide_workspace_symbols",
  "over Grep. They resolve through imports and generics, they do not match comments or",
  "strings, and they cost a fraction of the tokens a text search over a common name does.",
  "ide_hover gives a symbol's resolved type and docs, which the source text does not show.",
  "When a diagnostic needs fixing, try ide_code_actions on its line before writing the fix",
  "yourself: the server has usually already computed the correct one.",
].join(" ");

/** Ask the host to run a tool. Timeouts, a dead host and host-side failures all come back as
 * `isError` content, never a throw, so one dead feature degrades the turn instead of ending it. */
async function callHost(
  link: HostLink,
  sessionId: string,
  name: string,
  args: JsonObject,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const result = await link.request<ToolResult>({
      prefix: "tool",
      label: name,
      sessionId,
      timeoutMs: TOOL_TIMEOUT_MS,
      build: (id) => ({ t: "tool_call", id, sessionId, name, args }),
    });
    return result.ok
      ? { content: [{ type: "text", text: result.text }] }
      : { content: [{ type: "text", text: result.error }], isError: true };
  } catch (error) {
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}

/** One server per session, not per process: the handlers close over the session id, which is
 * how the host attributes a `tool_call` to a transcript and cancels it on interrupt. */
export function createIdeServer(
  link: HostLink,
  sessionId: string,
  answers?: readonly string[],
  alwaysLoad = true,
) {
  const proxy = (name: string, args: JsonObject) => callHost(link, sessionId, name, args);

  const ideOpen = tool(
    "ide_open",
    [
      "Open a file in the user's editor and move their cursor to it. Use this to show the",
      "user the code you are talking about instead of pasting it into your reply, and",
      "before proposing a change to a location they cannot currently see.",
      "The editor shows one file at a time, so this replaces what they were looking at.",
      "This does not read the file -- use Read for that.",
    ].join(" "),
    {
      path: z
        .string()
        .describe("Absolute path to the file. Must be inside the open workspace."),
      line: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("1-based line to reveal and place the cursor on. Omit to leave the cursor alone."),
      column: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("1-based column within `line`. Defaults to the start of the line."),
      endLine: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("1-based last line of a range to select. Omit to select nothing."),
      endColumn: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("1-based column within `endLine`. Defaults to the end of that line."),
    },
    async (args) => proxy("ide_open", args as JsonObject),
    {
      annotations: { title: "Open in editor", readOnlyHint: false, idempotentHint: true },
      searchHint: "Reveal a file and line in the user's editor",
    },
  );

  const ideSelection = tool(
    "ide_selection",
    [
      "Read what the user currently has selected in the editor, or where their cursor is",
      "if there is no selection. Call this first whenever the user says 'this', 'here',",
      "'the selected code' or otherwise points at something without naming a file -- it is",
      "the only way to resolve that reference correctly.",
      "Returns the file path, the line and column range, and the selected text.",
    ].join(" "),
    {},
    async () => proxy("ide_selection", {}),
    {
      annotations: { title: "Read editor selection", readOnlyHint: true, openWorldHint: false },
      searchHint: "What the user has selected right now",
    },
  );

  const ideOpenEditors = tool(
    "ide_open_editors",
    [
      "List the files loaded in the editor, oldest first, marking which one is on screen",
      "and which have unsaved changes. This is the user's working set: it is a much better",
      "starting point for 'where is this handled?' than searching the whole project, and",
      "it tells you when the version on disk is not the version the user is looking at.",
    ].join(" "),
    {},
    async () => proxy("ide_open_editors", {}),
    {
      annotations: { title: "List open editors", readOnlyHint: true, openWorldHint: false },
      searchHint: "Files the user has open, and which is focused",
    },
  );

  const ideDiagnostics = tool(
    "ide_diagnostics",
    [
      "Read the language server's current errors and warnings -- type errors, unresolved",
      "imports, borrow-check failures -- for one file or for the whole workspace.",
      "This is the fast way to check whether an edit is correct: it is live analysis, so it",
      "answers in a second or two and needs no build. Prefer it over running a compiler",
      "with Bash. Call it after editing to confirm you did not break anything, and before",
      "editing to see what is already broken.",
      "Results reflect the buffer in the editor, including unsaved changes.",
    ].join(" "),
    {
      path: z
        .string()
        .optional()
        .describe(
          "Absolute path to one file. Omit for every diagnostic in the workspace, which can be long.",
        ),
      severity: z
        .enum(["error", "warning", "info", "hint"])
        .optional()
        .describe("Lowest severity to include, most severe first. Defaults to 'warning'."),
    },
    async (args) => proxy("ide_diagnostics", args as JsonObject),
    {
      annotations: { title: "Read diagnostics", readOnlyHint: true, openWorldHint: false },
      searchHint: "Live type errors and warnings without a build",
    },
  );

  const ideDefinition = tool(
    "ide_definition",
    [
      "Jump to where a symbol is defined, using the language server's resolved answer --",
      "the same one 'go to definition' gives the user. Give the position of a use of the",
      "symbol and this returns where it is declared.",
      "This is exact where a text search is not: it follows imports, re-exports, trait",
      "implementations and generics, and it will not match a comment, a string or an",
      "unrelated identifier that happens to share the name. Prefer it over Grep whenever",
      "you have a position to ask about.",
    ].join(" "),
    {
      path: z.string().describe("Absolute path to the file containing the symbol."),
      line: z.number().int().min(1).describe("1-based line of the symbol."),
      column: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("1-based column within the symbol name. Defaults to the start of the line."),
    },
    async (args) => proxy("ide_definition", args as JsonObject),
    {
      annotations: { title: "Go to definition", readOnlyHint: true, openWorldHint: false },
      searchHint: "Where a symbol is defined, resolved not guessed",
    },
  );

  const ideReferences = tool(
    "ide_references",
    [
      "Find every use of a symbol across the project, resolved by the language server.",
      "This is the tool to use before changing or removing anything shared: it answers",
      "'what will this break?' precisely, where a text search over a common name returns",
      "mostly noise and still misses uses through aliases and re-exports.",
      "Results are grouped by file, most relevant first.",
    ].join(" "),
    {
      path: z.string().describe("Absolute path to a file containing the symbol."),
      line: z.number().int().min(1).describe("1-based line of the symbol."),
      column: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("1-based column within the symbol name. Defaults to the start of the line."),
      includeDeclaration: z
        .boolean()
        .optional()
        .describe("Include the declaration itself in the results. Defaults to true."),
    },
    async (args) => proxy("ide_references", args as JsonObject),
    {
      annotations: { title: "Find references", readOnlyHint: true, openWorldHint: false },
      searchHint: "Every real use of a symbol, before you change it",
    },
  );

  const ideDocumentSymbols = tool(
    "ide_document_symbols",
    [
      "List the structure of one file -- its types, functions, methods and constants, with",
      "the line each starts on, nested as they are nested in the source.",
      "Read this before reading a large file: it is a few hundred tokens for an outline",
      "that tells you which ranges are worth reading, instead of spending thousands on the",
      "whole file to find one function.",
    ].join(" "),
    {
      path: z.string().describe("Absolute path to the file."),
    },
    async (args) => proxy("ide_document_symbols", args as JsonObject),
    {
      annotations: { title: "Outline a file", readOnlyHint: true, openWorldHint: false },
      searchHint: "A file's structure without reading the file",
    },
  );

  const ideWorkspaceSymbols = tool(
    "ide_workspace_symbols",
    [
      "Search the whole project for a symbol by name -- types, functions, traits, methods,",
      "constants -- and get where each is defined.",
      "Use this to locate something when you know what it is called but not where it lives.",
      "It matches names, not text, so it will not return the hundred call sites and comments",
      "that mention it; for those, use ide_references.",
      "Matching is fuzzy, so a partial or camel-case fragment works.",
    ].join(" "),
    {
      query: z
        .string()
        .describe("Symbol name or fragment. An empty query is not useful; name something."),
    },
    async (args) => proxy("ide_workspace_symbols", args as JsonObject),
    {
      annotations: { title: "Search symbols", readOnlyHint: true, openWorldHint: false },
      searchHint: "Find a type or function by name across the project",
    },
  );

  const ideRenameSymbol = tool(
    "ide_rename_symbol",
    [
      "Rename a symbol everywhere it is used, using the language server's own rename --",
      "the same one the user's 'rename symbol' command performs.",
      "This is the correct way to rename anything shared. It updates every real use,",
      "including uses through imports, re-exports and trait implementations, and it does",
      "not touch a comment, a string, or an unrelated identifier that happens to match.",
      "A find-and-replace over the same name does the opposite on both counts, which is",
      "why it is the wrong tool for this even when it looks like it worked.",
      "The edit is applied to the files directly and is covered by the turn's checkpoint,",
      "so the user can undo all of it at once.",
      "Renames that would also move a file are refused rather than half-applied; do those",
      "with Edit.",
    ].join(" "),
    {
      path: z.string().describe("Absolute path to a file containing the symbol."),
      line: z.number().int().min(1).describe("1-based line of the symbol."),
      column: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("1-based column within the symbol name. Defaults to the start of the line."),
      newName: z.string().describe("The new name, without any surrounding punctuation."),
    },
    async (args) => proxy("ide_rename_symbol", args as JsonObject),
    {
      annotations: { title: "Rename symbol", readOnlyHint: false, idempotentHint: false },
      searchHint: "Rename a symbol across the project, correctly",
    },
  );

  const ideRun = tool(
    "ide_run",
    [
      "Run a shell command in the user's IDE, in a terminal they can watch while it runs.",
      "This is the shell for this environment: use it for builds, tests, git, package",
      "managers and anything else you would run at a prompt. The built-in Bash tool is not",
      "available here, because it runs where the user cannot see it.",
      "Each call runs in a fresh shell rooted at the workspace, so state does not carry",
      "between calls: chain with && or ; inside one command rather than expecting a",
      "previous cd or export to still apply.",
      "Returns the exit code and the output with terminal control codes removed. A",
      "non-zero exit comes back as an error with the output attached.",
      "A command that is not supposed to finish -- a dev server, a watcher, a REPL -- must",
      "be started with background: true instead. It then returns a handle immediately,",
      "keeps running in its own terminal tab, and is read with ide_terminal_read and shut",
      "down with ide_terminal_stop. Started without it, such a command runs until the",
      "timeout and is killed, which wastes the wait and reports a failure that is really",
      "just the command doing its job.",
    ].join(" "),
    {
      command: z
        .string()
        .describe("The command line, exactly as it would be typed at the user's prompt."),
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(600_000)
        .optional()
        .describe(
          "How long to allow before killing it. Defaults to 120000 (two minutes). Ignored " +
            "when background is true, which has no timeout.",
        ),
      background: z
        .boolean()
        .optional()
        .describe(
          "Return as soon as it starts instead of waiting. Use for anything that is meant " +
            "to keep running.",
        ),
    },
    async (args) => proxy("ide_run", args as JsonObject),
    {
      annotations: { title: "Run a command", readOnlyHint: false, openWorldHint: true },
      searchHint: "Run a shell command where the user can watch it",
    },
  );

  const ideHover = tool(
    "ide_hover",
    [
      "Get the resolved type and documentation of whatever is at a position -- the same",
      "thing the user sees when they hover over it.",
      "This answers questions the text cannot: what a variable's type actually is after",
      "inference, what a generic or an associated type resolves to at this call site, what",
      "an inferred return type is, and what the doc comment on the thing being called says.",
      "Use it before assuming a type from a name or from how a value is used. Reading the",
      "definition tells you what was written; this tells you what it means here.",
    ].join(" "),
    {
      path: z.string().describe("Absolute path to the file."),
      line: z.number().int().min(1).describe("1-based line of the position."),
      column: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("1-based column, inside the name you are asking about. Defaults to 1."),
    },
    async (args) => proxy("ide_hover", args as JsonObject),
    {
      annotations: { title: "Type and docs at a position", readOnlyHint: true, openWorldHint: false },
      searchHint: "What type is this, and what does it do",
    },
  );

  const ideImplementations = tool(
    "ide_implementations",
    [
      "Find the implementations of a trait, interface, or abstract method.",
      "Ask this, not ide_references, when you want the code that actually runs. References",
      "to a trait are mostly bounds, imports and mentions in signatures; its implementations",
      "are the bodies, and they are usually what you were looking for.",
      "Point at the trait's name, or at a method inside the trait, to get that method's",
      "implementations specifically.",
    ].join(" "),
    {
      path: z.string().describe("Absolute path to a file containing the trait or method."),
      line: z.number().int().min(1).describe("1-based line of the name."),
      column: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("1-based column within the name. Defaults to 1."),
    },
    async (args) => proxy("ide_implementations", args as JsonObject),
    {
      annotations: { title: "Find implementations", readOnlyHint: true, openWorldHint: false },
      searchHint: "Who implements this trait or interface",
    },
  );

  const ideCodeActions = tool(
    "ide_code_actions",
    [
      "List the fixes and refactors the language server offers at a position, and apply one.",
      "Call it without 'apply' to see the numbered list, then call it again with 'apply' set",
      "to a number to perform that action.",
      "This is the right response to a diagnostic from ide_diagnostics: point at the",
      "diagnostic's line and the server offers the fix it already computed for it -- add the",
      "missing import with the correct path, fill in the match arms that are missing, add the",
      "fields a struct literal lacks, remove an unused import. Each is derived from the real",
      "semantic model, so it is correct in a way that writing the same text by hand is not.",
      "The list changes with the position, so pass the line the problem is on.",
      "Applying edits the files directly and is covered by the turn's checkpoint, so the user",
      "can undo it. Actions that would create, move or delete a file are refused rather than",
      "half-applied.",
    ].join(" "),
    {
      path: z.string().describe("Absolute path to the file."),
      line: z.number().int().min(1).describe("1-based line to ask about."),
      column: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("1-based column. Defaults to 1, which is right for a whole-line problem."),
      endLine: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("1-based last line, to ask about a range. Defaults to line."),
      endColumn: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("1-based end column of the range. Defaults to column."),
      apply: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "The number of the action to perform, from a previous call's list. Omit to list.",
        ),
    },
    async (args) => proxy("ide_code_actions", args as JsonObject),
    {
      annotations: { title: "Code actions", readOnlyHint: false, idempotentHint: false },
      searchHint: "Let the language server fix it",
    },
  );

  const ideTerminalRead = tool(
    "ide_terminal_read",
    [
      "Read what a background process has printed since you last read it, and whether it",
      "is still running.",
      "Call it with no id to list the background processes you have started -- do that if",
      "you have lost track of a handle, rather than starting a second copy of something",
      "that is already running.",
      "Each call returns only what is new, so polling a dev server's log is cheap and",
      "re-reading it does not hand you the last hour again.",
    ].join(" "),
    {
      id: z
        .string()
        .optional()
        .describe("The handle ide_run returned. Omit to list every background process."),
    },
    async (args) => proxy("ide_terminal_read", args as JsonObject),
    {
      annotations: { title: "Read a background process", readOnlyHint: true, openWorldHint: false },
      searchHint: "What has the dev server printed since last time",
    },
  );

  const ideTerminalStop = tool(
    "ide_terminal_stop",
    [
      "Stop a background process you started with ide_run.",
      "Do this when you are finished with one. A dev server left running holds its port,",
      "and the next attempt to start one fails for a reason that looks unrelated.",
    ].join(" "),
    {
      id: z.string().describe("The handle ide_run returned."),
    },
    async (args) => proxy("ide_terminal_stop", args as JsonObject),
    {
      annotations: { title: "Stop a background process", readOnlyHint: false, idempotentHint: true },
      searchHint: "Shut down something you started",
    },
  );

  return createSdkMcpServer({
    name: IDE_SERVER_NAME,
    version: "0.1.0",
    instructions: INSTRUCTIONS,
    /** Loaded on Anthropic, deferred locally. Measured: 3,163 tokens against ~2s a turn --
     * cached those tokens are free, uncached they are prefill and 5% of a 64k window. */
    alwaysLoad,
    tools: keep(answers, [
      ideOpen,
      ideSelection,
      ideOpenEditors,
      ideDiagnostics,
      ideDefinition,
      ideReferences,
      ideDocumentSymbols,
      ideWorkspaceSymbols,
      ideRenameSymbol,
      ideRun,
      ideHover,
      ideImplementations,
      ideCodeActions,
      ideTerminalRead,
      ideTerminalStop,
    ]),
  });
}

/** Only the tools this host can answer; `undefined` means all of them (the desktop app). A
 * declared tool that always fails is broken silently and costs its description every prompt. */
function keep<T extends { name: string }>(
  answers: readonly string[] | undefined,
  tools: T[],
): T[] {
  if (!answers) return tools;
  const allowed = new Set(answers);
  return tools.filter((entry) => allowed.has(entry.name));
}

/** Prefixed names (`mcp__agentide__ide_open`), used to auto-approve. The writers go through
 * the language server inside the turn's checkpoint, and always-Allow dialogs teach a reflex. */
export function ideToolNames(answers?: readonly string[]): string[] {
  const names = answers ? IDE_TOOL_NAMES.filter((name) => answers.includes(name)) : IDE_TOOL_NAMES;
  return names.map((name) => `mcp__${IDE_SERVER_NAME}__${name}`);
}

/** Tool names this server exposes, for the host's routing table. Keep in sync above. */
export const IDE_TOOL_NAMES = [
  "ide_open",
  "ide_selection",
  "ide_open_editors",
  "ide_diagnostics",
  "ide_definition",
  "ide_references",
  "ide_document_symbols",
  "ide_workspace_symbols",
  "ide_rename_symbol",
  "ide_run",
  "ide_hover",
  "ide_implementations",
  "ide_code_actions",
  "ide_terminal_read",
  "ide_terminal_stop",
] as const;
