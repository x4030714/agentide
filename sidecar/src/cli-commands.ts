/** What `/` offers: the CLI's own commands plus the installation's, which only arrive once a
 * turn has run. An exact name wins outright, or `/exit` would open a menu instead of leaving. */

import type { SlashCommand } from "./protocol.ts";

/** A command the CLI answers itself, rather than sending to the agent. */
export interface LocalCommand extends SlashCommand {
  /** Marks it in the listing, so it is clear which side answers. */
  local: true;
}

export const LOCAL_COMMANDS: LocalCommand[] = [
  { name: "help", description: "show these commands", argumentHint: "", local: true },
  { name: "login", description: "sign in to Claude, or show who is signed in", argumentHint: "", local: true },
  { name: "logout", description: "sign out — machine-wide, so it asks first", argumentHint: "[confirm]", local: true },
  { name: "account", description: "list Claude accounts, or run the next turns on one", argumentHint: "[n|key]", local: true },
  { name: "doctor", description: "what this machine is missing, and how to fix it", argumentHint: "", local: true },
  { name: "exit", description: "leave", argumentHint: "", aliases: ["quit"], local: true },
  { name: "model", description: "list models, or run the next turns on one", argumentHint: "[n|id]", local: true },
  { name: "provider", description: "list backends, or run the next turns on one", argumentHint: "[n|key]", local: true },
  { name: "resume", description: "list past conversations here, or continue one", argumentHint: "[n]", local: true },
  { name: "cwd", description: "show or change the working directory", argumentHint: "[path]", local: true },
  { name: "verbose", description: "show tool calls as they happen", argumentHint: "", local: true },
];

/** Every command that can be typed right now, the CLI's own first. */
export function allCommands(fromAgent: readonly SlashCommand[]): SlashCommand[] {
// The CLI's own win a collision: `/model` here changes what the next turn runs on.
  const mine = new Set(LOCAL_COMMANDS.map((command) => command.name));
  return [...LOCAL_COMMANDS, ...fromAgent.filter((command) => !mine.has(command.name))];
}

/** Whether a typed name is this command, by its own name or any alias. */
function named(command: SlashCommand, name: string): boolean {
  return command.name === name || (command.aliases ?? []).includes(name);
}

/** `exact` means run it; `matches` is what to show. Finding nothing is not an error -- the
 * installation may know a command this list has not heard of yet. */
export interface Lookup {
  exact: SlashCommand | null;
  matches: SlashCommand[];
}

export function lookup(input: string, commands: readonly SlashCommand[]): Lookup {
  const typed = input.replace(/^\//, "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!typed) return { exact: null, matches: [...commands] };

  const exact = commands.find((command) => named(command, typed)) ?? null;
  if (exact) return { exact, matches: [exact] };

// Prefix before substring: typing `/co` wants `/commit` above `/precommit`.
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
// Capped, not measured. One skill's eighty-character argument hint would otherwise indent
// every other description off the side of the terminal.
  const column = Math.min(
    CALL_COLUMN,
    commands.reduce((widest, command) => Math.max(widest, call(command).length), 0),
  );
  const room = Math.max(24, terminal - column - 4);
  return commands.map(
    (command) => `  ${call(command, column).padEnd(column)}  ${oneLine(command.description, room)}`.trimEnd(),
  );
}

/** `/name <args>`, cut from the right. The hint is what gets cut, never the name: the name is
 * how the command is typed, the hint is only a reminder of what follows. */
export function call(command: SlashCommand, limit = Infinity): string {
  const full = `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`;
  return full.length <= limit ? full : `${full.slice(0, limit - 1).trimEnd()}…`;
}

/** A description as one line. Skill descriptions are written for a model -- hundreds of words
 * with embedded newlines -- and printed whole they wrap until the list stops being a list. */
export function oneLine(description: string, room: number): string {
  const flat = description.replace(/\s+/g, " ").trim();
  if (flat.length <= room) return flat;
  // Cut on a word so the truncation reads as a shortened sentence rather than damage.
  const cut = flat.slice(0, room - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > room / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** What Tab completes. Only after a slash: everything else typed here is a prompt, and turning
 * English words into command names is worse than not completing. */
export function complete(
  line: string,
  commands: readonly SlashCommand[],
): [string[], string] {
  if (!line.startsWith("/")) return [[], line];
  const { matches } = lookup(line, commands);
  return [matches.map((command) => `/${command.name}`), line];
}
