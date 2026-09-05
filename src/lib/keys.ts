import { useEffect, useRef } from "react";

/**
 * Every global keybinding in the app, in one table and behind one listener.
 *
 * PRODUCT.md puts keyboard reach above discoverability, which only pays off if the keys
 * are worth learning -- and they are only worth learning if they are consistent. Scattered
 * `keydown` handlers drift: two panes claim the same chord, one forgets to check whether
 * a text field has focus, and a binding stops working in a way nobody can locate. So there
 * is one listener, and adding a binding means adding a row here.
 *
 * Bindings deliberately do *not* fire while typing, unless they say otherwise. A shortcut
 * that swallows a keystroke in the middle of a commit message is worse than no shortcut.
 */

export interface Binding {
  /** Lower-case `event.key`, or a `Digit1`-style `event.code` for the number row. */
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  /**
   * Fire even when a text field has focus.
   *
   * Only for chords a text field cannot mean itself -- Escape to interrupt a turn, or a
   * Ctrl chord no editor binds. Never for a bare letter.
   */
  whileTyping?: boolean;
  /** What it does, in the app's own words. Shown nowhere yet; the table is the reference. */
  describe: string;
  run: () => void;
}

/** Whether the event's target is somewhere the user is entering text. */
function isTyping(target: EventTarget | null): boolean {
  // Not every target is an element: with nothing focused the event targets the document,
  // and a dispatched one can target the window. Neither has `closest`, and calling it
  // threw inside the handler -- which killed every binding, not just this check.
  if (!(target instanceof Element)) return false;
  const element = target as HTMLElement;
  const tag = element.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    element.isContentEditable ||
    // Monaco puts focus on a hidden textarea, and xterm on its own helper textarea; both
    // are covered above. This catches the wrappers, so a click into the editor body and
    // then a bare key does not trigger a binding meant for the app.
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

/**
 * Install the app's bindings for as long as the component lives.
 *
 * The list is read from a ref, so a binding closing over fresh state does not tear down
 * and re-add the listener on every render -- which would drop a keypress that arrived
 * mid-render.
 */
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

/**
 * Moving focus between panes, as a subscription rather than a prop.
 *
 * The alternative is threading a "focus this" value from the app through every component
 * between it and the thing that actually calls `.focus()`. That works and it is a chore,
 * and every new pane pays it again. A pane declaring what it answers to is the shorter
 * description of the same behaviour.
 */
export type Pane = "tree" | "composer" | "editor" | "terminal";

const listeners = new Map<Pane, () => void>();

/** Ask a pane to take focus. Silent when nothing is listening -- the pane may be hidden. */
export function requestFocus(pane: Pane): void {
  listeners.get(pane)?.();
}

/**
 * Answer focus requests for `pane` while mounted.
 *
 * One listener per pane, last mount wins: two things claiming to be the editor is a bug,
 * and the newer one is the one on screen.
 */
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
