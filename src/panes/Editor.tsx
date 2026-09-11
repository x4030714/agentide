import MonacoEditor from "@monaco-editor/react";
import { lineOf, locateHunks, type DiffHunk } from "../lib/diff";
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
/** An agent edit to show: the file, its hunks, and one nonce per edit so the same change
 * is not replayed every time this pane re-renders. */
export interface AgentEditTarget {
  path: WirePath;
  hunks: DiffHunk[];
  nonce: number;
}

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
  /** Recent agent changes, newest last. A queue because one instruction is several edits
   * and each is only fully drawable across two moments. */
  agentEdits: AgentEditTarget[];
  lsp: Lsp;
  onSelect: (path: WirePath) => void;
  onClose: (path: WirePath) => void;
}

const EDITOR_OPTIONS: MonacoNs.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  // Matches `--mono` in world.css. Monaco takes a string, so this is the one place the
  // stack is written twice.
  fontFamily: '"JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, monospace',
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
export function EditorPane({ tabs, path, changes, reveal, agentEdits, lsp, onSelect, onClose }: EditorPaneProps) {
  const [file, setFile] = useState<FileContents | null>(null);
  const [dirty, setDirty] = useState(false);
  const [staleOnDisk, setStaleOnDisk] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const appearance = useResolvedAppearance();

  const editorRef = useRef<MonacoNs.IStandaloneCodeEditor | null>(null);
  /** The edits whose removals are already recorded, and whose additions are. Two sets, not
   * two numbers: a turn's edits become drawable at different moments and out of order. */
  const appliedRemovals = useRef<Set<number>>(new Set());
  const appliedAdditions = useRef<Set<number>>(new Set());
  /** The decorations on screen. Redrawn whole each time, from `marked`. */
  const editRibbon = useRef<MonacoNs.IEditorDecorationsCollection | null>(null);
  /** Every line the agent has written in the open file, across all of this turn's edits. */
  const marked = useRef<Set<number>>(new Set());
  /** Which file `marked` is about, so switching files starts a fresh set. */
  const markedPath = useRef<string | null>(null);
  /** The view zones holding removed text, so they can be taken out again. */
  const delZones = useRef<string[]>([]);
  /** Where lines were removed, what they said, and what they were numbered before they
   * went. Kept because none of it is in the file any more: it can never be found again. */
  const removals = useRef<{ lines: string[]; first: number; after: number }[]>([]);
  const fileRef = useRef<FileContents | null>(null);
  /** The tab currently open, for a load to check it is still wanted when it lands. */
  const pathRef = useRef<WirePath | null>(null);
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

  pathRef.current = path;

  /** Read one file into the pane. Shared, so the first attempt and a later retry cannot
   * drift apart in what they set. */
  const loadFile = useCallback(async (target: WirePath): Promise<boolean> => {
    try {
      const contents = await readFile(target);
      // The tab may have moved on while this was in flight.
      if (pathRef.current !== target) return false;
      setFile(contents);
      setDirty(dirtyPaths.current.has(target));
      setStatus(null);
      return true;
    } catch (err) {
      if (pathRef.current !== target) return false;
      setFile(null);
      setStatus(errorMessage(err));
      return false;
    }
  }, []);

  useEffect(() => {
    if (!path) {
      setFile(null);
      setStatus(null);
      publishCursor(null);
      return;
    }
    setStaleOnDisk(false);
    void loadFile(path);
  }, [path, loadFile]);

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
    /**
     * Nothing loaded, but a tab is open on a path: the file was not there when the tab
     * opened, and the watcher has just seen it appear.
     *
     * This is the ordinary case for an agent edit, not an exotic one. The tab opens from the
     * `Write` *tool call*, which is drawn before the write reaches disk -- so the first read
     * fails with `os error 2`, `file` goes null, and the guard below used to return here
     * forever. The pane held "cannot stat" for the rest of the session while the file sat on
     * disk beside it.
     */
    if (!current) {
      if (!path || !changes.some((change) => change.path === path)) return;
      void loadFile(path);
      return;
    }
    if (!changes.some((change) => change.path === current.path)) return;
    void reloadFromDisk();
  }, [changes, path, loadFile, reloadFromDisk]);

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
   * Show the change the agent just made.
   *
   * Scrolls to it and marks the lines it wrote, so an edit is something you watch land
   * rather than something you go looking for afterwards.
   *
   * Placed by anchor, never by line number: the tool's input says what it wrote, not where
   * it ended up, and by the time this runs the file has been rewritten around it.
   *
   * Two things this got wrong first time round, both visible with one prompt.
   *
   * `locateHunks` renumbers a hunk it finds and leaves one it cannot *at its original
   * numbering, which starts at line 1*. Taking its answer without asking whether the anchor
   * was actually found meant an edit whose reload had not landed yet marked line 1 and
   * consumed the nonce, so the retry that was supposed to fix it never ran. Hence `lineOf`
   * here, where null is distinguishable, and an edit that locates nothing returns without
   * recording itself.
   *
   * And the marks accumulate. One instruction is routinely five `Edit` calls -- five
   * separate arrivals here -- so clearing the collection each time meant five edits could
   * only ever leave the last one lit.
   *
   * Never steals focus, unlike the reveal above: that one answers a jump you asked for, and
   * this one would interrupt whatever you were typing.
   */
  /**
   * Draw the lines an edit removed, in the place they were removed from.
   *
   * A removed line is not in the file any more, so there is no line to colour -- which is
   * why deletions were invisible while additions were not. A Monaco view zone is a block
   * inserted *between* two lines, so the old text can sit directly above whatever replaced
   * it and be read in place, the way a diff reads.
   *
   * Anchored to the first line the hunk added, so the pair reads old-then-new in file order.
   * A hunk that added nothing cannot be placed at all: its anchor is the empty string, which
   * matches nowhere, so a pure deletion is still not drawn here. That one needs the
   * checkpoint's diff rather than the tool's own input.
   */
  const drawRemovals = useCallback((editor: MonacoNs.IStandaloneCodeEditor) => {
    editor.changeViewZones((accessor) => {
      for (const id of delZones.current) accessor.removeZone(id);
      delZones.current = [];

      // Where Monaco's own line numbers end, so the removed block's can end there too.
      const layout = editor.getLayoutInfo();
      const numbersRight = layout.contentLeft - (layout.lineNumbersLeft + layout.lineNumbersWidth);

      for (const seam of removals.current) {
        const domNode = document.createElement("div");
        domNode.className = "agent-del-zone";
        for (const text of seam.lines) {
          const row = document.createElement("div");
          row.className = "agent-del-line";
          // `textContent`, never `innerHTML`: this is file content the model wrote, and it
          // is being put into the DOM.
          row.textContent = text;
          domNode.appendChild(row);
        }

        /**
         * The numbers these lines had before they went.
         *
         * A view zone is not a line, so Monaco has no number for it and the margin beside a
         * removed block was simply blank -- which reads as the file skipping a number rather
         * than as something having been taken out. These are the old file's numbering, which
         * is what a diff shows on a removed line, and they are the only place it still
         * exists once the write has landed.
         */
        const marginDomNode = document.createElement("div");
        marginDomNode.className = "agent-del-margin";
        marginDomNode.style.paddingRight = `${numbersRight}px`;
        for (let i = 0; i < seam.lines.length; i += 1) {
          const number = document.createElement("div");
          number.className = "agent-del-number";
          number.textContent = String(seam.first + i);
          marginDomNode.appendChild(number);
        }
        delZones.current.push(
          accessor.addZone({
            afterLineNumber: seam.after,
            heightInLines: seam.lines.length,
            domNode,
            marginDomNode,
          }),
        );
      }
    });
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !file) return;
    const model = editor.getModel();
    if (!model) return;

    if (markedPath.current !== file.path) {
      markedPath.current = file.path;
      marked.current = new Set();
      removals.current = [];
      appliedRemovals.current = new Set();
      appliedAdditions.current = new Set();
    }

    let drewRemoval = false;
    let firstAdded: number | null = null;

    for (const edit of agentEdits) {
      if (edit.path !== file.path) continue;
      // Re-read per edit: recording a removal does not change the buffer, but the reload
      // between two edits of the same turn does, and a stale copy would look for the new
      // text in the old file.
      const text = model.getValue();

      /**
       * The removed lines, placed against the buffer as it *still is*.
       *
       * A deletion leaves nothing behind to search for -- for a pure deletion the anchor is
       * the empty string, which matches nowhere. But a tool call is drawn before its write
       * reaches disk, so at this moment the text being removed is still in front of us. That
       * is the only moment it can be located, and it is why this runs before the reload
       * while the additions below run after it.
       *
       * A deletion above an earlier seam moves that seam up by the lines it took, so records
       * are shifted rather than re-searched: their text is gone from the file for good.
       */
      if (!appliedRemovals.current.has(edit.nonce)) {
        let placed = false;
        for (const hunk of edit.hunks) {
          const removed = hunk.lines.filter((line) => line.kind === "remove").map((l) => l.text);
          if (removed.length === 0) continue;
          const at = lineOf(text, removed.join("\n"));
          if (at === null) continue;
          for (const seam of removals.current) {
            if (seam.after >= at) seam.after -= removed.length;
          }
          removals.current.push({ lines: removed, first: at, after: at - 1 });
          placed = true;
        }
        // Recorded either way when there is nothing to remove, so a pure addition is not
        // reconsidered on every later render for the rest of the session.
        if (placed || !edit.hunks.some((hunk) => hunk.lines.some((l) => l.kind === "remove"))) {
          appliedRemovals.current.add(edit.nonce);
          drewRemoval ||= placed;
        }
      }

      // The added lines, placed once the write has landed in the buffer. Until the watcher's
      // reload arrives that is none of them, and the nonce stays unrecorded so a later pass
      // tries again -- which is the whole reason this is a queue and not one slot.
      if (!appliedAdditions.current.has(edit.nonce)) {
        const located = edit.hunks.filter((hunk) => lineOf(text, hunk.anchor) !== null);
        const added = locateHunks(located, text)
          .flatMap((hunk) => hunk.lines.filter((line) => line.kind === "add"))
          .map((line) => line.number);
        if (added.length > 0) {
          appliedAdditions.current.add(edit.nonce);
          for (const line of added) marked.current.add(line);
          if (firstAdded === null) firstAdded = added[0] as number;
        } else if (!edit.hunks.some((hunk) => hunk.lines.some((l) => l.kind === "add"))) {
          appliedAdditions.current.add(edit.nonce);
        }
      }
    }

    if (drewRemoval) drawRemovals(editor);
    if (marked.current.size > 0) {
      editRibbon.current?.clear();
      editRibbon.current = editor.createDecorationsCollection(
        [...marked.current].map((line) => ({
          range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
          options: {
            isWholeLine: true,
            className: "agent-edit-line",
            linesDecorationsClassName: "agent-edit-gutter",
          },
        })),
      );
    }

    // Follow the newest change, and only when one actually landed this pass -- otherwise
    // every unrelated re-render would drag the view back to the last edit.
    const target = firstAdded ?? (drewRemoval ? removals.current[removals.current.length - 1]?.after : null);
    if (target) editor.revealLineInCenterIfOutsideViewport(target);
  }, [agentEdits, file, drawRemovals]);

  /**
   * Redraw the removal zones whenever this pane re-renders with some recorded.
   *
   * They used to be built only when a new edit arrived, which made them invisible to every
   * change in how they are drawn: the module hot-reloads, the zone on screen stays the one
   * the old code made, and the next edit is the earliest anything new can appear. That cost
   * an evening of fixing things that were already fixed.
   *
   * It is not only a development concern -- a zone also has to survive the editor being
   * re-laid out -- but that is what it was hiding.
   */
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || removals.current.length === 0) return;
    drawRemovals(editor);
  }, [file, drawRemovals]);

  // The marks describe one file's recent edits. Opening something else must not leave a
  // ribbon behind on a line nothing touched.
  useEffect(() => {
    return () => {
      editRibbon.current?.clear();
      marked.current = new Set();
      markedPath.current = null;
      removals.current = [];
      const editor = editorRef.current;
      if (delZones.current.length > 0 && editor) {
        editor.changeViewZones((accessor) => {
          for (const id of delZones.current) accessor.removeZone(id);
          delZones.current = [];
        });
      }
    };
  }, [file?.path]);

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
