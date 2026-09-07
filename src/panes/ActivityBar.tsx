import type { CSSProperties, ReactNode } from "react";

import { IconBranch, IconChat, IconEdit, IconFiles, IconSettings } from "../lib/icons";

/**
 * The icon rail on the far left: which view the sidebar is showing, and the way to the
 * settings overlay.
 *
 * Four things that were tabs above the editor live here now. They were never editor
 * content -- a review queue and a repository panel are indexes into the workspace, the
 * same job the file tree does -- and tabbing them against the editor meant the file you
 * were editing disappeared to read a diff.
 *
 * The classes are `rail-*` rather than `activity-*` because `.activity` is already the
 * transcript's live status row, and two unrelated things under one prefix is how a
 * stylesheet becomes unreadable.
 */

/** Which view the sidebar is showing. The rail is the only thing that sets it. */
export type SidebarView = "explorer" | "changes" | "git" | "conversations";

interface ViewSpec {
  id: SidebarView;
  /** Names the view in the tooltip; the sidebar's own header names it on screen. */
  label: string;
  icon: ReactNode;
}

const VIEWS: ViewSpec[] = [
  { id: "explorer", label: "Explorer", icon: <IconFiles /> },
  { id: "changes", label: "Changes", icon: <IconEdit /> },
  { id: "git", label: "Repository", icon: <IconBranch /> },
  { id: "conversations", label: "Conversations", icon: <IconChat /> },
];

interface ActivityBarProps {
  view: SidebarView;
  /** The sidebar is put away. No icon is active while it is -- there is nothing to be active. */
  collapsed: boolean;
  /** Unreviewed edits from this turn, badged on Changes the way a tab count used to read. */
  changeCount: number;
  onSelect: (view: SidebarView) => void;
  onSettings: () => void;
}

export function ActivityBar({
  view,
  collapsed,
  changeCount,
  onSelect,
  onSettings,
}: ActivityBarProps) {
  return (
    <div className="rail">
      {/**
       * The selection bar, one for the rail rather than one per button, so it slides to
       * the view you chose instead of four bars cutting in and out. It is decoration in
       * the accessibility tree -- `aria-pressed` on the buttons already carries which
       * view is on -- and it stays mounted while the sidebar is away so that reopening
       * carries on from where it was rather than starting over at the top.
       */}
      <span
        className={`rail-marker${collapsed ? " is-off" : ""}`}
        style={{ "--rail-index": VIEWS.findIndex((spec) => spec.id === view) } as CSSProperties}
        aria-hidden="true"
      />
      {VIEWS.map((spec) => {
        const on = !collapsed && spec.id === view;
        return (
          <button
            key={spec.id}
            type="button"
            // Toggle buttons rather than tabs: pressing the one that is already on puts
            // the sidebar away, which is not something a tab does.
            aria-pressed={on}
            className={`rail-item${on ? " is-on" : ""}`}
            title={spec.label}
            aria-label={spec.label}
            onClick={() => onSelect(spec.id)}
          >
            {spec.icon}
            {spec.id === "changes" && changeCount > 0 && (
              <span className="rail-badge">{changeCount}</span>
            )}
          </button>
        );
      })}
      {/* At the foot of the rail, apart from the views, where every editor puts it. */}
      <button
        type="button"
        className="rail-item rail-settings"
        title="Settings"
        aria-label="Settings"
        onClick={onSettings}
      >
        <IconSettings size={17} />
      </button>
    </div>
  );
}
