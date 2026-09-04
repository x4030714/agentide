/**
 * The `ide` MCP server: the tools that make this an IDE agent rather than a terminal
 * agent in a window.
 *
 * Every handler here is a proxy. It computes nothing, reads nothing and caches nothing;
 * it emits a `tool_call` and waits for the host's `tool_reply`. The data these tools
 * return -- what you have selected, which files are open, what the language server
 * currently believes -- lives in the webview and the Rust core, and a copy of it in this
 * process would be a stale copy. Keeping the boundary this thin is also what lets the
 * backends land later without touching the model-facing surface: the descriptions and
 * schemas below are the contract, and Phases 3 and 4 only change who answers.
 *
 * Until those phases land the host answers every call with an explicit "not available
 * yet", which the model sees as a tool error and can route around.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { HostLink, TOOL_TIMEOUT_MS } from "./host.ts";
import type { JsonObject, ToolResult } from "./protocol.ts";

/** The MCP server name. Tools reach the model as `mcp__ide__<tool>`. */
export const IDE_SERVER_NAME = "ide";

const INSTRUCTIONS = [
  "Tools for the editor the user is working in.",
  "Prefer them over guessing from the filesystem: ide_selection and ide_open_editors tell",
  "you what the user is actually looking at, and ide_diagnostics reports the language",
  "server's live view of a file without running a build.",
].join(" ");

/**
 * Ask the host to run a tool and turn its answer into an MCP result.
 *
 * A timeout, a dead host and a host-side failure all arrive as `isError` content rather
 * than a thrown exception, so one unavailable IDE feature degrades the turn instead of
 * ending it.
 */
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

/**
 * Build the `ide` server for one session.
 *
 * One server per session rather than one per process: the handlers close over the
 * session id, which is what lets the host attribute a `tool_call` to the transcript that
 * caused it and cancel it when that session is interrupted.
 */
export function createIdeServer(link: HostLink, sessionId: string) {
  const proxy = (name: string, args: JsonObject) => callHost(link, sessionId, name, args);

  const ideOpen = tool(
    "ide_open",
    [
      "Open a file in the user's editor and move their cursor to it. Use this to show the",
      "user the code you are talking about instead of pasting it into your reply, and",
      "before proposing a change to a location they cannot currently see.",
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
      preview: z
        .boolean()
        .optional()
        .describe(
          "Open as a preview tab that the next preview open replaces, rather than pinning a new tab. Use true when you are showing several files in a row.",
        ),
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
      "List the files open in the editor, in tab order, marking which one is focused and",
      "which have unsaved changes. This is the user's working set: it is a much better",
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

  return createSdkMcpServer({
    name: IDE_SERVER_NAME,
    version: "0.1.0",
    instructions: INSTRUCTIONS,
    tools: [ideOpen, ideSelection, ideOpenEditors, ideDiagnostics],
  });
}

/** Tool names this server exposes, for the host's routing table. Keep in sync above. */
export const IDE_TOOL_NAMES = [
  "ide_open",
  "ide_selection",
  "ide_open_editors",
  "ide_diagnostics",
] as const;
