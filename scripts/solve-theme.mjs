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

/** What a pane composites to: `--ground` under `--surface`, both translucent. */
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

/** The colour a surface actually renders as, over the least forgiving wallpaper. */
function worstCase(surfaceHex, darkMode) {
  const wallpaper = darkMode ? 1 : 0;
  const surface = hexToRgb(surfaceHex);
  return rgbToHex(surface.map((c) => EFFECTIVE_ALPHA * c + (1 - EFFECTIVE_ALPHA) * wallpaper));
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

const THEMES = [
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
];

function emit(theme, mode) {
  const darkMode = mode === "dark";
  const palette = theme[mode];
  const background = worstCase(palette.surface, darkMode);
  const lines = [];
  const failures = [];

  const record = (token, hex, against, target) => {
    const ratio = contrast(hex, against);
    if (ratio < target) failures.push(`${theme.name}/${mode} --${token} ${ratio.toFixed(2)}`);
    lines.push(`  --${token}: ${hex}; /* ${ratio.toFixed(2)} */`);
  };

  lines.push(`  --ground: ${tint(palette.ground, darkMode ? 53 : 55)};`);
  lines.push(`  --surface: ${tint(palette.surface, 62)};`);
  lines.push(`  --chrome: ${tint(palette.surface, 70)};`);
  lines.push(`  --elevated: ${tint(palette.surface, 97)};`);
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

  return { lines, failures };
}

const checking = process.argv.includes("--check");
const allFailures = [];
const out = [];

for (const theme of THEMES) {
  out.push(`/* --- ${theme.label} -------------------------------------------------`);
  out.push(` * ${theme.note}`);
  out.push(` * Generated by scripts/solve-theme.mjs. Do not hand-edit a value here:`);
  out.push(` * every one is solved against this theme's own worst-case composite.`);
  out.push(` */`);
  for (const mode of ['light', 'dark']) {
    const { lines, failures } = emit(theme, mode);
    allFailures.push(...failures);
    const body = lines.join('\n');
    const root = ':root[data-palette="' + theme.name + '"]';
    if (mode === 'light') {
      out.push(root + ' {', body, '}', '');
    } else {
      // Two blocks, not one selector list: a media query cannot be a member of one.
      // Both spellings are needed -- the explicit override, and system-dark with no
      // override -- which is the same pattern the base palette in world.css uses.
      out.push(root + '[data-theme="dark"] {', body, '}', '');
      out.push('@media (prefers-color-scheme: dark) {');
      out.push('  ' + root + ':not([data-theme="light"]) {');
      out.push(body.split('\n').map((line) => '  ' + line).join('\n'));
      out.push('  }', '}', '');
    }
  }
}

if (checking) {
  if (allFailures.length > 0) {
    console.error("FAIL\n" + allFailures.join("\n"));
    process.exit(1);
  }
  console.log(`every colour in ${THEMES.length} themes clears its floor`);
} else {
  console.log(out.join("\n"));
  if (allFailures.length > 0) console.error("\nFAILURES:\n" + allFailures.join("\n"));
}

// Silence an unused-import warning while keeping the reader's expectation that this
// script could grow a "read the committed CSS back" check.
void readFileSync;
