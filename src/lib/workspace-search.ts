/**
 * The two pieces of the search pane that are worth testing without a DOM: turning a flat list
 * of matches into the file groups the pane draws, and deciding which answer is still wanted.
 *
 * Both exist because search-as-you-type has no natural order. Rust returns matches sorted by
 * path, but nothing about that says where a group belongs on screen, and a request in flight
 * when the next keystroke lands must not be allowed to paint over the newer one.
 */

import type { SearchMatch, WirePath } from "./protocol";

/** One file's worth of matches, in the order they arrived. */
export interface FileGroup {
  path: WirePath;
  /** Workspace-relative, for the header. The absolute path is still in `path`. */
  relative: string;
  matches: SearchMatch[];
}

/**
 * Group `matches` by file, keeping arrival order: a group sits where its first match sat, and
 * matches keep their order within it.
 *
 * Order is preserved rather than re-sorted because the backend already decided it -- by path,
 * then line, then column. Sorting again here would be a second opinion about the same question,
 * and the two would disagree the first time one of them changed.
 */
export function groupByFile(matches: SearchMatch[], root: string): FileGroup[] {
  const prefix = root ? `${root.replace(/\/$/, "")}/` : "";
  const groups: FileGroup[] = [];
  const byPath = new Map<WirePath, FileGroup>();

  for (const match of matches) {
    let group = byPath.get(match.path);
    if (!group) {
      group = {
        path: match.path,
        // The same stripping Quick Open does, so one path reads the same in both places.
        relative: match.path.startsWith(prefix) ? match.path.slice(prefix.length) : match.path,
        matches: [],
      };
      byPath.set(match.path, group);
      groups.push(group);
    }
    group.matches.push(match);
  }
  return groups;
}

/**
 * Stamps for discarding an answer that arrived too late.
 *
 * A keystroke starts a search and does not cancel the one already running, because there is
 * nothing to cancel it with -- the walk is in Rust and the promise is already in flight. So
 * every request takes a stamp on the way out and asks on the way back whether it is still the
 * newest. The one that is not simply drops its answer instead of painting it, which is the
 * difference between results that lag and results that flicker backwards.
 */
export function latest(): { next: () => number; isCurrent: (stamp: number) => boolean } {
  let current = 0;
  return {
    next: () => ++current,
    isCurrent: (stamp: number) => stamp === current,
  };
}
