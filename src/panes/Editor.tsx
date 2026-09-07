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
 * A place to put the cursor, from outside the editor -- go to definition, or a jump from
 * a diagnostic. The nonce distinguishes two requests for the same spot, which otherwise
 * look identical to an effect and so happen only once.
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
 * The text editor. Owns loading, dirty state and saving for the active file.
 *
 * Monaco keeps one model per path, so switching files preserves unsaved edits; the
 * dirty set below mirrors that so the indicator survives a switch too.
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
   * Where you were in each file: scroll position, cursor, folded regions.
   *
   * Monaco keeps the *text* per model on its own, so switching tabs never loses an edit.
   * It does not keep where you were looking, and coming back to a file at line 1 when you
   * left it at line 800 is most of what makes tabs feel broken. Keyed by model URI rather
   * than by path, because that is what the editor reports at the moment of a switch.
   */
  const viewStates = useRef(new Map<string, MonacoNs.ICodeEditorViewState>());
  /** The nonce of the reveal already carried out, so a re-render does not repeat it. */
  const appliedReveal = useRef<number | null>(null);
  // Set while we replace the text ourselves, so the change listener does not read it
  // back as an edit by the user.
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
   * A closed tab gives its model back.
   *
   * `keepCurrentModel` means nothing is disposed on a switch, which is what makes tabs
   * work -- and it also means nothing is ever disposed at all unless someone does it here.
   * A session that opens forty files would otherwise hold forty tokenised buffers for the
   * rest of the day, on a machine that is already short of memory.
   *
   * The dirty flag goes with it: closing a file discards its unsaved edits, and leaving
   * the path in `dirtyPaths` would mark a dot on it if it were opened again.
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

  // `save` is bound to a keybinding that captures its handler once, so the LSP handle
  // goes through a ref rather than into the dependency list.
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
      // After the write, not before: a server that reruns `cargo check` on this needs the
      // file on disk to be the file it is told about.
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
      // A full replace drops the undo stack, which is the honest outcome for an edit
      // that did not come from this editor.
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
    // The status bar reads the caret from a store, not from a prop. The listener lives
    // on the editor, so it is disposed with it -- and it survives a file switch, which
    // swaps the model under this same instance rather than mounting a new one.
    const position = instance.getPosition();
    publishCursor(position ? { line: position.lineNumber, column: position.column } : null);

    /**
     * Remember where you are, throttled.
     *
     * The view state has to be captured *before* the model is swapped, and the swap gives
     * no warning -- `onDidChangeModel` fires once the new model is already in. So it is
     * recorded as you move instead. Throttled because scrolling fires continuously and
     * this allocates; 150ms is far below the time it takes to switch a tab, so what gets
     * restored is where you were, not where you were a moment before.
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
    // The last position before a switch is the one worth keeping, and the throttle above
    // may have skipped it.
    instance.onDidBlurEditorText(() => {
      lastSaved = 0;
      remember();
    });

    instance.onDidChangeModel(() => {
      const uri = instance.getModel()?.uri.toString();
      if (!uri) return;
      lastSaved = 0;
      const state = viewStates.current.get(uri);
      // A file opened for the first time has none, and Monaco's own default -- the top of
      // the file -- is the right answer there.
      if (state) instance.restoreViewState(state);
    });
  }

  useEffect(() => {
    const editor = editorRef.current;
    // The file has to have finished loading: a reveal that arrives with the jump is for
    // the file being opened by that same jump.
    if (!reveal || !editor || !file || file.path !== reveal.path) return;
    /**
     * Once per request, and the nonce is what says which request.
     *
     * This effect also runs when `file` changes, which now includes coming back to a tab.
     * Without this guard, returning to a file you once jumped into would replay that jump
     * instead of leaving you where you actually were -- the last reveal into a file would
     * become a permanent landing spot, and the saved view state would be overwritten a
     * frame after it was restored.
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
        // No end column given means "to the end of that line", which is what selecting a
        // range of lines means to everyone who is not counting columns.
        endColumn: reveal.endColumn ?? (model?.getLineMaxColumn(reveal.endLine) ?? 1),
      });
    } else {
      editor.setPosition(position);
    }
    editor.revealPositionInCenter(position);
    editor.focus();
  }, [reveal, file]);

  /**
   * Two facts the `ide_*` tools need and only this pane holds: which file is on screen,
   * and which buffers have unsaved edits. `dirtyPaths` is a ref, so it is copied here --
   * publishing the ref itself would hand out a set that mutates underneath the reader.
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
              // The dirty set is the editor's own, and it is right for every open file --
              // `dirty` state only tracks the one on screen.
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
        {/**
         * Keyed on the path, so opening a file remounts it and replays the animation:
         * the address column acknowledging the file the tree row just selected.
         */}
        {file && <span className="gutter-sync" key={file.path} aria-hidden="true" />}
        {file ? (
          <MonacoEditor
            path={toFileUri(file.path)}
            defaultValue={file.text}
            /**
             * Without this the wrapper disposes the outgoing model on every path change,
             * and a tab switch is a path change. That took the view state with it -- so
             * every file reopened at line 1 -- and the unsaved edits too, which is the
             * thing the header comment above has always claimed survives a switch and,
             * until tabs made it easy to notice, did not.
             *
             * The models it keeps are disposed when their tab closes; see `tabs` below.
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
      {/* The editor's own footer, not the window's status bar: it says what this file is
          and what just happened to it. The branch, the servers and the caret are in the
          bar at the bottom of the window. */}
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
