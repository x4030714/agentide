/** Ranking for the quick-open palette. Its own module so it can be tested without React. */

/** Subsequence match, scored so `app` ranks `src/App.tsx` over `src/app/helpers.ts`:
 * filename beats directory, runs and word starts beat scatter. Arguments arrive lower-cased. */
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
