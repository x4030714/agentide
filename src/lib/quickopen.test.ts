import { describe, expect, it } from "vitest";

import { __testing } from "./quickopen-score";

const { score } = __testing;

/** Ranking, pinned by the searches actually made in this project: the cases where a
 * naive subsequence match puts the wrong file on top. */
describe("quick open ranking", () => {
  const best = (query: string, paths: string[]) =>
    [...paths]
      .map((path) => ({ path, score: score(path.toLowerCase(), query.toLowerCase()) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || a.path.length - b.path.length)[0]?.path;

  it("prefers a match in the file name over one in a directory", () => {
    expect(best("app", ["src/app/helpers.ts", "src/App.tsx"])).toBe("src/App.tsx");
  });

  it("prefers consecutive characters over scattered ones", () => {
    expect(best("git", ["src/lib/agent-in-transit.ts", "src/panes/Git.tsx"])).toBe(
      "src/panes/Git.tsx",
    );
  });

  it("finds a file from name plus extension", () => {
    expect(best("apptsx", ["src/lib/protocol.ts", "src/App.tsx"])).toBe("src/App.tsx");
  });

  it("prefers the shorter path when both match equally", () => {
    expect(best("index", ["a/b/c/d/index.ts", "index.ts"])).toBe("index.ts");
  });

  it("rewards a match at a word boundary", () => {
    // `ls` should reach lsp-client before a file that merely contains l...s.
    expect(best("lsp", ["src/lib/tools-placeholder.ts", "src/lib/lsp-client.ts"])).toBe(
      "src/lib/lsp-client.ts",
    );
  });

  it("returns nothing for characters that are not there in order", () => {
    expect(score("src/app.tsx", "xyz")).toBe(0);
    // Right characters, wrong order.
    expect(score("src/app.tsx", "xsat")).toBe(0);
  });

  it("matches everything when nothing has been typed", () => {
    expect(score("anything/at/all.rs", "")).toBeGreaterThan(0);
  });
});
