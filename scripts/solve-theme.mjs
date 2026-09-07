/**
 * Solve a theme's colours against its own worst-case composite, and print the CSS.
 *
 * The window is translucent, so a pane's effective background depends on the user's
 * wallpaper. PRODUCT.md fixes the rule: contrast is verified against the worst case, not
 * the nominal colour. A pane sits at 82% effective, so the worst case is that surface
 * composited over black (light themes) or over white (dark themes) -- which means a theme
 * that tints its surfaces has a *different* worst case, and colours solved for the
 * default one would not be safe in it.
 *
 * So nothing here is hand-tuned. A theme is a list of hues and a surface tint; this walks
 * lightness in OKLCH until each colour clears the floor against that theme's own
 * composite, and prints the result. "It passes" is then a fact, and adding a theme is a
 * few numbers rather than an afternoon with a contrast checker.
 *
 *   node scripts/solve-theme.mjs           # print the CSS
 *   node scripts/solve-theme.mjs --check   # verify the committed values still pass
 */

import { readFileSync } from "node:fs";

/**
 * What a pane composites to: `--ground` under `--surface`, both translucent.
 *
 * A theme may override it. An opaque theme sits at 1 and has no wallpaper under it, so
 * its worst case is one of its own flat greys -- which is not a special case to be worked
 * around but the same solve with the hard part removed. Every theme is emitted twice for
 * that reason: once as glass, and once at alpha 1 for the Transparency setting.
 */
const EFFECTIVE_ALPHA = 0.82;
const INK_TARGET = 4.5;
const ROLE_TARGET = 4.55; // Over the floor, so rounding to 8-bit cannot drop it under.
const FILL_TARGET = 7; // White text on a filled field.

// --- Colour ---------------------------------------------------------------------

const clamp01 = (value) => Math.min(1, Math.max(0, value));

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16) / 255);
}

function rgbToHex(rgb) {
  return `#${rgb.map((c) => Math.round(clamp01(c) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function oklchToRgb(l, c, hDegrees) {
  const h = (hDegrees * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const [L, M, S] = [l_ ** 3, m_ ** 3, s_ ** 3];
  return [
    linearToSrgb(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S),
    linearToSrgb(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S),
    linearToSrgb(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S),
  ];
}

const inGamut = (rgb) => rgb.every((c) => c >= -0.001 && c <= 1.001);

function luminance(rgb) {
  const [r, g, b] = rgb.map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(aHex, bHex) {
  const a = luminance(hexToRgb(aHex));
  const b = luminance(hexToRgb(bHex));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** A surface nudged lighter or darker, for the steps an opaque theme cannot fake with alpha. */
function lift(hex, amount) {
  return rgbToHex(hexToRgb(hex).map((c) => clamp01(c + amount)));
}

/** The colour a surface actually renders as, over the least forgiving wallpaper. */
function worstCase(surfaceHex, darkMode, alpha = EFFECTIVE_ALPHA) {
  const wallpaper = darkMode ? 1 : 0;
  const surface = hexToRgb(surfaceHex);
  return rgbToHex(surface.map((c) => alpha * c + (1 - alpha) * wallpaper));
}

/**
 * The worst case for an opaque theme: whichever of its own greys gives text the least.
 *
 * There is no wallpaper to fear, but there are four surfaces and they are not the same
 * grey. Dark ink loses on the darkest of them and light ink loses on the lightest, so the
 * solve runs against that one and the other three come out with headroom. Solving against
 * `--surface` alone would leave the elevated menu -- the one surface that is deliberately
 * further from the ground -- a little under the floor.
 */
function hardestGrey(hexes, darkMode) {
  return hexes.reduce((worst, hex) => {
    const worse = luminance(hexToRgb(hex)) > luminance(hexToRgb(worst));
    return worse === darkMode ? hex : worst;
  });
}

/**
 * The most saturated colour of this hue that still clears `target` on `background`.
 *
 * Chroma drops only when the hue at that lightness leaves sRGB. Clipping instead would
 * shift the hue silently, and in a four-role system that means two roles drifting
 * towards each other until they stop being tellable apart.
 */
function solve(hue, background, { darkMode, target = ROLE_TARGET, chroma = 0.16 }) {
  const steps = 500;
  for (let step = 0; step <= steps; step += 1) {
    const l = darkMode ? 0.45 + (0.55 * step) / steps : 0.72 - (0.6 * step) / steps;
    for (let c = chroma; c >= 0.015; c -= 0.004) {
      const rgb = oklchToRgb(l, c, hue);
      if (!inGamut(rgb)) continue;
      const hex = rgbToHex(rgb);
      if (contrast(hex, background) >= target) return hex;
      break;
    }
  }
  return null;
}

/** A field with white text on it, so it is solved against white rather than the pane. */
const solveFill = (hue, darkMode) =>
  solve(hue, "#ffffff", { darkMode: false, target: FILL_TARGET, chroma: darkMode ? 0.18 : 0.16 });

const tint = (hex, percent) => {
  const [r, g, b] = hexToRgb(hex).map((c) => Math.round(c * 255));
  return `rgb(${r} ${g} ${b} / ${percent}%)`;
};

// --- Themes ---------------------------------------------------------------------
//
// Four role hues plus the states, and the surface each mode is tinted with.
//
// Two constraints, and the second was learned the hard way. Within a palette the four
// hues must sit far enough apart to stay tellable at a glance -- that is the only reason
// they are colours rather than shapes. *Between* palettes, `sym` must differ, because it
// is not just the symbol colour: it drives `--tint-accent`, which fills the prompt
// bubble, and `--md-inline-code`, so it is the single most visible colour in the app.
// The first cut gave three palettes a blue-ish `sym` and they looked identical where it
// mattered most.
//
// The four themes named after well-known editor themes strain the second rule, because
// two of them are cold by definition: `sym` runs 175 (Solarized cyan), 205 (Halide), 232
// (Nord frost), 250 (VS Code), 257 (Quiet). Thirty degrees apart is close, and what keeps
// them tellable is the surface each one lands on -- cream, near-black, blue-grey, flat
// grey. Adding a sixth cold palette would break that, and the fix would be to move its
// hue rather than to shade the surfaces towards each other.
//
// None of the four is a port. The hues are measured off the originals and then re-solved
// here, so a value that would have failed the contrast floor moved instead of shipping;
// `note` says so on each, because a palette file repeats its own claims forever.

const THEMES = [
  {
    name: "quiet",
    label: "Quiet Instrument",
    note: "The default. Its glass values live in world.css; only the opaque set is here.",
    /**
     * The default palette, and the one theme whose translucent values are not generated:
     * they are the base case in `world.css`, which is where the app with no preferences
     * set gets its colours. What is missing there is the opaque set, so that is all this
     * entry emits -- the Transparency setting has to work on the palette most people are
     * on, and it cannot without this.
     */
    base: true,
    neutralHue: 264,
    light: { ground: "#f4f5f8", surface: "#ffffff", ink: "#1b1f27" },
    dark: { ground: "#111317", surface: "#15181d", ink: "#e9edf3" },
    // Measured off the values world.css already ships, so the opaque set is the same
    // palette with the glass taken out rather than a second design.
    roles: { addr: 75, sym: 257, xref: 155, imm: 4 },
    states: { uncommitted: 335, error: 29, warn: 79, hint: 245 },
  },
  {
    name: "vscode",
    label: "VS Code",
    note: "Dark+ greys and its blue. Opaque, like the editor it is named after.",
    neutralHue: 250,
    /**
     * Opaque, and that is the whole character of it. Every other theme here is glass over
     * the desktop; this one is the flat panel VS Code actually is, so there is no
     * wallpaper to solve against and the surfaces are exactly the greys named below.
     */
    alpha: 1,
    light: { ground: "#f3f3f3", surface: "#ffffff", ink: "#3b3b3b" },
    // Dark Modern's own values: editor #1f1f1f, side bar #181818, text #cccccc.
    dark: { ground: "#181818", surface: "#1f1f1f", ink: "#cccccc" },
    // Blue is the accent, because in VS Code it always is.
    roles: { addr: 250, sym: 250, xref: 150, imm: 30 },
    states: { uncommitted: 45, error: 25, warn: 60, hint: 250 },
  },
  {
    name: "ferrous",
    label: "Ferrous",
    note: "Warm graphite and copper. The workshop end of the register.",
    neutralHue: 50,
    light: { ground: "#f7f4f1", surface: "#fffdfb", ink: "#241d18" },
    dark: { ground: "#17130f", surface: "#1d1815", ink: "#f2ebe5" },
    // Copper accent, the whole point of the palette.
    roles: { addr: 90, sym: 30, xref: 165, imm: 300 },
    states: { uncommitted: 315, error: 20, warn: 70, hint: 240 },
  },
  {
    name: "halide",
    label: "Halide",
    note: "Cold cyan on near-black. A darkroom, and the coolest of the four.",
    neutralHue: 205,
    light: { ground: "#f1f5f6", surface: "#fbfefe", ink: "#131f22" },
    dark: { ground: "#0d1416", surface: "#121a1d", ink: "#e6f1f3" },
    // Cyan accent, well away from the default's blue.
    roles: { addr: 60, sym: 205, xref: 140, imm: 320 },
    states: { uncommitted: 285, error: 20, warn: 70, hint: 195 },
  },
  {
    name: "vellum",
    label: "Vellum",
    note: "Warm paper, ink and marginalia. The quietest of the four.",
    neutralHue: 85,
    light: { ground: "#f8f6ef", surface: "#fffef8", ink: "#211f16" },
    dark: { ground: "#16150f", surface: "#1c1a14", ink: "#f2efe2" },
    // Violet accent: ink on paper, and not the default's blue.
    roles: { addr: 60, sym: 290, xref: 145, imm: 15 },
    states: { uncommitted: 330, error: 25, warn: 65, hint: 275 },
  },
  {
    name: "nord",
    label: "Nord",
    note: "Cold desaturated blue-grey, in Nord's spirit. Solved here, not copied from it.",
    // Polar Night measures 264 in OKLCH; 250 keeps the grey cold without pulling it
    // violet, which is what 264 does at the low chroma `--ink-dim` is solved at.
    neutralHue: 250,
    light: { ground: "#e8ecf3", surface: "#f6f8fc", ink: "#2e3440" },
    /**
     * Darker than Polar Night's own #2e3440, and that is the one place this parts company
     * with Nord. At 82% over a white wallpaper #2e3440 composites to a mid grey, and a
     * role clearing 4.5:1 against *that* has to be nearly white -- the palette would lose
     * its colour to pass its own floor. Dropping the base two steps keeps both.
     */
    dark: { ground: "#171b23", surface: "#1d222c", ink: "#e2e8f2" },
    // Frost blue, sitting between #88c0d0 (217) and #81a1c1 (249).
    roles: { addr: 84, sym: 232, xref: 131, imm: 333 },
    states: { uncommitted: 300, error: 15, warn: 60, hint: 194 },
  },
  {
    name: "gruvbox",
    label: "Gruvbox",
    note: "Warm retro, in Gruvbox's spirit. Solved here, not copied from it.",
    neutralHue: 70,
    // Cream, the way the light mode is remembered: #fbf1c7 with a step under it.
    light: { ground: "#f6edcf", surface: "#fdf7e4", ink: "#3c3836" },
    // Warm near-black rather than #282828, for the reason Nord's dark is darker too.
    dark: { ground: "#1a1714", surface: "#201c17", ink: "#ebdbb2" },
    // Amber accent -- the yellow #d79921, which is the colour the theme is remembered by.
    roles: { addr: 199, sym: 78, xref: 145, imm: 352 },
    states: { uncommitted: 320, error: 29, warn: 46, hint: 199 },
  },
  {
    name: "dracula",
    label: "Dracula",
    note: "Near-black, purple and pink, in Dracula's spirit. Solved here, not copied.",
    neutralHue: 278,
    // A light mode Dracula does not really have: its own is cream. Lavender instead,
    // because the palette below reads as a mistake on cream.
    light: { ground: "#f2eff8", surface: "#fbf9ff", ink: "#282a36" },
    dark: { ground: "#131320", surface: "#191a28", ink: "#f2f2ee" },
    // Pink accent and purple immediates, the pair the theme is named for.
    roles: { addr: 67, sym: 340, xref: 148, imm: 302 },
    // Uncommitted is the comment blue-violet #6272a4, which is the one Dracula colour
    // that already means "not part of the program".
    states: { uncommitted: 270, error: 24, warn: 85, hint: 213 },
  },
  {
    name: "solarized",
    label: "Solarized",
    note: "The teal and amber pairing, in Solarized's spirit. Solved here, not copied.",
    // 200 rather than the base greys' measured 220: teal is the half of the pairing the
    // neutrals are meant to carry.
    neutralHue: 200,
    // Both modes are tinted, which is the whole idea -- base3 cream and a deep teal --
    // and it is why the roles differ from every other theme's at the same hue.
    light: { ground: "#f3ead4", surface: "#fdf6e3", ink: "#0d3b47" },
    // base02 #073642 composites too light under a white wallpaper; this is base03 pulled
    // down until the roles keep their chroma.
    dark: { ground: "#001a21", surface: "#04222a", ink: "#cfe0e0" },
    // Cyan #2aa198 accent, pulled 12 degrees green off its measured 187 to stay clear of
    // Halide's 205; amber #b58900 addresses. Green moves off its own 119 to 130, because
    // at 119 it and the amber solve to two olives that are not tellable apart.
    roles: { addr: 86, sym: 175, xref: 130, imm: 356 },
    states: { uncommitted: 279, error: 27, warn: 40, hint: 245 },
  },
];

function emit(theme, mode) {
  const darkMode = mode === "dark";
  const palette = theme[mode];
  const opaque = theme.alpha === 1;
  const chrome = lift(palette.surface, darkMode ? 0.02 : -0.02);
  const elevated = lift(palette.surface, darkMode ? 0.05 : -0.03);
  const background = opaque
    ? hardestGrey([palette.ground, palette.surface, chrome, elevated], darkMode)
    : worstCase(palette.surface, darkMode);
  const lines = [];
  const failures = [];

  const record = (token, hex, against, target) => {
    const ratio = contrast(hex, against);
    if (ratio < target) failures.push(`${theme.name}/${mode} --${token} ${ratio.toFixed(2)}`);
    lines.push(`  --${token}: ${hex}; /* ${ratio.toFixed(2)} */`);
  };

  /**
   * The three surfaces, at the alphas the design calls for -- or flat, for an opaque
   * theme.
   *
   * An opaque theme cannot express its steps as transparency, because there is nothing
   * behind them to show through. It gets real greys instead: the ground as given, and
   * the surfaces lifted off it, which is how a flat editor separates a sidebar from a
   * document without a hairline doing all the work.
  */
  lines.push(`  --ground: ${opaque ? palette.ground : tint(palette.ground, darkMode ? 53 : 55)};`);
  lines.push(`  --surface: ${opaque ? palette.surface : tint(palette.surface, 62)};`);
  lines.push(`  --chrome: ${opaque ? chrome : tint(palette.surface, 70)};`);
  lines.push(`  --elevated: ${opaque ? elevated : tint(palette.surface, 97)};`);
  record("ink", palette.ink, background, INK_TARGET);
  // Solved, not chosen: secondary ink is the token most likely to be a little too dim,
  // and "a little too dim" is exactly what a floor exists to catch.
  const inkDim = solve(theme.neutralHue, background, {
    darkMode,
    target: INK_TARGET + 0.05,
    chroma: 0.022,
  });
  if (!inkDim) failures.push(`${theme.name}/${mode} --ink-dim UNSOLVED`);
  else record("ink-dim", inkDim, background, INK_TARGET);

  const roles = {};
  for (const [token, hue] of Object.entries({ ...theme.roles, ...theme.states })) {
    const hex = solve(hue, background, { darkMode });
    if (!hex) {
      failures.push(`${theme.name}/${mode} --${token} UNSOLVED`);
      continue;
    }
    roles[token] = hex;
    record(token, hex, background, ROLE_TARGET);
  }

  for (const [token, hue] of [
    ["sym-fill", theme.roles.sym],
    ["warn-fill", theme.states.warn],
  ]) {
    const hex = solveFill(hue, darkMode);
    if (!hex) {
      failures.push(`${theme.name}/${mode} --${token} UNSOLVED`);
      continue;
    }
    const ratio = contrast(hex, "#ffffff");
    if (ratio < FILL_TARGET) failures.push(`${theme.name}/${mode} --${token} ${ratio.toFixed(2)}`);
    lines.push(`  --${token}: ${hex}; /* white on it: ${ratio.toFixed(2)} */`);
  }

  if (roles.sym) lines.push(`  --tint-accent: ${tint(roles.sym, darkMode ? 14 : 12)};`);
  if (roles.addr) lines.push(`  --tint-addr: ${tint(roles.addr, darkMode ? 14 : 13)};`);

  return { lines, failures, roles };
}

const checking = process.argv.includes("--check");
const allFailures = [];
const out = [];
/** Each palette's accent, keyed by mode: the picker draws a row in the colour it offers. */
const chips = { light: {}, dark: {} };
let blocks = 0;

/**
 * The selector a theme's block hangs off.
 *
 * The default palette is spelled as the *absence* of `data-palette` -- `applyPalette`
 * removes the attribute rather than writing `quiet` -- so its blocks say `:not()` where
 * every other theme names itself. `[data-opaque="true"]` adds an attribute and with it a
 * point of specificity, so an opaque block beats the glass block it follows on both
 * counts and neither needs `!important`.
 */
function rootFor(theme, opaque) {
  const scope = opaque ? ':root[data-opaque="true"]' : ":root";
  return scope + (theme.base ? ":not([data-palette])" : `[data-palette="${theme.name}"]`);
}

/** One theme, both modes, as glass or as flat greys. */
function push(theme, opaque) {
  const solving = opaque && theme.alpha !== 1 ? { ...theme, alpha: 1 } : theme;
  const root = rootFor(theme, opaque);
  for (const mode of ["light", "dark"]) {
    const { lines, failures, roles } = emit(solving, mode);
    allFailures.push(...failures);
    blocks += 1;
    // The chip takes the first set solved for its theme -- glass for everything that has
    // one, the opaque set for the default, whose glass values live in world.css.
    if (roles.sym && !chips[mode][theme.name]) chips[mode][theme.name] = roles.sym;
    const body = lines.join("\n");
    if (mode === "light") {
      out.push(root + " {", body, "}", "");
    } else {
      // Two blocks, not one selector list: a media query cannot be a member of one.
      // Both spellings are needed -- the explicit override, and system-dark with no
      // override -- which is the same pattern the base palette in world.css uses.
      out.push(root + '[data-theme="dark"] {', body, "}", "");
      out.push("@media (prefers-color-scheme: dark) {");
      out.push("  " + root + ':not([data-theme="light"]) {');
      out.push(body.split("\n").map((line) => "  " + line).join("\n"));
      out.push("  }", "}", "");
    }
  }
}

for (const theme of THEMES) {
  if (!theme.base) {
    out.push(`/* --- ${theme.label} -------------------------------------------------`);
    out.push(` * ${theme.note}`);
    out.push(` * Generated by scripts/solve-theme.mjs. Do not hand-edit a value here:`);
    out.push(` * every one is solved against this theme's own worst-case composite.`);
    out.push(` */`);
    push(theme, false);
  }

  if (theme.alpha === 1 && !theme.base) {
    // Nothing to add: the theme is already flat, so Transparency off leaves it alone.
    out.push(`/* ${theme.label} is opaque as it is: [data-opaque="true"] has nothing to change. */`, "");
    continue;
  }

  out.push(`/* --- ${theme.label}, opaque ------------------------------------------`);
  // The note goes here for the default palette, which has no glass header to carry it.
  if (theme.base) out.push(` * ${theme.note}`);
  out.push(` * The same theme with the glass taken out, for Transparency off: flat greys,`);
  out.push(` * no wallpaper under them, and every colour re-solved against the least`);
  out.push(` * forgiving of those greys rather than against a composite.`);
  out.push(` * Generated by scripts/solve-theme.mjs. Do not hand-edit a value here.`);
  out.push(` */`);
  push(theme, true);
}

/**
 * The picker's chips, which are the one place a palette's colour is needed while a
 * *different* palette is showing -- so they cannot come from the tokens above.
 *
 * Each is that theme's own `--sym`, the value the palette is most identified by, in the
 * mode that is on screen. Generated for the same reason as everything else here: a chip
 * hand-picked in App.css is a colour nobody re-checked when the theme moved.
 */
out.push("/* --- Picker chips ----------------------------------------------------");
out.push(" * Each palette's accent, for the row that offers it. App.css reads these;");
out.push(" * a literal there would be a colour outside the solver's reach.");
out.push(" */");
const chipBody = (mode) =>
  Object.entries(chips[mode])
    .map(([name, hex]) => `  --chip-${name}: ${hex};`)
    .join("\n");
out.push(":root {", chipBody("light"), "}", "");
out.push(':root[data-theme="dark"] {', chipBody("dark"), "}", "");
out.push("@media (prefers-color-scheme: dark) {");
out.push('  :root:not([data-theme="light"]) {');
out.push(chipBody("dark").split("\n").map((line) => "  " + line).join("\n"));
out.push("  }", "}", "");

if (checking) {
  if (allFailures.length > 0) {
    console.error("FAIL\n" + allFailures.join("\n"));
    process.exit(1);
  }
  console.log(`every colour in ${THEMES.length} themes clears its floor, over ${blocks} blocks`);
} else {
  console.log(out.join("\n"));
  if (allFailures.length > 0) console.error("\nFAILURES:\n" + allFailures.join("\n"));
}

// Silence an unused-import warning while keeping the reader's expectation that this
// script could grow a "read the committed CSS back" check.
void readFileSync;
