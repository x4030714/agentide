import type { ITheme } from "@xterm/xterm";

/**
 * The terminal's palette, derived from the app's semantic roles rather than picked.
 *
 * ANSI's sixteen colours already carry meaning that maps onto ours almost exactly — red
 * is a failure, green is an addition, yellow is a warning, blue is a name. Wiring them
 * to the same tokens the tree and the syntax theme use means a red in the terminal and
 * a red in the diff mean the same thing, which is the whole premise of the role system.
 *
 * The background is transparent on purpose: the pane behind it is translucent, and an
 * opaque terminal would punch a solid rectangle through the window.
 */

interface Roles {
  ink: string;
  inkDim: string;
  addr: string;
  sym: string;
  xref: string;
  imm: string;
  uncommitted: string;
  error: string;
  warn: string;
  hint: string;
  selection: string;
}

const DARK: Roles = {
  ink: "#e9edf3",
  inkDim: "#a7afbc",
  addr: "#e3ae52",
  sym: "#7cbaff",
  xref: "#5fd693",
  imm: "#ff8fa8",
  uncommitted: "#ee8fda",
  error: "#ff8f88",
  warn: "#f2c14a",
  hint: "#6ad0ff",
  selection: "#7cbaff40",
};

const LIGHT: Roles = {
  ink: "#1b1f27",
  inkDim: "#515a65",
  addr: "#78510a",
  sym: "#0956b1",
  xref: "#0f663a",
  imm: "#ac1654",
  uncommitted: "#9c1489",
  error: "#ab221b",
  warn: "#765200",
  hint: "#035d93",
  selection: "#0956b133",
};

function theme(role: Roles, dark: boolean): ITheme {
  return {
    // Transparent, so the translucent pane behind shows through.
    background: "#00000000",
    foreground: role.ink,
    cursor: role.sym,
    cursorAccent: dark ? "#151819" : "#ffffff",
    selectionBackground: role.selection,

    /**
     * The normal eight are the roles at reading weight. `black` is not black and
     * `white` is not white — they are the ends of our own ink ramp, because a program
     * printing "black" on a dark terminal means "dim", not "invisible".
     */
    black: dark ? "#3a4049" : "#c9ced6",
    red: role.error,
    green: role.xref,
    yellow: role.addr,
    blue: role.sym,
    magenta: role.uncommitted,
    cyan: role.hint,
    white: role.inkDim,

    /** Bright is the same meaning, louder: emphasis, not a different colour. */
    brightBlack: dark ? "#5b6470" : "#9aa2ad",
    brightRed: role.imm,
    brightGreen: role.xref,
    brightYellow: role.warn,
    brightBlue: role.sym,
    brightMagenta: role.uncommitted,
    brightCyan: role.hint,
    brightWhite: role.ink,
  };
}

export function terminalTheme(appearance: "light" | "dark"): ITheme {
  return appearance === "dark" ? theme(DARK, true) : theme(LIGHT, false);
}

/**
 * Shared with the editor so a column of output and a column of code line up. The font
 * stack is Iosevka for the same reason it is in Monaco: narrow, so more fits.
 */
export const TERMINAL_FONT = {
  fontFamily: '"Iosevka", ui-monospace, "Cascadia Mono", Consolas, monospace',
  fontSize: 13,
  lineHeight: 1.35,
} as const;
