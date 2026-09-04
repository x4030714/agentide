/**
 * Monaco bootstrap. Import this once, before any editor mounts.
 *
 * Two things have to be right or the editor degrades quietly:
 *
 * 1. `MonacoEnvironment.getWorker` must return real `Worker` instances. Vite's `?worker`
 *    suffix bundles each entry point and gives us a constructor, which is the only form
 *    that survives both `vite dev` and a production build with hashed asset names. With
 *    no `getWorker`, Monaco falls back to `getWorkerUrl` and fetches from a `baseUrl`
 *    that does not exist in a Tauri bundle -- syntax colouring still works but
 *    completions, diagnostics and formatting silently never appear.
 * 2. `loader.config({ monaco })` points `@monaco-editor/react` at this bundled copy.
 *    Its default is to pull Monaco off a CDN at runtime, which fails offline and inside
 *    the packaged app, leaving a permanently blank editor.
 */

import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import cssWorker from "monaco-editor/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/language/json/json.worker?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker?worker";

/** Editor theme id registered below. */
export const THEME = "agentide-dark";

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        // Diffing, link detection and word-based suggestions for every other language.
        return new editorWorker();
    }
  },
};

/**
 * The listing's four ink roles, applied to code.
 *
 * These are the same values as `styles/world.css`, and they carry the same meanings:
 * amber is the operation, blue is a resolved symbol, pink is an immediate, green is a
 * reference. Change one and change the other -- a colour that means one thing in the
 * tree and another in the editor breaks the premise of the world.
 */
const ROLE = {
  ground: "#0e1013",
  gutter: "#0a0c0f",
  raised: "#14171c",
  rule: "#3d4657",
  ruleStrong: "#5a6473",
  ruleGuide: "#2b3340",
  ink: "#c9d2db",
  inkDim: "#7c8798",
  inkFaint: "#48515f",
  addr: "#c99a3e",
  addrDim: "#9e7c36",
  sym: "#6fb2ff",
  xref: "#4fcb7b",
  imm: "#e86a8c",
  error: "#ff5c57",
  warn: "#f0b429",
  hint: "#57c7ff",
} as const;

monaco.editor.defineTheme(THEME, {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "", foreground: ROLE.ink, background: ROLE.ground },
    // Not italic: a listing shows what is there, at one slant.
    { token: "comment", foreground: ROLE.inkDim },
    // The operation.
    { token: "keyword", foreground: ROLE.addr },
    { token: "keyword.control", foreground: ROLE.addr },
    { token: "storage", foreground: ROLE.addr },
    { token: "storage.type", foreground: ROLE.addr },
    { token: "annotation", foreground: ROLE.addr },
    { token: "metatag", foreground: ROLE.addr },
    { token: "attribute.name", foreground: ROLE.addr },
    // Immediates: every literal value, string and numeric alike.
    { token: "string", foreground: ROLE.imm },
    { token: "string.escape", foreground: ROLE.xref },
    { token: "number", foreground: ROLE.imm },
    { token: "number.hex", foreground: ROLE.imm },
    { token: "constant", foreground: ROLE.imm },
    { token: "attribute.value", foreground: ROLE.imm },
    // Resolved symbols.
    { token: "type", foreground: ROLE.sym },
    { token: "type.identifier", foreground: ROLE.sym },
    { token: "struct", foreground: ROLE.sym },
    { token: "class", foreground: ROLE.sym },
    { token: "interface", foreground: ROLE.sym },
    { token: "namespace", foreground: ROLE.sym },
    { token: "function", foreground: ROLE.sym },
    { token: "tag", foreground: ROLE.sym },
    // Plain listing ink.
    { token: "identifier", foreground: ROLE.ink },
    { token: "variable", foreground: ROLE.ink },
    // Structure recedes.
    { token: "delimiter", foreground: ROLE.inkDim },
    { token: "operator", foreground: ROLE.inkDim },
    // A pattern is a reference to text.
    { token: "regexp", foreground: ROLE.xref },
    { token: "invalid", foreground: ROLE.error },
  ],
  colors: {
    "editor.background": ROLE.ground,
    "editor.foreground": ROLE.ink,

    // The address column, darker than the listing it indexes -- and its numbers are
    // addresses, so they carry the addr role rather than Monaco's neutral grey.
    "editorGutter.background": ROLE.gutter,
    "editorLineNumber.foreground": ROLE.addrDim,
    "editorLineNumber.activeForeground": ROLE.addr,

    // Amber caret: where you are, in the colour the addresses use.
    "editorCursor.foreground": ROLE.addr,

    "editor.selectionBackground": "#6fb2ff33",
    "editor.inactiveSelectionBackground": "#6fb2ff1a",
    "editor.selectionHighlightBackground": "#6fb2ff1a",
    "editor.wordHighlightBackground": "#6fb2ff1a",
    "editor.wordHighlightStrongBackground": "#4fcb7b26",

    "editor.lineHighlightBackground": ROLE.raised,
    "editor.lineHighlightBorder": "#00000000",

    "editorIndentGuide.background1": ROLE.ruleGuide,
    "editorIndentGuide.activeBackground1": ROLE.ruleStrong,
    "editorWhitespace.foreground": ROLE.inkFaint,
    "editorRuler.foreground": ROLE.rule,

    "editorBracketMatch.background": "#00000000",
    "editorBracketMatch.border": ROLE.addr,
    "editorBracketHighlight.foreground1": ROLE.inkDim,
    "editorBracketHighlight.foreground2": ROLE.sym,
    "editorBracketHighlight.foreground3": ROLE.xref,

    "editor.findMatchBackground": "#c99a3e4d",
    "editor.findMatchHighlightBackground": "#c99a3e26",

    "editorError.foreground": ROLE.error,
    "editorWarning.foreground": ROLE.warn,
    "editorInfo.foreground": ROLE.hint,

    "editorOverviewRuler.border": "#00000000",
    "editorOverviewRuler.errorForeground": ROLE.error,
    "editorOverviewRuler.warningForeground": ROLE.warn,

    "scrollbar.shadow": "#00000000",
    "scrollbarSlider.background": "#2b324099",
    "scrollbarSlider.hoverBackground": "#48515fcc",
    "scrollbarSlider.activeBackground": ROLE.inkFaint,

    "editorWidget.background": ROLE.raised,
    "editorWidget.border": ROLE.ruleStrong,
    "editorSuggestWidget.background": ROLE.raised,
    "editorSuggestWidget.border": ROLE.ruleStrong,
    "editorSuggestWidget.selectedBackground": "#6fb2ff26",
    "editorSuggestWidget.highlightForeground": ROLE.addr,
    "editorHoverWidget.background": ROLE.raised,
    "editorHoverWidget.border": ROLE.ruleStrong,

    "input.background": ROLE.gutter,
    "input.border": ROLE.ruleStrong,
    "focusBorder": ROLE.addr,
  },
});

// The webview has no network, and the workspace's own tsconfig is not loaded, so
// cross-file type checking would only produce phantom "cannot find module" errors.
// Syntax errors are still real and still reported.
monaco.typescript.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: false,
});
monaco.typescript.javascriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: false,
});

loader.config({ monaco });

export { monaco };
