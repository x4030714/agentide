/** Display formatting for the listing's measurement columns. */

/**
 * Byte counts for the tree's size column, in the shape a segment listing uses:
 * at most four characters, so the column stays a fixed width without padding.
 *
 * Directories get an em dash rather than 0 — they have no length of their own.
 */
export function formatSize(bytes: number, isDir: boolean): string {
  if (isDir) return "—";
  if (bytes < 1024) return String(bytes);
  const units = ["K", "M", "G"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // 9.9K but 10K — three significant characters, never five.
  return value < 10
    ? `${value.toFixed(1)}${units[unit]}`
    : `${Math.round(value)}${units[unit]}`;
}
