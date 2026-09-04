import MonacoEditor from "@monaco-editor/react";
import type { editor as MonacoNs } from "monaco-editor";
import { useCallback, useEffect, useRef, useState } from "react";

import { readFile, writeFile } from "../lib/bridge";
import { formatSize } from "../lib/format";
import { IconReload } from "../lib/icons";
import { useResolvedAppearance } from "../lib/appearance";
import { monaco, themeFor } from "../lib/monaco-setup";
import { publishEditorFacts } from "../lib/ide-host";
import type { Lsp, ServerRow } from "../lib/useLsp";
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
  path: WirePath | null;
  /** Latest batch from the workspace watcher; a new array per batch. */
  changes: FsEvent[];
  reveal: RevealTarget | null;
  lsp: Lsp;
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
export function EditorPane({ path, changes, reveal, lsp }: EditorPaneProps) {
  const [file, setFile] = useState<FileContents | null>(null);
  const [dirty, setDirty] = useState(false);
  const [staleOnDisk, setStaleOnDisk] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const appearance = useResolvedAppearance();

  const editorRef = useRef<MonacoNs.IStandaloneCodeEditor | null>(null);
  const fileRef = useRef<FileContents | null>(null);
  const dirtyPaths = useRef(new Set<WirePath>());
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
  }

  useEffect(() => {
    const editor = editorRef.current;
    // The file has to have finished loading: a reveal that arrives with the jump is for
    // the file being opened by that same jump.
    if (!reveal || !editor || !file || file.path !== reveal.path) return;
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
      <div className="pane-header">
        {file ? (
          <span className="filename">
            {baseName(file.path)}
            {dirty && <span className="dirty-dot" title="Unsaved changes" />}
          </span>
        ) : (
          <span className="legend">Listing</span>
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
      <div className="status-bar">
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
        <ServerStatus servers={lsp.servers} />
      </div>
    </div>
  );
}

/**
 * What the language servers are doing, in the corner where a status goes.
 *
 * `indexing` is the state this exists for. A server that is running but cannot answer yet
 * is the normal condition for the first minutes on a native codebase, and the alternative
 * to saying so is an editor that appears to have no completions and no explanation.
 */
function ServerStatus({ servers }: { servers: ServerRow[] }) {
  if (servers.length === 0) return null;
  return (
    <span className="lsp-status">
      {servers.map(({ spec, state }) => (
        <span
          key={spec.id}
          className={`lsp-server is-${state.status}`}
          title={state.error ?? state.detail ?? `${spec.id}: ${state.status}`}
        >
          <span className="lsp-dot" aria-hidden="true" />
          {spec.id}
          {state.status === "indexing" && (
            <span className="lsp-detail">{state.detail ?? "indexing"}</span>
          )}
          {(state.status === "failed" || state.status === "exited") && (
            <span className="lsp-detail">{state.status}</span>
          )}
        </span>
      ))}
    </span>
  );
}
