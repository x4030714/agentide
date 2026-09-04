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

/** Theme ids registered below. Pick with `themeFor(appearance)`. */
export const THEME_DARK = "agentide-dark";
export const THEME_LIGHT = "agentide-light";

export function themeFor(appearance: "light" | "dark"): string {
  return appearance === "dark" ? THEME_DARK : THEME_LIGHT;
}

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
/**
 * The editor's palette, per theme, using the same role values as `styles/world.css`.
 * Change one and change the other: a colour that means one thing in the tree and
 * another in the editor breaks the premise the whole system rests on.
 */
interface Role {
  ground: string;
  gutter: string;
  raised: string;
  hairline: string;
  border: string;
  ink: string;
  inkDim: string;
  inkFaint: string;
  addr: string;
  sym: string;
  xref: string;
  imm: string;
  error: string;
  warn: string;
  hint: string;
  selection: string;
  lineHighlight: string;
}

const DARK: Role = {
  ground: "#151819",
  gutter: "#131619",
  raised: "#21252c",
  hairline: "#252a31",
  border: "#39404a",
  ink: "#e9edf3",
  inkDim: "#a3acb9",
  inkFaint: "#6e7885",
  addr: "#e3ae52",
  sym: "#7cbaff",
  xref: "#5fd693",
  imm: "#ff8fa8",
  error: "#ff6f66",
  warn: "#f2c14a",
  hint: "#6ad0ff",
  selection: "#7cbaff33",
  lineHighlight: "#ffffff08",
};

const LIGHT: Role = {
  ground: "#ffffff",
  gutter: "#fafbfc",
  raised: "#ffffff",
  hairline: "#e8eaee",
  border: "#c9ced6",
  ink: "#1b1f27",
  inkDim: "#59636f",
  inkFaint: "#8a939f",
  addr: "#855a0b",
  sym: "#0a5fc2",
  xref: "#10703f",
  imm: "#b8185a",
  error: "#bd261e",
  warn: "#835b00",
  hint: "#0366a1",
  selection: "#0a5fc226",
  lineHighlight: "#0000000a",
};

function defineTheme(id: string, role: Role, base: "vs" | "vs-dark") {
  monaco.editor.defineTheme(id, {
    base,
    inherit: true,
    rules: [
      { token: "", foreground: role.ink, background: role.ground },
      { token: "comment", foreground: role.inkDim },
      // The operation.
      { token: "keyword", foreground: role.addr },
      { token: "keyword.control", foreground: role.addr },
      { token: "storage", foreground: role.addr },
      { token: "storage.type", foreground: role.addr },
      { token: "annotation", foreground: role.addr },
      { token: "metatag", foreground: role.addr },
      { token: "attribute.name", foreground: role.addr },
      // Immediates: every literal value, string and numeric alike.
      { token: "string", foreground: role.imm },
      { token: "string.escape", foreground: role.xref },
      { token: "number", foreground: role.imm },
      { token: "number.hex", foreground: role.imm },
      { token: "constant", foreground: role.imm },
      { token: "attribute.value", foreground: role.imm },
      // Resolved symbols.
      { token: "type", foreground: role.sym },
      { token: "type.identifier", foreground: role.sym },
      { token: "struct", foreground: role.sym },
      { token: "class", foreground: role.sym },
      { token: "interface", foreground: role.sym },
      { token: "namespace", foreground: role.sym },
      { token: "function", foreground: role.sym },
      { token: "tag", foreground: role.sym },
      { token: "identifier", foreground: role.ink },
      { token: "variable", foreground: role.ink },
      { token: "delimiter", foreground: role.inkDim },
      { token: "operator", foreground: role.inkDim },
      { token: "regexp", foreground: role.xref },
      { token: "invalid", foreground: role.error },
    ],
    colors: {
      "editor.background": role.ground,
      "editor.foreground": role.ink,

      "editorGutter.background": role.gutter,
      "editorLineNumber.foreground": role.inkFaint,
      "editorLineNumber.activeForeground": role.sym,
      "editorCursor.foreground": role.sym,

      "editor.selectionBackground": role.selection,
      "editor.inactiveSelectionBackground": role.selection,
      "editor.selectionHighlightBackground": role.selection,
      "editor.wordHighlightBackground": role.selection,

      "editor.lineHighlightBackground": role.lineHighlight,
      "editor.lineHighlightBorder": "#00000000",

      "editorIndentGuide.background1": role.hairline,
      "editorIndentGuide.activeBackground1": role.border,
      "editorWhitespace.foreground": role.inkFaint,
      "editorRuler.foreground": role.hairline,

      "editorBracketMatch.background": "#00000000",
      "editorBracketMatch.border": role.sym,
      "editorBracketHighlight.foreground1": role.inkDim,
      "editorBracketHighlight.foreground2": role.sym,
      "editorBracketHighlight.foreground3": role.xref,

      "editor.findMatchBackground": `${role.addr}4d`,
      "editor.findMatchHighlightBackground": `${role.addr}26`,

      "editorError.foreground": role.error,
      "editorWarning.foreground": role.warn,
      "editorInfo.foreground": role.hint,

      "editorOverviewRuler.border": "#00000000",
      "editorOverviewRuler.errorForeground": role.error,
      "editorOverviewRuler.warningForeground": role.warn,

      "scrollbar.shadow": "#00000000",
      "scrollbarSlider.background": `${role.inkFaint}55`,
      "scrollbarSlider.hoverBackground": `${role.inkDim}aa`,
      "scrollbarSlider.activeBackground": role.inkDim,

      "editorWidget.background": role.raised,
      "editorWidget.border": role.border,
      "editorSuggestWidget.background": role.raised,
      "editorSuggestWidget.border": role.border,
      "editorSuggestWidget.selectedBackground": role.selection,
      "editorSuggestWidget.highlightForeground": role.sym,
      "editorHoverWidget.background": role.raised,
      "editorHoverWidget.border": role.border,

      "input.background": role.gutter,
      "input.border": role.border,
      focusBorder: role.sym,
    },
  });
}

defineTheme(THEME_DARK, DARK, "vs-dark");
defineTheme(THEME_LIGHT, LIGHT, "vs");

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
