/**
 * The list that opens under the prompt while you type `/`.
 *
 * Not a listing printed on Enter. Pressing Enter to find out what you could have typed is
 * backwards -- by then you have already sent something -- so this draws as the line
 * changes and the arrows walk it. Typing narrows it, so the menu and the search are the
 * same thing rather than two modes.
 *
 * Pure, and separate from `cli.ts`, because the arithmetic is where this kind of thing
 * breaks: a window that scrolls one row late, a selection that survives a filter it no
 * longer matches, a highlight that points at the wrong entry after wrapping. None of that
 * is visible in a screenshot and all of it is a test.
 */

import { CALL_COLUMN, call, lookup, oneLine } from "./cli-commands.ts";
import { clip, pad, theme as plainTheme, width } from "./cli-theme.ts";
import type { Theme } from "./cli-theme.ts";
import type { SlashCommand } from "./protocol.ts";

/** Rows of commands drawn at once. The footer is extra. */
export const MENU_HEIGHT = 8;

export interface Menu {
  /** What the typed text matched, in the order they will be drawn. */
  matches: SlashCommand[];
  /** Index into `matches`. Always valid: a menu with no matches is never made. */
  selected: number;
  /** First visible row, so a long list scrolls instead of filling the terminal. */
  top: number;
}

/**
 * The menu for a line, or null when there should not be one.
 *
 * Null for anything not starting with `/` -- most of what is typed here is a prompt --
 * and null when nothing matches, because an empty box under the cursor says the CLI is
 * broken where showing nothing says the search found nothing.
 */
export function menuFor(line: string, commands: readonly SlashCommand[]): Menu | null {
  if (!line.startsWith("/")) return null;
  // The name only. `/model claude-opus-5` has stopped being a search the moment there is
  // an argument, and a menu still open over it is in the way.
  if (/^\/\S+\s/.test(line)) return null;
  const { matches } = lookup(line, commands);
  if (matches.length === 0) return null;
  return { matches, selected: 0, top: 0 };
}

/**
 * Move the selection, and the window with it if it has to.
 *
 * Wraps, because the fastest way to the last entry in a list of ninety is up. The window
 * follows the selection by the smallest amount that keeps it visible, which is what makes
 * holding a key feel like scrolling rather than paging.
 */
export function move(menu: Menu, delta: number, height = MENU_HEIGHT): Menu {
  const count = menu.matches.length;
  const selected = (menu.selected + delta + count) % count;
  const last = Math.max(0, count - height);
  let top = menu.top;
  if (selected < top) top = selected;
  if (selected >= top + height) top = selected - height + 1;
  return { ...menu, selected, top: Math.min(top, last) };
}

/** The commands actually drawn, given the window. */
export function visible(menu: Menu, height = MENU_HEIGHT): SlashCommand[] {
  return menu.matches.slice(menu.top, menu.top + height);
}

/** What the selected entry is called, for the line it produces. */
export function selection(menu: Menu): SlashCommand {
  return menu.matches[menu.selected] as SlashCommand;
}

export interface Drawn {
  terminal?: number;
  height?: number;
  theme?: Theme;
  /** Drawn to the left of every row, so the menu can sit inside the prompt's box. */
  gutter?: string;
}

/**
 * The rows to draw, colour and footer included.
 *
 * Every row is padded to the same visible width before the selected one is inverted, so
 * the highlight reads as a bar across the list rather than as a ragged blob the length of
 * its own description. `pad` counts what is seen; `String.length` would count the colour.
 */
export function rows(menu: Menu, options: Drawn = {}): string[] {
  const paint = options.theme ?? plainTheme({ isTTY: false });
  const height = options.height ?? MENU_HEIGHT;
  const gutter = options.gutter ?? "";
  const inner = Math.max(20, (options.terminal ?? 100) - width(gutter) - 1);

  const column = Math.min(
    CALL_COLUMN,
    visible(menu, height).reduce((widest, command) => Math.max(widest, call(command).length), 0),
  );
  const room = Math.max(16, inner - column - 4);

  const lines = visible(menu, height).map((command, index) => {
    const chosen = menu.top + index === menu.selected;
    const name = pad(clip(call(command, column), column), column);
    const note = clip(oneLine(command.description, room), room);
    // The selected row is inverted, and inverting text that already carries a colour
    // produces whatever that colour is on a coloured ground -- often unreadable. So the
    // highlighted row is painted once, plain, and the colours go on the others.
    const body = chosen
      ? paint.selected(pad(` ${name}  ${note}`, inner))
      : `${paint.accent(name)}  ${paint.dim(note)}`;
    return `${gutter}${chosen ? "" : " "}${body}`;
  });
  return [...lines, `${gutter} ${paint.dim(footer(menu, height))}`];
}

/**
 * The line under the list.
 *
 * It says how many there are, because a window of eight over ninety commands otherwise
 * looks like the whole set -- which is the bug this feature was reported as.
 */
function footer(menu: Menu, height: number): string {
  const count = menu.matches.length;
  const where = count > height ? `${menu.selected + 1}/${count}` : `${count}`;
  return `${where}  ↑↓ move · enter run · tab complete · esc close`;
}

/**
 * The line the selection should leave behind, and whether it is ready to send.
 *
 * A command that takes no argument runs on the same Enter that chose it; one that takes
 * an argument leaves a trailing space and waits, because sending `/model` alone would run
 * a command missing the only thing it needed.
 */
export function accept(menu: Menu): { line: string; submit: boolean } {
  const command = selection(menu);
  return command.argumentHint
    ? { line: `/${command.name} `, submit: false }
    : { line: `/${command.name}`, submit: true };
}
