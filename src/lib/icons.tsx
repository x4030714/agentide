/**
 * Drawn icons. One family, one stroke weight (1.5 at a 12px box), `currentColor`
 * everywhere so an icon inherits whichever ink role its row is using.
 *
 * Deliberately sparse: the listing carries meaning in colour and column, not in a
 * file-type glyph beside every row.
 */

interface IconProps {
  /** Box size in px. Stroke stays visually constant because the viewBox scales with it. */
  size?: number;
  className?: string;
}

/** Directory disclosure. Points right when closed, down when open. */
export function IconChevron({ open, size = 12, className }: IconProps & { open: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={{
        transform: open ? "rotate(90deg)" : "none",
        transition: "transform 100ms cubic-bezier(0.2, 0, 0, 1)",
      }}
    >
      <path d="M4.5 2.5L8 6l-3.5 3.5" />
    </svg>
  );
}

/** Reload from disk. */
export function IconReload({ size = 12, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M10 6a4 4 0 1 1-1.2-2.85" />
      <path d="M10.2 1.5v2.6H7.6" />
    </svg>
  );
}

/** Open a folder. */
export function IconFolder({ size = 12, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M1.25 9.25v-6.5h3l1.25 1.5h5.25v5a.75.75 0 0 1-.75.75H2a.75.75 0 0 1-.75-.75Z" />
    </svg>
  );
}
