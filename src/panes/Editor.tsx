import MonacoEditor from "@monaco-editor/react";
import { useFocusTarget } from "../lib/keys";
import type { editor as MonacoNs } from "monaco-editor";
import { useCallback, useEffect, useRef, useState } from "react";

import { readFile, writeFile } from "../lib/bridge";
import { publishCursor } from "../lib/cursor";
import { formatSize } from "../lib/format";
import { IconReload } from "../lib/icons";
import { useResolvedAppearance } from "../lib/appearance";
import { monaco, themeFor } from "../lib/monaco-setup";
import { publishEditorFacts } from "../lib/ide-host";
import type { Lsp } from "../lib/useLsp";
import { baseName, errorMessage, parentOf, toFileUri } from "../lib/protocol";
import type { FileContents, FsEvent, WirePath } from "../lib/protocol";

/**
 * A cursor placement asked for from outside the editor. The nonce separates two requests for
 * the same spot, which an effect would otherwise see as one.
 */
export interface RevealTarget {
  path: WirePath;
  line?: number;
  column?: number;
  /** With `endLine`, the reveal selects a range instead of only placing the cursor. */
  endLine?: number;
  endColumn?: number;
  nonce: number;
}

interface EditorPaneProps {
  /** Every open file, in the order they were opened. See `src/lib/tabs.ts`. */
  tabs: readonly WirePath[];
  path: WirePath | null;
  /** Latest batch from the workspace watcher; a new array per batch. */
  changes: FsEvent[];
  reveal: RevealTarget | null;
  lsp: Lsp;
  onSelect: (path: WirePath) => void;
  onClose: (path: WirePath) => void;
}

const EDITOR_OPTIONS: MonacoNs.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  fontFamily: '"Iosevka", ui-monospace, "Cascadia Mono", Consolas, monospace',
  fontSize: 13,
  // Matches `--row` in world.css, so editor lines and tree rows sit on one grid.
  lineHeight: 20,
  // A listing shows the characters that are there. Ligatures redraw them.
  fontLigatures: false,
  // No minimap: it is the other editor's vocabulary, and the gutter is our index.
  minimap: { enabled: false },
  renderWhitespace: "selection",
  scrollBeyondLastLine: false,
  // The world's motion is snap-to-address, never eased drift.
  smoothScrolling: false,
  cursorSmoothCaretAnimation: "off",
  guides: { indentation: true, highlightActiveIndentation: true },
  renderLineHighlight: "line",
  overviewRulerBorder: false,
  padding: { top: 6, bottom: 6 },
  scrollbar: {
    verticalScrollbarSize: 10,
    horizontalScrollbarSize: 10,
    useShadows: false,
  },
  tabSize: 2,
};

/**
 * The text editor: loading, dirty state and saving. Monaco keeps one model per path, and the
 * dirty set below mirrors that so the indicator survives a tab switch too.
 */
export function EditorPane({ tabs, path, changes, reveal, lsp, onSelect, onClose }: EditorPaneProps) {
  const [file, setFile] = useState<FileContents | null>(null);
  const [dirty, setDirty] = useState(false);
  const [staleOnDisk, setStaleOnDisk] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const appearance = useResolvedAppearance();

  const editorRef = useRef<MonacoNs.IStandaloneCodeEditor | null>(null);
  const fileRef = useRef<FileContents | null>(null);
  const dirtyPaths = useRef(new Set<WirePath>());
  /**
   * Scroll, cursor and folds per file: Monaco keeps the text but not where you were looking.
   * Keyed by model URI, because that is what the editor reports at the moment of a switch.
   */
  const viewStates = useRef(new Map<string, MonacoNs.ICodeEditorViewState>());
  /** The nonce of the reveal already carried out, so a re-render does not repeat it. */
  const appliedReveal = useRef<number | null>(null);
  // Set while we replace the text, so the change listener does not read it back as a user edit.
  const applying = useRef(false);

  useEffect(() => {
    fileRef.current = file;
  }, [file]);

  useEffect(() => {
    let cancelled = false;
    if (!path) {
      setFile(null);
      setStatus(null);
      publishCursor(null);
      return;
    }
    setStaleOnDisk(false);
    readFile(path)
      .then((contents) => {
        if (cancelled) return;
        setFile(contents);
        setDirty(dirtyPaths.current.has(path));
        setStatus(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setFile(null);
        setStatus(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  /**
   * A closed tab gives its model back. `keepCurrentModel` disposes nothing, so forty open files
   * would mean forty tokenised buffers unless this runs. The dirty flag goes with it.
   */
  const openTabs = useRef<readonly WirePath[]>(tabs);
  useEffect(() => {
    for (const gone of openTabs.current) {
      if (tabs.includes(gone)) continue;
      const uri = toFileUri(gone);
      monaco.editor.getModel(monaco.Uri.parse(uri))?.dispose();
      viewStates.current.delete(uri);
      dirtyPaths.current.delete(gone);
    }
    openTabs.current = tabs;
  }, [tabs]);

  // The keybinding captures its handler once, so the LSP handle goes through a ref.
  const lspRef = useRef(lsp);
  useEffect(() => {
    lspRef.current = lsp;
  }, [lsp]);

  const save = useCallback(async () => {
    const current = fileRef.current;
    const editor = editorRef.current;
    if (!current || !editor) return;
    try {
      const text = editor.getValue();
      const stat = await writeFile(current.path, text, current.hadBom);
      dirtyPaths.current.delete(current.path);
      // After the write: a server rerunning `cargo check` needs disk to match what it was told.
      lspRef.current.didSave(current.path, text);
      setFile({ ...current, text, size: stat.size, modifiedMs: stat.modifiedMs });
      setDirty(false);
      setStaleOnDisk(false);
      setStatus(`Saved ${baseName(current.path)}`);
    } catch (err) {
      setStatus(errorMessage(err));
    }
  }, []);

  useFocusTarget("editor", () => editorRef.current?.focus());

  useFocusTarget("editor", () => editorRef.current?.focus());

  // `addCommand` captures its handler once, so route it through a ref.
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveRef.current();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const reloadFromDisk = useCallback(async () => {
    const current = fileRef.current;
    const editor = editorRef.current;
    if (!current || !editor) return;
    try {
      const next = await readFile(current.path);
      if (editor.getValue() === next.text) {
        // Almost always our own save coming back through the watcher.
        setFile(next);
        setStaleOnDisk(false);
        return;
      }
      if (dirtyPaths.current.has(current.path)) {
        setStaleOnDisk(true);
        return;
      }
      applying.current = true;
      // A full replace drops the undo stack -- honest, for an edit this editor did not make.
      editor.setValue(next.text);
      applying.current = false;
      setFile(next);
      setStaleOnDisk(false);
      setStatus(`Reloaded ${baseName(next.path)} from disk`);
    } catch (err) {
      setStatus(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    const current = fileRef.current;
    if (!current) return;
    if (!changes.some((change) => change.path === current.path)) return;
    void reloadFromDisk();
  }, [changes, reloadFromDisk]);

  function onMount(instance: MonacoNs.IStandaloneCodeEditor) {
    editorRef.current = instance;
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveRef.current();
    });
    // The status bar reads the caret from a store. The listener lives on the editor, so it is
    // disposed with it and survives a file switch, which swaps the model under this instance.
    const position = instance.getPosition();
    publishCursor(position ? { line: position.lineNumber, column: position.column } : null);

    /**
     * View state must be captured before the model swaps, and `onDidChangeModel` fires too late
     * -- so record it as you move. Throttled at 150ms, far below the time to switch a tab.
     */
    let lastSaved = 0;
    const remember = () => {
      const uri = instance.getModel()?.uri.toString();
      if (!uri) return;
      const now = performance.now();
      if (now - lastSaved < 150) return;
      lastSaved = now;
      const state = instance.saveViewState();
      if (state) viewStates.current.set(uri, state);
    };

    instance.onDidChangeCursorPosition((event) => {
      publishCursor({ line: event.position.lineNumber, column: event.position.column });
      remember();
    });
    instance.onDidScrollChange(remember);
    // The throttle above may have skipped the last position before a switch.
    instance.onDidBlurEditorText(() => {
      lastSaved = 0;
      remember();
    });

    instance.onDidChangeModel(() => {
      const uri = instance.getModel()?.uri.toString();
      if (!uri) return;
      lastSaved = 0;
      const state = viewStates.current.get(uri);
      // A file opened for the first time has none, and Monaco's top-of-file default is right.
      if (state) instance.restoreViewState(state);
    });
  }

  useEffect(() => {
    const editor = editorRef.current;
    // Wait for the load: a reveal arriving with the jump is for the file that jump opens.
    if (!reveal || !editor || !file || file.path !== reveal.path) return;
    /**
     * Once per nonce. This effect also runs on `file`, so without the guard returning to a tab
     * would replay its last jump and overwrite the view state a frame after restoring it.
     */
    if (appliedReveal.current === reveal.nonce) return;
    appliedReveal.current = reveal.nonce;
    const position = { lineNumber: reveal.line ?? 1, column: reveal.column ?? 1 };
    if (reveal.endLine) {
      const model = editor.getModel();
      editor.setSelection({
        startLineNumber: position.lineNumber,
        startColumn: position.column,
        endLineNumber: reveal.endLine,
        // No end column means "to the end of that line" -- what selecting lines means to people.
        endColumn: reveal.endColumn ?? (model?.getLineMaxColumn(reveal.endLine) ?? 1),
      });
    } else {
      editor.setPosition(position);
    }
    editor.revealPositionInCenter(position);
    editor.focus();
  }, [reveal, file]);

  /**
   * Which file is on screen and which buffers are unsaved -- the `ide_*` tools need both. The
   * dirty set is copied: publishing the ref hands out something that mutates under the reader.
   */
  useEffect(() => {
    publishEditorFacts({
      activePath: file?.path ?? null,
      dirty: new Set(dirtyPaths.current),
    });
  }, [file, dirty, staleOnDisk]);

  function onChange() {
    const current = fileRef.current;
    if (!current || applying.current) return;
    dirtyPaths.current.add(current.path);
    setDirty(true);
  }

  const dir = file ? parentOf(file.path) : null;

  return (
    <div className="pane editor">
      <div className="pane-header editor-tabs">
        {tabs.length === 0 ? (
          <span className="legend">Listing</span>
        ) : (
          <div className="tab-strip" role="tablist" aria-label="Open files">
            {tabs.map((open) => {
              const isActive = open === path;
              // The dirty set covers every open file; `dirty` state only tracks the one on screen.
              const isDirty = dirtyPaths.current.has(open);
              return (
                <span key={open} className={`tab${isActive ? " is-on" : ""}`}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className="tab-name"
                    title={open}
                    onClick={() => onSelect(open)}
                    // Middle click closes, the way it does in every editor and browser.
                    onAuxClick={(event) => {
                      if (event.button === 1) {
                        event.preventDefault();
                        onClose(open);
                      }
                    }}
                  >
                    {baseName(open)}
                    {isDirty && <span className="dirty-dot" title="Unsaved changes" />}
                  </button>
                  <button
                    type="button"
                    className="tab-close"
                    title={`Close ${baseName(open)}`}
                    aria-label={`Close ${baseName(open)}`}
                    onClick={() => onClose(open)}
                  >
                    ✕
                  </button>
                </span>
              );
            })}
          </div>
        )}
        {staleOnDisk && (
          <button
            type="button"
            className="ghost-button is-warn"
            onClick={() => void reloadFromDisk()}
          >
            <IconReload />
            Reload
          </button>
        )}
        {file && (
          <button
            type="button"
            className="ghost-button"
            disabled={!dirty}
            onClick={() => void save()}
          >
            Save
          </button>
        )}
      </div>
      <div className="pane-body is-flush">
        {/* Keyed on the path, so opening a file remounts it and replays the animation. */}
        {file && <span className="gutter-sync" key={file.path} aria-hidden="true" />}
        {file ? (
          <MonacoEditor
            path={toFileUri(file.path)}
            defaultValue={file.text}
            /**
             * Without this the wrapper disposes the outgoing model on every tab switch, taking
             * the view state and the unsaved edits with it. Closing a tab disposes it instead.
             */
            keepCurrentModel
            theme={themeFor(appearance)}
            options={EDITOR_OPTIONS}
            onMount={onMount}
            onChange={onChange}
            loading={<p className="note">mapping listing…</p>}
          />
        ) : (
          <p className="note">{status ?? "no file selected — pick one from the tree"}</p>
        )}
      </div>
      {/* The editor's footer, not the window's status bar: this file, and what happened to it. */}
      <div className="editor-footer">
        {file && (
          <>
            <span className="status-path" title={file.path}>
              <span className="status-dir">{dir ? `${dir}/` : ""}</span>
              <span className="status-name">{baseName(file.path)}</span>
            </span>
            <span className="measure">{formatSize(file.size, false)}</span>
          </>
        )}
        {status && (
          <span className={`status-message${staleOnDisk ? " is-error" : ""}`}>{status}</span>
        )}
      </div>
    </div>
  );
}
