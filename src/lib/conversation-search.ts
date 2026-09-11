/**
 * Finding a conversation by name.
 *
 * The same subsequence scoring Quick Open uses, so typing `edit rnd` finds "Edit random .txt
 * file" in both places. One behaviour, learned once.
 *
 * Titles only, on purpose. Searching what was *said* means reading every transcript on disk
 * -- this workspace has one with 1,187 prompts -- and that is a different feature with a
 * different cost, answered by the agent's own Grep rather than by a filter box.
 */

import { score } from "./quickopen-score";

/** What the list needs from a conversation to rank it. */
export interface Searchable {
  id: string;
  title: string | null;
  opening: string | null;
}

/** The text a query is matched against: the title, or the first thing said when untitled. */
function nameOf(item: Searchable): string {
  return (item.title ?? item.opening ?? item.id).toLowerCase();
}

/**
 * The conversations matching `query`, best first.
 *
 * An empty query returns the list untouched -- *in its own order*, which is newest first.
 * Ranking an unfiltered list by score would reshuffle it into something arbitrary the moment
 * the box was focused and emptied again.
 */
export function searchConversations<T extends Searchable>(items: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;

  return items
    .map((item) => ({ item, points: score(nameOf(item), needle) }))
    .filter((entry) => entry.points > 0)
    // Stable within a score, so equally good matches stay in the order they arrived: a tie
    // broken arbitrarily makes the list jump while you are still typing.
    .sort((a, b) => b.points - a.points)
    .map((entry) => entry.item);
}
