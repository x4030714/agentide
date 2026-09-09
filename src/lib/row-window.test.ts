import { describe, expect, it } from "vitest";

import { offsetToReveal, rowWindow } from "./row-window";

/** The file tree draws only the rows in view. Pins what gets rendered, and where the list must
 * move to show a row selected from somewhere else. */
describe("windowing a fixed-height list", () => {
  // 24px rows in a 240px pane -- ten rows visible, the tree's real geometry.
  const visible = (offset: number, total: number, overscan = 0) =>
    rowWindow(offset, 240, 24, total, overscan);

  it("renders only the rows the viewport can show", () => {
    expect(visible(0, 10000)).toEqual({ start: 0, end: 10 });
  });

  it("moves the slice down with the scroll", () => {
    expect(visible(24 * 100, 10000)).toEqual({ start: 100, end: 110 });
  });

  it("keeps a row that is only half scrolled past", () => {
    // Scrolled by half a row: rows 0 through 10 are all at least partly on screen.
    expect(visible(12, 10000)).toEqual({ start: 0, end: 11 });
  });

  it("draws beyond both edges so a fast scroll finds rows already there", () => {
    expect(rowWindow(24 * 100, 240, 24, 10000, 6)).toEqual({ start: 94, end: 116 });
  });

  it("does not run past the end of the list", () => {
    expect(visible(24 * 95, 100, 6)).toEqual({ start: 89, end: 100 });
  });

  it("does not run before the start of the list", () => {
    expect(visible(0, 100, 6)).toEqual({ start: 0, end: 16 });
  });

  it("treats a negative scroll offset as the top", () => {
    // Rubber-band scrolling hands back offsets above zero on the way out of a bounce.
    expect(visible(-80, 10000)).toEqual({ start: 0, end: 10 });
  });

  it("renders nothing for an empty listing", () => {
    expect(visible(0, 0)).toEqual({ start: 0, end: 0 });
  });

  it("renders the whole list before anything has been measured", () => {
    // A pane whose height is not known yet shows too much rather than nothing.
    expect(rowWindow(0, 0, 24, 40)).toEqual({ start: 0, end: 40 });
    expect(rowWindow(0, 240, 0, 40)).toEqual({ start: 0, end: 40 });
  });

  it("covers the last partly visible row when the row height is fractional", () => {
    // A zoomed webview gives rows a fractional height; rounding down loses the bottom row.
    expect(rowWindow(0, 100, 24.5, 40, 0)).toEqual({ start: 0, end: 5 });
  });
});

describe("scrolling a selected row into view", () => {
  const reveal = (offset: number, index: number) => offsetToReveal(offset, 240, 24, index);

  it("leaves the list alone when the row is already on screen", () => {
    expect(reveal(0, 0)).toBeNull();
    expect(reveal(0, 9)).toBeNull();
    expect(reveal(24 * 100, 105)).toBeNull();
  });

  it("brings a row above the fold to the top", () => {
    expect(reveal(24 * 100, 40)).toBe(24 * 40);
  });

  it("brings a row below the fold to the bottom", () => {
    // Row 10 is the first one fully off the bottom of a ten-row viewport.
    expect(reveal(0, 10)).toBe(24 * 11 - 240);
  });

  it("reaches a row thousands of entries down, which was never rendered", () => {
    // The whole point: the position is arithmetic, so nothing has to exist to scroll to it.
    expect(reveal(0, 8000)).toBe(24 * 8001 - 240);
  });

  it("does nothing when nothing is selected", () => {
    expect(reveal(0, -1)).toBeNull();
  });

  it("puts the row at the top when the viewport has not been measured", () => {
    expect(offsetToReveal(0, 0, 24, 12)).toBe(24 * 12);
  });
});
