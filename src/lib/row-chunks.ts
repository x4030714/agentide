/** How much of a long transcript is worth rendering. Chunked from the tail rather than
 * windowed by pixel, because a transcript row has no fixed height -- a text row and an
 * expanded diff differ by two orders of magnitude, so `row-window.ts` cannot measure it. */

/** Rows rendered before any scrolling. Roughly two screens on a tall pane. */
export const CHUNK = 80;

export interface Chunk {
  /** First row index to render. Everything before it is real but not drawn. */
  start: number;
  /** How many rows are held back, for the affordance that offers them. */
  hidden: number;
}

/**
 * Which slice of `total` rows to draw when `shown` are wanted.
 *
 * From the tail, because that is where the conversation is: the newest rows are the ones
 * being read, and a transcript that opened at the top of a thousand rows would be showing
 * the least interesting end of itself.
 */
export function chunk(total: number, shown: number): Chunk {
  const start = Math.max(0, total - Math.max(0, shown));
  return { start, hidden: start };
}

/** How many to want after asking for more. Capped, so `shown` cannot run away from `total`. */
export function grow(shown: number, total: number, by: number = CHUNK): number {
  return Math.min(total, Math.max(0, shown) + Math.max(1, by));
}

/**
 * Whether a scroll position is close enough to the top to load more.
 *
 * Generous, and deliberately not zero: rows load by growing the list upward, so waiting for
 * a true top means the reader hits the end of the content before anything arrives. A
 * threshold of roughly one screen keeps the next chunk in place before it is reached.
 */
export function nearTop(scrollTop: number, viewport: number): boolean {
  return scrollTop <= Math.max(200, viewport);
}

/**
 * Where to put the scroll after growing, so the rows under the reader do not move.
 *
 * Prepending content pushes everything down by exactly the height it added; without this
 * correction the transcript jumps backwards every time it loads, which reads as the list
 * scrolling itself.
 */
export function keepPlace(scrollTop: number, before: number, after: number): number {
  return Math.max(0, scrollTop + (after - before));
}
