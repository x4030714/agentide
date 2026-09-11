import { useEffect, useState } from "react";

/**
 * Which shape the window takes.
 *
 * `workbench` is the IDE: rail, tree, transcript, editor, terminal, all on screen at once.
 * It is what this app is for, and it assumes you are reading code while the agent works.
 *
 * `basic` is the conversation on its own -- past conversations down one side, one centred
 * column in the middle, nothing else. The agent still edits files; you simply are not
 * watching it happen. For the times the work *is* the conversation, where five panes of
 * chrome around a chat box is the wrong instrument.
 *
 * Two layouts rather than a dozen toggles: a pane you can hide individually leaves you
 * assembling a layout every time you change task. These are two answers to "what am I doing
 * right now", and switching is one click.
 */
export type Layout = "workbench" | "basic";

const KEY = "agentide.layout";

export function storedLayout(): Layout {
  try {
    return localStorage.getItem(KEY) === "basic" ? "basic" : "workbench";
  } catch {
    return "workbench";
  }
}

/**
 * The layout, applied and remembered.
 *
 * `data-layout` on the root because the two shapes differ in more than which components
 * mount -- the composer is wider, the transcript is centred and capped, the chrome is
 * quieter -- and none of that belongs in a prop threaded through six components.
 */
export function useLayout(): [Layout, (next: Layout) => void] {
  const [layout, setLayout] = useState<Layout>(storedLayout);

  useEffect(() => {
    const root = document.documentElement;
    // Workbench is the default and is spelled as the absence of the attribute, so every
    // rule written before this existed still applies without a `:not()`.
    if (layout === "basic") root.dataset.layout = "basic";
    else root.removeAttribute("data-layout");
    try {
      if (layout === "basic") localStorage.setItem(KEY, "basic");
      else localStorage.removeItem(KEY);
    } catch {
      /* A context that refuses storage still gets the choice for this session. */
    }
  }, [layout]);

  return [layout, setLayout];
}
