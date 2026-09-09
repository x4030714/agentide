import { useEffect, useRef } from "react";

/** Every global keybinding in one table behind one listener — scattered `keydown` handlers
 * drift and collide. Bindings do not fire while typing unless they opt in. */

export interface Binding {
  /** Lower-case `event.key`, or a `Digit1`-style `event.code` for the number row. */
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** Fire even when a text field has focus. Only for chords a text field cannot mean itself:
   * Escape, or a Ctrl chord no editor binds. Never a bare letter. */
  whileTyping?: boolean;
  /** What it does, in the app's own words. Shown nowhere yet; the table is the reference. */
  describe: string;
  run: () => void;
}

/** Whether the event's target is somewhere the user is entering text. */
function isTyping(target: EventTarget | null): boolean {
  // Not every target is an element: with nothing focused the event targets the document. No
  // `closest` there, and the throw killed every binding, not just this check.
  if (!(target instanceof Element)) return false;
  const element = target as HTMLElement;
  const tag = element.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    element.isContentEditable ||
    // Monaco and xterm focus hidden textareas, covered above. This catches their wrappers, so a
    // click into the editor body then a bare key does not fire an app binding.
    element.closest(".monaco-editor, .xterm") !== null
  );
}

function matches(binding: Binding, event: KeyboardEvent): boolean {
  if (!!binding.ctrl !== (event.ctrlKey || event.metaKey)) return false;
  if (!!binding.shift !== event.shiftKey) return false;
  if (!!binding.alt !== event.altKey) return false;
  // The number row is matched by physical key, so it works on a layout where Shift or
  // AltGr changes what the digit prints.
  if (binding.key.startsWith("Digit")) return event.code === binding.key;
  return event.key.toLowerCase() === binding.key;
}

/** Install the app's bindings for as long as the component lives. The list is read from a ref,
 * so re-adding the listener each render cannot drop a keypress that arrived mid-render. */
export function useKeybindings(bindings: Binding[]): void {
  const current = useRef(bindings);
  useEffect(() => {
    current.current = bindings;
  }, [bindings]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // A held key repeating should not fire an action repeatedly; these all open, focus
      // or toggle something, and none of them means anything a second time.
      if (event.repeat) return;
      const typing = isTyping(event.target);
      for (const binding of current.current) {
        if (typing && !binding.whileTyping) continue;
        if (!matches(binding, event)) continue;
        event.preventDefault();
        binding.run();
        return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

/** How a binding reads to a person: `Ctrl+Shift+P`. */
export function describeChord(binding: Binding): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push("Ctrl");
  if (binding.shift) parts.push("Shift");
  if (binding.alt) parts.push("Alt");
  const key = binding.key.startsWith("Digit")
    ? binding.key.slice("Digit".length)
    : binding.key.length === 1
      ? binding.key.toUpperCase()
      : binding.key.replace(/^./, (c) => c.toUpperCase());
  parts.push(key);
  return parts.join("+");
}

// --- Focus -----------------------------------------------------------------------

/** Moving focus between panes, as a subscription rather than a prop threaded through every
 * component between the app and whatever finally calls `.focus()`. */
export type Pane = "tree" | "composer" | "editor" | "terminal";

const listeners = new Map<Pane, () => void>();

/** Ask a pane to take focus. Silent when nothing is listening -- the pane may be hidden. */
export function requestFocus(pane: Pane): void {
  listeners.get(pane)?.();
}

/** Answer focus requests for `pane` while mounted. One listener per pane, last mount wins: two
 * things claiming to be the editor is a bug, and the newer one is on screen. */
export function useFocusTarget(pane: Pane, focus: () => void): void {
  const current = useRef(focus);
  useEffect(() => {
    current.current = focus;
  }, [focus]);

  useEffect(() => {
    const handler = () => current.current();
    listeners.set(pane, handler);
    return () => {
      if (listeners.get(pane) === handler) listeners.delete(pane);
    };
  }, [pane]);
}
