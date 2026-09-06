/**
 * Which rows of a fixed-height list are worth rendering, and where to scroll to show one.
 *
 * Its own module so the arithmetic can be tested without a DOM. The tree is the one pane
 * whose row count is set by the user's disk rather than by us -- opening a home directory
 * is thousands of rows -- and an off-by-one here is invisible until the list is long
 * enough to matter, which is exactly when it is hardest to debug.
 */

/** Rows kept beyond each edge so a fast scroll does not expose an unpainted band. */
const OVERSCAN = 6;

export interface RowWindow {
  /** First index to render. */
  start: number;
  /** One past the last index to render. */
  end: number;
}

/**
 * The slice to render for a list scrolled to `offset` px inside a `viewport` px window.
 *
 * `offset` is measured from the top of the list, not from the top of the scroll
 * container: the caller subtracts whatever padding sits above the first row, because a
 * container that pads its content would otherwise place every row that much out.
 *
 * A viewport or a row height of zero means nothing has been measured yet, and that
 * returns the whole list rather than an empty one. Too many rows costs one frame; none
 * is a pane that looks broken, and it is the failure a person would report as "the tree
 * is empty" rather than as "the tree is slow".
 */
export function rowWindow(
  offset: number,
  viewport: number,
  rowHeight: number,
  total: number,
  overscan: number = OVERSCAN,
): RowWindow {
  if (total <= 0) return { start: 0, end: 0 };
  if (!(rowHeight > 0) || !(viewport > 0)) return { start: 0, end: total };

  const top = Math.max(0, offset);
  const first = Math.floor(top / rowHeight);
  // `ceil` rather than `floor`, so a row showing one pixel at the bottom edge is drawn.
  const last = Math.ceil((top + viewport) / rowHeight);

  return {
    start: Math.max(0, first - overscan),
    end: Math.min(total, last + overscan),
  };
}

/**
 * The offset that brings row `index` into view, or null if it is already there.
 *
 * Nearest edge, the way a source list behaves: a row above the fold comes to the top, one
 * below it comes to the bottom, and one already visible does not move at all -- selecting
 * a row that is on screen must never scroll the list out from under the pointer.
 */
export function offsetToReveal(
  offset: number,
  viewport: number,
  rowHeight: number,
  index: number,
): number | null {
  if (index < 0 || !(rowHeight > 0)) return null;

  const top = index * rowHeight;
  // With no measured viewport there is no "already visible" to test against. Putting the
  // row at the top is the answer that is still right once the measurement arrives.
  if (!(viewport > 0)) return top;

  if (top < offset) return top;
  const bottom = top + rowHeight;
  if (bottom > offset + viewport) return bottom - viewport;
  return null;
}
