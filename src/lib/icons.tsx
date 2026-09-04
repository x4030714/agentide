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

/**
 * Window controls. Drawn at a 10px box with a 1px stroke rather than the 1.5 the rest
 * of the family uses: these are hairline glyphs by convention on every platform, and a
 * heavier stroke reads as a toolbar button instead of window chrome.
 */
function WinGlyph({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconMinimize = () => (
  <WinGlyph>
    <path d="M0.5 5h9" />
  </WinGlyph>
);

export const IconMaximize = () => (
  <WinGlyph>
    <rect x="0.5" y="0.5" width="9" height="9" />
  </WinGlyph>
);

/** Two offset frames: the standard "restore down" mark. */
export const IconRestore = () => (
  <WinGlyph>
    <rect x="0.5" y="2.5" width="7" height="7" />
    <path d="M2.5 2.5v-2h7v7h-2" />
  </WinGlyph>
);

export const IconClose = () => (
  <WinGlyph>
    <path d="M0.7 0.7l8.6 8.6M9.3 0.7L0.7 9.3" />
  </WinGlyph>
);

/** Appearance. A sun and a moon share one box so the swap does not shift the row. */
export function IconTheme({ dark, size = 13 }: { dark: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {dark ? (
        <path d="M11.5 8.4A5 5 0 0 1 5.6 2.5a5 5 0 1 0 5.9 5.9Z" />
      ) : (
        <>
          <circle cx="7" cy="7" r="2.6" />
          <path d="M7 1v1.4M7 11.6V13M1 7h1.4M11.6 7H13M2.8 2.8l1 1M10.2 10.2l1 1M11.2 2.8l-1 1M3.8 10.2l-1 1" />
        </>
      )}
    </svg>
  );
}

/**
 * A mark per palette, drawn in the same family as everything else here.
 *
 * Each one names the palette's character rather than its colours: the colour is supplied
 * by `currentColor`, which the picker sets to that palette's own accent, so the row shows
 * both what the palette is called and what it looks like.
 */
export function IconPalette({ id, size = 14 }: { id: string; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 14 14",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  switch (id) {
    // A gauge: the measuring instrument the default palette is named for.
    case "quiet":
      return (
        <svg {...common}>
          <path d="M2 10a5 5 0 0 1 10 0" />
          <path d="M7 10 9.4 6.6" />
        </svg>
      );

    // A nut, seen face on. The workshop.
    case "ferrous":
      return (
        <svg {...common}>
          <path d="M7 1.8 11.6 4.4v5.2L7 12.2 2.4 9.6V4.4Z" />
          <circle cx="7" cy="7" r="1.9" />
        </svg>
      );

    // An aperture. The darkroom.
    case "halide":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="5.2" />
          <path d="M7 1.8 4.2 6.6M11.5 4.4 5.9 4.4M11.5 9.6 8.7 4.8M7 12.2 9.8 7.4M2.5 9.6 8.1 9.6M2.5 4.4 5.3 9.2" />
        </svg>
      );

    // A sheet with a turned corner. Paper.
    case "vellum":
      return (
        <svg {...common}>
          <path d="M3.2 1.9h5L11 4.7v7.4H3.2Z" />
          <path d="M8.1 1.9v2.9H11" />
        </svg>
      );

    default:
      return null;
  }
}
