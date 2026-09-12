import { describe, expect, it } from "vitest";

import { groupByFile, latest } from "./workspace-search";
import type { SearchMatch } from "./protocol";

const hit = (path: string, line: number): SearchMatch => ({
  path,
  line,
  column: 1,
  endColumn: 7,
  before: "",
  matched: "needle",
  after: "",
});

describe("grouping search results by file", () => {
  it("puts a file where its first match was and keeps the order inside it", () => {
    // Interleaved on purpose: a group belongs where the file first appeared, not where its
    // last match did, or the list would reorder itself as more results arrived.
    const groups = groupByFile(
      [hit("C:/w/a.rs", 4), hit("C:/w/b.rs", 1), hit("C:/w/a.rs", 9)],
      "C:/w",
    );

    expect(groups.map((group) => group.relative)).toEqual(["a.rs", "b.rs"]);
    expect(groups[0].matches.map((match) => match.line)).toEqual([4, 9]);
    expect(groups[1].matches).toHaveLength(1);
  });

  it("strips the root only when the path is actually under it", () => {
    const groups = groupByFile([hit("C:/w/src/main.rs", 1), hit("C:/elsewhere/x.rs", 1)], "C:/w");
    expect(groups[0].relative).toBe("src/main.rs");
    expect(groups[1].relative).toBe("C:/elsewhere/x.rs");
  });

  it("leaves the path whole when there is no root to strip", () => {
    expect(groupByFile([hit("C:/w/a.rs", 1)], "")[0].relative).toBe("C:/w/a.rs");
  });

  it("does not strip a sibling folder that merely starts with the root's name", () => {
    // `C:/work` is not inside `C:/w`; matching on the separator is what tells them apart.
    expect(groupByFile([hit("C:/work/a.rs", 1)], "C:/w")[0].relative).toBe("C:/work/a.rs");
  });

  it("finds nothing to group in an empty answer", () => {
    expect(groupByFile([], "C:/w")).toEqual([]);
  });
});

describe("discarding a stale answer", () => {
  it("reports the older request as no longer current once a newer one has started", () => {
    const stamps = latest();
    const older = stamps.next();
    expect(stamps.isCurrent(older)).toBe(true);

    const newer = stamps.next();
    // The older request's answer may still be in flight; it must not paint over the newer.
    expect(stamps.isCurrent(older)).toBe(false);
    expect(stamps.isCurrent(newer)).toBe(true);
  });

  it("keeps its own count, so two panes cannot cancel each other", () => {
    const one = latest();
    const two = latest();
    one.next();
    expect(two.isCurrent(one.next())).toBe(false);
  });
});
