import type { CSSProperties, ReactNode } from "react";

import { IconBranch, IconChat, IconChip, IconEdit, IconFiles, IconSettings } from "../lib/icons";

/**
 * The icon rail: which view the sidebar shows, plus settings. These are indexes into the
 * workspace, not editor content, so they are not tabs. `rail-*` because `.activity` is taken.
 */

/** Which view the sidebar is showing. The rail is the only thing that sets it. */
export type SidebarView = "explorer" | "changes" | "git" | "conversations" | "models";

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
  // Below Conversations, and last: this is the one you open to set something up rather
  // than one you work in, so it sits at the end of the views rather than among them.
  { id: "models", label: "Local models", icon: <IconChip /> },
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
       * One marker for the whole rail, not one per button, so it slides between views. Stays
       * mounted while the sidebar is away, so reopening resumes rather than starting over.
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
