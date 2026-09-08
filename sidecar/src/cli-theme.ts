/** Colour for the terminal, and when there is none: piped output, `NO_COLOR`, or a terminal
 * that says no. `FORCE_COLOR` overrides all three, which is what it is for. */

/** Claude's terracotta, as truecolor and as the nearest xterm-256 index. */
const ACCENT_RGB = "\u001b[38;2;215;119;87m";
const ACCENT_256 = "\u001b[38;5;173m";
const GREY_256 = "\u001b[38;5;245m";
const RED_256 = "\u001b[38;5;167m";

const BOLD = "\u001b[1m";
const REVERSE = "\u001b[7m";
const RESET = "\u001b[0m";

export interface Theme {
  /** True when every method is the identity, so callers can skip the padding maths. */
  readonly plain: boolean;
  accent(text: string): string;
  dim(text: string): string;
  bold(text: string): string;
  danger(text: string): string;
  /** The selected row: the user's own two colours swapped, since the background is unknown. */
  selected(text: string): string;
}

const PLAIN: Theme = {
  plain: true,
  accent: (text) => text,
  dim: (text) => text,
  bold: (text) => text,
  danger: (text) => text,
  selected: (text) => text,
};

/** `COLORTERM` is the only reliable truecolor signal; without it, stay on the 256-colour ramp. */
function depth(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv): 0 | 8 | 24 {
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") {
    return env.COLORTERM === "truecolor" || env.COLORTERM === "24bit" ? 24 : 8;
  }
  // Set to anything, including the empty string, means no colour. That is the convention.
  if (env.NO_COLOR !== undefined) return 0;
  if (!stream.isTTY) return 0;
  if (env.TERM === "dumb") return 0;
  return env.COLORTERM === "truecolor" || env.COLORTERM === "24bit" ? 24 : 8;
}

export function theme(
  stream: { isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): Theme {
  const level = depth(stream, env);
  if (level === 0) return PLAIN;
  const accent = level === 24 ? ACCENT_RGB : ACCENT_256;
  const wrap = (code: string) => (text: string) => `${code}${text}${RESET}`;
  return {
    plain: false,
    accent: wrap(accent),
    dim: wrap(GREY_256),
    bold: wrap(BOLD),
    danger: wrap(RED_256),
    selected: wrap(REVERSE),
  };
}

/** Visible width. `String.length` counts the escape bytes, so a `padEnd` on a coloured string
 * comes out short by the length of its own colour. Worked out here, once. */
export function width(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "").length;
}

/** `padEnd` that counts what is seen rather than what is stored. */
export function pad(text: string, to: number): string {
  const short = to - width(text);
  return short > 0 ? text + " ".repeat(short) : text;
}

/** Cut to a visible width, keeping the escapes that are already open closed. */
export function clip(text: string, to: number): string {
  if (width(text) <= to) return text;
  let out = "";
  let seen = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\u001b") {
      const end = text.indexOf("m", index);
      if (end !== -1) {
        out += text.slice(index, end + 1);
        index = end;
        continue;
      }
    }
    if (seen >= to) break;
    out += text[index];
    seen += 1;
  }
  return `${out}${RESET}`;
}
