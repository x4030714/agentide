/**
 * What `/` offers in the interactive CLI.
 *
 * Two sources, one list. The CLI has a handful of its own -- leaving, changing the model --
 * and the Claude Code installation publishes the rest through `supportedCommands()`, which
 * needs a live query and so only arrives once a turn has run. That is worth saying out loud
 * in the listing rather than presenting a short list as though it were the whole one.
 *
 * `/` on its own lists everything; `/mo` lists what matches. The same text both opens the
 * menu and searches it, which is the point: there is no separate mode to enter or leave,
 * and a name typed in full is simply a match of one.
 *
 * Pure, and here rather than in `cli.ts`, because the matching has rules worth a test:
 * an alias has to find its command, a prefix has to beat a substring, and an exact name
 * has to win outright or `/exit` would open a menu instead of leaving.
 */

import type { SlashCommand } from "./protocol.ts";

/** A command the CLI answers itself, rather than sending to the agent. */
export interface LocalCommand extends SlashCommand {
  /** Marks it in the listing, so it is clear which side answers. */
  local: true;
}

export const LOCAL_COMMANDS: LocalCommand[] = [
  { name: "help", description: "show these commands", argumentHint: "", local: true },
  { name: "exit", description: "leave", argumentHint: "", aliases: ["quit"], local: true },
  { name: "model", description: "run the next turns on another model", argumentHint: "<id>", local: true },
  { name: "provider", description: "run them on a configured backend", argumentHint: "<key>", local: true },
  { name: "resume", description: "list past conversations here, or continue one", argumentHint: "[n]", local: true },
  { name: "cwd", description: "show or change the working directory", argumentHint: "[path]", local: true },
  { name: "verbose", description: "show tool calls as they happen", argumentHint: "", local: true },
];

/** Every command that can be typed right now, the CLI's own first. */
export function allCommands(fromAgent: readonly SlashCommand[]): SlashCommand[] {
  // The CLI's own first, and its names win a collision: `/model` here changes what the
  // next turn runs on, which is the answer someone typing it in this program wants.
  const mine = new Set(LOCAL_COMMANDS.map((command) => command.name));
  return [...LOCAL_COMMANDS, ...fromAgent.filter((command) => !mine.has(command.name))];
}

/** Whether a typed name is this command, by its own name or any alias. */
function named(command: SlashCommand, name: string): boolean {
  return command.name === name || (command.aliases ?? []).includes(name);
}

/**
 * What `/text` should do.
 *
 * `exact` means run it. Otherwise `matches` is what to show -- everything for a bare `/`,
 * and the search results for anything else. A search that finds nothing is not an error:
 * the installation may know a command this list has not heard of, since the agent's own
 * set only arrives after the first turn.
 */
export interface Lookup {
  exact: SlashCommand | null;
  matches: SlashCommand[];
}

export function lookup(input: string, commands: readonly SlashCommand[]): Lookup {
  const typed = input.replace(/^\//, "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!typed) return { exact: null, matches: [...commands] };

  const exact = commands.find((command) => named(command, typed)) ?? null;
  if (exact) return { exact, matches: [exact] };

  // Prefix before substring: typing `/co` wants `/commit` above `/precommit`, and a list
  // that buried the obvious answer would make the search worse than no search.
  const prefix = commands.filter((command) => command.name.startsWith(typed));
  const inside = commands.filter(
    (command) => !command.name.startsWith(typed) && command.name.includes(typed),
  );
  return { exact: null, matches: [...prefix, ...inside] };
}

/** Widest a call may be before it stops setting the column for everything else. */
export const CALL_COLUMN = 26;

/** One line per command, aligned, for the listing. */
export function format(commands: readonly SlashCommand[], terminal = 100): string[] {
  // Capped, not measured. A skill can carry an argument hint of eighty characters, and
  // letting the widest entry set the column indents every other description off the far
  // side of the terminal -- one command's verbosity should not cost the other ninety their
  // legibility.
  const column = Math.min(
    CALL_COLUMN,
    commands.reduce((widest, command) => Math.max(widest, call(command).length), 0),
  );
  const room = Math.max(24, terminal - column - 4);
  return commands.map(
    (command) => `  ${call(command, column).padEnd(column)}  ${oneLine(command.description, room)}`.trimEnd(),
  );
}

/**
 * `/name <args>`, shortened from the right if it has to be.
 *
 * The hint is what gets cut, never the name: a name is how the command is typed and a
 * hint is a reminder of what follows it, so a hint too long to show is a hint worth
 * losing. Reading `/help` on a wrapped second row is not.
 */
export function call(command: SlashCommand, limit = Infinity): string {
  const full = `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`;
  return full.length <= limit ? full : `${full.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * A description as one line that fits.
 *
 * Skill descriptions are written for a model, not a listing: hundreds of words, embedded
 * newlines, and a paragraph of trigger conditions. Printed whole they wrap across the
 * terminal and the list stops being a list. The first sentence is what a person scanning
 * for a command name actually reads.
 */
export function oneLine(description: string, room: number): string {
  const flat = description.replace(/\s+/g, " ").trim();
  if (flat.length <= room) return flat;
  // Cut on a word so the truncation reads as a shortened sentence rather than damage.
  const cut = flat.slice(0, room - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > room / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * What readline completes on Tab.
 *
 * Only for input that has started with a slash: everything else typed here is a prompt,
 * and completing English words into command names would be worse than not completing.
 */
export function complete(
  line: string,
  commands: readonly SlashCommand[],
): [string[], string] {
  if (!line.startsWith("/")) return [[], line];
  const { matches } = lookup(line, commands);
  return [matches.map((command) => `/${command.name}`), line];
}
