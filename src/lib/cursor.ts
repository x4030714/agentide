import { useSyncExternalStore } from "react";

/**
 * Where the caret is, published by the editor and read by the status bar.
 *
 * A subscription rather than a prop, for the same reason `useFocusTarget` in keys.ts is
 * one: threading the position up to the app and back down would re-render every pane on
 * every arrow key. A cursor readout is the last thing that should cost a frame.
 */
export interface CursorPosition {
  /** 1-based, the way the editor, the transcript's links and every compiler count. */
  line: number;
  column: number;
}

let position: CursorPosition | null = null;
const listeners = new Set<() => void>();

/** Called by the editor on every cursor move, and with null when no file is open. */
export function publishCursor(next: CursorPosition | null): void {
  if (position?.line === next?.line && position?.column === next?.column) return;
  position = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Returns the held object rather than a fresh one: `useSyncExternalStore` compares
// snapshots by identity and re-renders forever if a new object comes back each time.
function snapshot(): CursorPosition | null {
  return position;
}

export function useCursor(): CursorPosition | null {
  return useSyncExternalStore(subscribe, snapshot);
}
