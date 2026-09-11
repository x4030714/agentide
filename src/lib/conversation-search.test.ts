import { describe, expect, it } from "vitest";

import { searchConversations } from "./conversation-search";

const item = (id: string, title: string | null, opening: string | null = null) => ({
  id,
  title,
  opening,
});

const LIST = [
  item("1", "Edit random .txt file"),
  item("2", "Text file random lines"),
  item("3", "Kaneki Ken Discussion"),
  item("4", null, "make a file on my desktop"),
  item("5", null, null),
];

describe("finding a conversation by name", () => {
  it("leaves the list alone when nothing is typed", () => {
    // Newest first is the order it arrives in. Ranking an empty query by score would
    // reshuffle the list into something arbitrary the moment the box was focused.
    expect(searchConversations(LIST, "")).toBe(LIST);
    expect(searchConversations(LIST, "   ")).toBe(LIST);
  });

  it("matches a subsequence, the way Quick Open does", () => {
    const found = searchConversations(LIST, "edit rnd");
    expect(found[0]?.id).toBe("1");
  });

  it("drops what does not match at all", () => {
    expect(searchConversations(LIST, "kaneki").map((c) => c.id)).toEqual(["3"]);
    expect(searchConversations(LIST, "zzzz")).toEqual([]);
  });

  it("searches the opening line when there is no title", () => {
    // An untitled conversation is still findable by what was said first, which is what the
    // list shows for it anyway.
    expect(searchConversations(LIST, "desktop").map((c) => c.id)).toEqual(["4"]);
  });

  it("falls back to the id rather than matching nothing", () => {
    expect(searchConversations(LIST, "5").map((c) => c.id)).toEqual(["5"]);
  });

  it("ignores case in both directions", () => {
    expect(searchConversations(LIST, "KANEKI").map((c) => c.id)).toEqual(["3"]);
  });

  it("ranks the closer name first when both match", () => {
    // Both contain the letters of "text file"; the one that spells it out should win.
    const found = searchConversations(LIST, "text file");
    expect(found[0]?.id).toBe("2");
  });
});
