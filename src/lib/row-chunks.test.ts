import { describe, expect, it } from "vitest";

import { CHUNK, chunk, grow, keepPlace, nearTop } from "./row-chunks";

describe("how much of a long transcript is drawn", () => {
  it("draws the tail, because that is where the conversation is", () => {
    // Opening at the top of a thousand rows shows the least interesting end of itself.
    const { start, hidden } = chunk(1000, CHUNK);
    expect(start).toBe(1000 - CHUNK);
    expect(hidden).toBe(1000 - CHUNK);
  });

  it("draws everything when there is less than a chunk", () => {
    expect(chunk(12, CHUNK)).toEqual({ start: 0, hidden: 0 });
  });

  it("draws nothing extra for an empty transcript", () => {
    expect(chunk(0, CHUNK)).toEqual({ start: 0, hidden: 0 });
  });

  it("never asks for a negative slice", () => {
    // A guard rather than an assumption: `shown` is state, and state gets reset.
    expect(chunk(50, -10).start).toBe(50);
    expect(chunk(50, 0)).toEqual({ start: 50, hidden: 50 });
  });
});

describe("loading more", () => {
  it("adds a chunk at a time", () => {
    expect(grow(CHUNK, 1000)).toBe(CHUNK * 2);
  });

  it("stops at the total, so shown cannot run away from the list", () => {
    expect(grow(90, 100)).toBe(100);
    expect(grow(100, 100)).toBe(100);
  });

  it("always makes progress, even asked for nothing", () => {
    // A growth of zero would leave the reader at the top of a list that never loads.
    expect(grow(10, 1000, 0)).toBeGreaterThan(10);
  });
});

describe("when to load", () => {
  it("fires before the reader reaches the top", () => {
    // Rows load by growing upward, so waiting for a true top means running out of content
    // first. One screen of warning keeps the next chunk in place before it is needed.
    expect(nearTop(300, 600)).toBe(true);
    expect(nearTop(0, 600)).toBe(true);
  });

  it("does not fire in the middle of a long transcript", () => {
    expect(nearTop(5000, 600)).toBe(false);
  });

  it("still fires on a tiny pane, where one screen is almost nothing", () => {
    expect(nearTop(150, 40)).toBe(true);
  });
});

describe("keeping the reader's place", () => {
  it("moves the scroll by exactly what was prepended", () => {
    // Without this the transcript jumps backwards every time it loads, which reads as the
    // list scrolling itself.
    expect(keepPlace(100, 1000, 1800)).toBe(900);
  });

  it("does not go negative when the list somehow shrank", () => {
    expect(keepPlace(100, 1000, 200)).toBe(0);
  });

  it("leaves the scroll alone when nothing was added", () => {
    expect(keepPlace(420, 1000, 1000)).toBe(420);
  });
});
