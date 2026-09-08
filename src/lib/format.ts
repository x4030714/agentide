/** Display formatting for the listing's measurement columns. */

/** Byte counts for the tree's size column: four characters at most, so the column keeps
 * a fixed width without padding. Directories get an em dash — they have no length. */
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

/** "3 hours ago". Coarse on purpose: the only question a conversation list answers about
 * time is which one you were just in. */
export function ago(atMs: number | null): string {
  if (!atMs) return "unknown";
  const seconds = Math.max(0, (Date.now() - atMs) / 1000);
  // Each divisor is the size of the unit held now, paired with the unit it produces.
  const steps: Array<[number, string]> = [
    [60, "minute"],
    [60, "hour"],
    [24, "day"],
    [7, "week"],
    [4.35, "month"],
    [12, "year"],
  ];
  let value = seconds;
  let unit = "second";
  for (const [size, name] of steps) {
    if (value < size) break;
    value /= size;
    unit = name;
  }
  const whole = Math.floor(value);
  if (unit === "second" && whole < 30) return "just now";
  return `${whole} ${unit}${whole === 1 ? "" : "s"} ago`;
}
