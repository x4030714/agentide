/**
 * What Advanced mode adds to a turn: a roster of subagents, a raised thinking budget, and
 * three hooks. The one place in this project that spends tokens freely on purpose.
 *
 * It lives here rather than crossing the wire because a subagent's prompt is content, and
 * content belongs with the code that versions it. The host sends one field --
 * `promptProfile` -- and this decides what it means.
 */

import type { AgentDefinition, HookCallbackMatcher, HookEvent, Options } from "@anthropic-ai/claude-agent-sdk";

/** Tools that only read. The two agents that must not write are held to this list. */
const READ_ONLY = [
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "mcp__agentide__ide_definition",
  "mcp__agentide__ide_references",
  "mcp__agentide__ide_hover",
  "mcp__agentide__ide_diagnostics",
  "mcp__agentide__ide_document_symbols",
  "mcp__agentide__ide_workspace_symbols",
  "mcp__agentide__ide_implementations",
  "mcp__agentide__ide_open_editors",
];

/**
 * The four agents, matching the chain this project is already worked in.
 *
 * `description` is the whole of how the model decides to delegate -- it is what the parent
 * reads when choosing. A vague one produces a roster that is never used, which is the same
 * as no roster at all.
 *
 * The read-only two are held there by `disallowedTools` rather than by their prompt. A
 * reviewer that can edit will eventually fix what it was asked to judge, and then nobody
 * reviewed anything.
 *
 * Prefixed `ide-` because the bare names collide. `~/.claude/agents/` is where Claude Code
 * looks for a person's own agents, and the person this was built for keeps an architect,
 * implementer, reviewer and validator there. The SDK does not document which definition
 * wins when a programmatic agent shares a name with one on disk, so a delegated "architect"
 * might have been running the global instructions with Bash instead of these with the
 * language-server tools. Distinct names mean no precedence question to get wrong.
 */
/**
 * What the subagents run on.
 *
 * Not `inherit`. The parent is usually Opus at the highest effort, and a subagent is a whole
 * new context -- its own copy of the system prompt, every tool, every MCP server -- billed
 * from cold. Four of those per delegation, on top of the main turn, on a subscription with a
 * session allowance, was two prompts to the limit.
 *
 * Sonnet reads code and runs checks as well as it needs to for the roles here. The one that
 * benefits from the parent's model is the one that *plans*, and that is a judgement the
 * parent can make itself before delegating -- which is what the prompt tells it to do.
 */
const SUBAGENT_MODEL = "sonnet";

export const ROSTER: Record<string, AgentDefinition> = {
  "ide-architect": {
    description:
      "Plans a substantial change before any code is written. Use when the work touches " +
      "several files, has more than one reasonable design, or needs the existing patterns " +
      "understood first. Returns files, approach and risks. Cannot edit anything.",
    prompt:
      "You plan; you do not build. Read only the slice of the codebase the change actually " +
      "touches, and name the files by path.\n\n" +
      "Answer with: the approach, the files it changes, what could go wrong, and the one " +
      "decision you were least sure about. Prefer an existing utility over a new one, and " +
      "say which you found.\n\n" +
      "You cannot edit. If you find yourself wanting to, that is the plan's last step, not " +
      "yours.",
    tools: READ_ONLY,
    model: SUBAGENT_MODEL,
  },

  "ide-implementer": {
    description:
      "Writes the code for a planned change. Use after ide-architect has planned, or when " +
      "the change is clear enough not to need one. Edits files and runs commands.",
    prompt:
      "You build what was planned. Edit only what the change requires.\n\n" +
      "Match the code around you: its comment density, its naming, its idioms. Run the " +
      "checks that cover what you touched before you report, and report what they said " +
      "rather than that you ran them.\n\n" +
      "If the plan is wrong, say so and stop. Building something you believe is wrong and " +
      "mentioning it afterwards costs more than the question.",
    model: SUBAGENT_MODEL,
  },

  "ide-reviewer": {
    description:
      "Reviews an implementation for bugs and regressions by reading the diff and its " +
      "direct call sites. Use after a substantial change. Returns a defect list or a pass. " +
      "Cannot edit anything.",
    prompt:
      "You review; you do not fix. Read the diff and the code it calls into, not the whole " +
      "project.\n\n" +
      "For each defect: the file and line, what breaks, and the concrete input that breaks " +
      "it. A finding you cannot state as a failure is a preference -- say so or drop it.\n\n" +
      "A clean diff gets a pass. Inventing work to look thorough wastes the turn that " +
      "follows.",
    tools: READ_ONLY,
    model: SUBAGENT_MODEL,
  },

  "ide-validator": {
    description:
      "Verifies the result and root-causes anything failing. Use at the end of a task, or " +
      "when something is broken and the cause is unknown. Runs builds, tests and the app.",
    prompt:
      "You find out whether it actually works, by running it.\n\n" +
      "Prefer a fact about the machine to a claim about the code: an exit code, a test " +
      "name, a line of output. When something fails, trace it to its cause before " +
      "proposing a fix, and fix only what is small and certain.\n\n" +
      "Report what passed, what failed, and what you did not check.",
    model: SUBAGENT_MODEL,
  },
};

/**
 * Room to think, and a summary of it rather than the whole stream.
 *
 * `summarized` because the transcript already draws a live token count while the model
 * reasons: the number is what says it is working, and the full text would bury the answer
 * it is on the way to.
 */
export const THINKING = {
  type: "enabled" as const,
  budgetTokens: 32_000,
  display: "summarized" as const,
};

/**
 * Shell commands no turn should run, whatever it was asked.
 *
 * Narrow on purpose. A pattern that is too broad blocks real work and reads as the agent
 * being broken, which costs more than the thing it prevented. Each of these destroys
 * something that no checkpoint restores -- the checkpoint repo lives in the workspace.
 */
const FORBIDDEN: { pattern: RegExp; because: string }[] = [
  // Two lookaheads rather than one alternation: recursive and force are separate facts and
  // arrive in either order, in one flag or in several. `rm -f -r` slipped through the
  // single-pattern version.
  {
    pattern: /\brm\s+(?=(?:--?\w+\s+)*--?\w*r)(?=(?:--?\w+\s+)*--?\w*f)/i,
    because: "a recursive force delete",
  },
  // PowerShell spells the same thing entirely differently, and it is the shell this runs in.
  {
    pattern: /\bRemove-Item\b(?=[^|;&]*-Recurse)(?=[^|;&]*-Force)/i,
    because: "a recursive force delete",
  },
  { pattern: /\b(format|mkfs)(\.\w+)?\s+[a-zA-Z]:/i, because: "formatting a drive" },
  { pattern: /\bgit\s+push\b[^|;&]*--force(-with-lease)?\b[^|;&]*\b(main|master)\b/, because: "a force push to the trunk" },
  { pattern: /\bgit\s+reset\s+--hard\b[^|;&]*\borigin\//, because: "discarding local work to match the remote" },
  { pattern: /\b(shutdown|reboot)\b|\bStop-Computer\b/i, because: "shutting the machine down" },
];

/** The reason a command is refused, or null when it is fine. */
export function forbidden(command: string): string | null {
  for (const { pattern, because } of FORBIDDEN) {
    if (pattern.test(command)) return because;
  }
  return null;
}

/** The shell command out of an `ide_run` call, whatever shape the input arrived in. */
function commandOf(input: unknown): string {
  const command = (input as { command?: unknown } | null)?.command;
  return typeof command === "string" ? command : "";
}

/** Tools that change the tree. Editing through any of them starts the turn's debt. */
const EDITS = /^(Edit|Write|MultiEdit|NotebookEdit|mcp__agentide__ide_rename_symbol)$/;

/**
 * A command that actually checks something.
 *
 * Deliberately a list of the words a check is spelled with rather than "any command":
 * `ls`, `cat` and `git status` are how you look around, not how you find out whether the
 * change works, and letting them count would make the whole hook a formality.
 */
const VERIFIES =
  /\b(test|tests|check|typecheck|tsc|build|lint|clippy|vitest|jest|pytest|cargo|gradle|make|mypy|ruff|eslint)\b/i;

/** What one turn has done so far, for the `Stop` hook to judge. */
interface TurnRecord {
  edited: string[];
  verified: boolean;
  /** Set once the turn has already been sent back for a check, so it is asked once. */
  nagged: boolean;
}

/** The shell command out of a tool input, whatever shape it arrived in. */
function commandIn(input: unknown): string {
  const command = (input as { command?: unknown } | null)?.command;
  return typeof command === "string" ? command : "";
}

/** The file a mutating tool was pointed at, for naming it back. */
function fileIn(input: unknown): string | null {
  const record = input as Record<string, unknown> | null;
  for (const key of ["file_path", "notebook_path", "path"]) {
    const value = record?.[key];
    if (typeof value === "string" && value !== "") return value.split(/[\\/]/).pop() ?? value;
  }
  return null;
}

/** The roster name out of a subagent hook's input, or a stand-in. */
function agentType(input: unknown): string {
  const type = (input as { agent_type?: unknown } | null)?.agent_type;
  return typeof type === "string" && type !== "" ? type : "a subagent";
}

/**
 * The hooks. Six of the SDK's thirty-three.
 *
 * A hook is the only thing here that can *stop* the model rather than ask it to stop, which
 * is why the destructive-command guard is one and not a paragraph of prompt.
 *
 * `notify` reports delegation starting and finishing. Without it delegation is invisible:
 * four agents work for a minute and the pane says nothing, which reads as a hang. The start
 * matters more than the stop -- the quiet is at the beginning.
 */
export function hooks(notify: (text: string) => void): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  /**
   * One turn's record. Closed over rather than stored per session id: these hooks belong to
   * one query, and a query is one conversation.
   */
  const turn: TurnRecord = { edited: [], verified: false, nagged: false };

  return {
    // A new prompt is a new turn, and last turn's `cargo test` does not vouch for this one.
    UserPromptSubmit: [
      {
        hooks: [
          async () => {
            turn.edited = [];
            turn.verified = false;
            turn.nagged = false;
            return { continue: true };
          },
        ],
      },
    ],

    // What the turn did, as it does it.
    PostToolUse: [
      {
        hooks: [
          async (input) => {
            const { tool_name: name, tool_input: args } = input as {
              tool_name?: string;
              tool_input?: unknown;
            };
            if (name && EDITS.test(name)) {
              const file = fileIn(args);
              if (file && !turn.edited.includes(file)) turn.edited.push(file);
            }
            // Diagnostics are a check: the language server is being asked whether the edit
            // holds, which is the same question a test asks and a cheaper way to ask it.
            if (name === "mcp__agentide__ide_diagnostics") turn.verified = true;
            if (name === "mcp__agentide__ide_run" && VERIFIES.test(commandIn(args))) {
              turn.verified = true;
            }
            return { continue: true };
          },
        ],
      },
    ],

    /**
     * A turn that changed code and never checked it does not get to end.
     *
     * This is the one rule in Advanced mode that costs the model something it would rather
     * not spend, and it is here because the alternative is the failure this project keeps
     * paying for: an edit that is reported as working because it compiled in someone's head.
     * A `Stop` hook is the only place it can be enforced -- by then the turn's whole record
     * exists, and blocking hands the reason back and lets the work continue.
     *
     * Asked once. A second refusal would be a loop, and a model that has been told and
     * decided otherwise has given its answer.
     */
    Stop: [
      {
        hooks: [
          async (input) => {
            const active = (input as { stop_hook_active?: boolean }).stop_hook_active;
            if (active || turn.nagged || turn.verified || turn.edited.length === 0) {
              return { continue: true };
            }
            turn.nagged = true;
            const files = turn.edited.slice(0, 4).join(", ");
            const more = turn.edited.length > 4 ? ` and ${turn.edited.length - 4} more` : "";
            return {
              continue: true,
              decision: "block",
              reason:
                `This turn changed ${files}${more} and never checked the result. Run the ` +
                `check that covers what you touched -- the tests, the type check, the build, ` +
                `or ide_diagnostics on the files -- and say what it reported. If the change ` +
                `genuinely cannot be checked here, say which check you would run and why it ` +
                `is not possible, and stop.`,
            };
          },
        ],
      },
    ],
    PreToolUse: [
      {
        // Only our shell. `Bash` is disallowed project-wide, so this is the one way out.
        matcher: "mcp__agentide__ide_run",
        hooks: [
          async (input) => {
            const command = commandOf((input as { tool_input?: unknown }).tool_input);
            const because = forbidden(command);
            if (!because) return { continue: true };
            return {
              continue: true,
              decision: "block",
              reason: `Refused: this is ${because}, which agentide blocks in Advanced mode. Nothing in the checkpoint survives it.`,
            };
          },
        ],
      },
    ],
    SubagentStart: [
      {
        hooks: [
          async (input) => {
            notify(`${agentType(input)} started`);
            return { continue: true };
          },
        ],
      },
    ],
    SubagentStop: [
      {
        hooks: [
          async (input) => {
            notify(`${agentType(input)} finished`);
            return { continue: true };
          },
        ],
      },
    ],
  };
}

/** Everything Advanced adds to the SDK options. Spread over the base in `session.ts`. */
export function advancedOptions(notify: (text: string) => void): Partial<Options> {
  return {
    agents: ROSTER,
    thinking: THINKING,
    hooks: hooks(notify),
  };
}
