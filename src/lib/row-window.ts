/** Which rows of a fixed-height list are worth rendering. Its own module so the arithmetic
 * can be tested without a DOM; an off-by-one shows up only on lists too long to debug. */

/** Rows kept beyond each edge so a fast scroll does not expose an unpainted band. */
const OVERSCAN = 6;

export interface RowWindow {
  /** First index to render. */
  start: number;
  /** One past the last index to render. */
  end: number;
}

/** The slice to render for a list scrolled to `offset` px inside a `viewport` px window.
 * `offset` excludes padding above row 0; an unmeasured viewport returns every row, never none. */
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

/** The offset that brings row `index` into view, or null if it is already there. Nearest
 * edge, and a visible row never moves — selecting one must not scroll it out from under you. */
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
