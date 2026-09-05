/**
 * Ranking for the quick-open palette.
 *
 * Its own module so it can be tested without mounting React: this is the part with
 * judgement in it, and the part that decides whether the palette feels sharp or vague.
 */

/**
 * Subsequence match, scored so the obvious answer wins.
 *
 * Typing `apptsx` should find `src/App.tsx`, and typing `app` should put `src/App.tsx`
 * above `src/app/helpers.ts`. Three things earn points, in the order a person relies on
 * them: matching in the file's own name rather than in a directory, matching consecutive
 * characters, and matching at the start of a word. An empty query matches everything, so
 * the palette opens showing the project rather than showing nothing.
 *
 * Returns 0 for no match. Both arguments are expected lower-cased by the caller, which
 * does it once per keystroke rather than once per file.
 */
export function score(haystack: string, needle: string): number {
  if (!needle) return 1;

  const slash = haystack.lastIndexOf("/");
  let total = 0;
  let at = 0;
  let previous = -2;

  for (const character of needle) {
    const found = haystack.indexOf(character, at);
    if (found < 0) return 0;

    let points = 1;
    if (found === previous + 1) points += 4;
    const before = found === 0 ? "/" : haystack[found - 1];
    if (before === "/" || before === "-" || before === "_" || before === ".") points += 3;
    if (found > slash) points += 2;

    total += points;
    previous = found;
    at = found + 1;
  }

  // A short path that matched is a better answer than a long one that matched as well.
  return total * 100 - haystack.length;
}

/** Exported for tests; see the note on `score`. */
export const __testing = { score };
