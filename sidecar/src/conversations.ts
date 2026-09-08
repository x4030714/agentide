/**
 * Past conversations, for `/resume` in the terminal.
 *
 * The desktop app gets this from the Rust core, which reads the same files far more
 * thoroughly -- titles, turn counts, branches, every project on the machine. The CLI does
 * not run the Rust core, so this is the small half of it: the transcripts for *this*
 * workspace, newest first, enough to recognise one and resume it.
 *
 * ## Only the head of each file
 *
 * `src-tauri/src/conversations.rs` reads whole transcripts because it reports turn counts
 * and the SDK's generated title, which is written at the end. Measured there: the five
 * largest transcripts on this machine are 44.7, 33.5, 29.6, 28.6 and 23.7 MB. A picker
 * that has to read 182 MB before it can draw a list is not a picker, so this reads the
 * first few records of each file and stops.
 *
 * What that costs is the title: it takes the opening prompt instead, which is what the app
 * falls back to anyway when the SDK never made one. What it buys is a list that is drawn in
 * the time between pressing enter and looking up.
 *
 * ## The directory name is a guess
 *
 * The SDK mangles the workspace path into a directory name by replacing every separator,
 * colon and dot with `-`. That is lossy -- two different paths can produce the same name --
 * so the guess is confirmed against a record's own `cwd` before its conversations are
 * offered. Resuming into someone else's transcript because two paths collided would be a
 * hard thing to notice and a worse thing to explain.
 */

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** Records read from the head of a transcript before giving up on it. */
const HEAD_RECORDS = 40;

/** Conversations offered at once. More than this and the list stops being scannable. */
export const RESUME_LIMIT = 12;

export interface PastConversation {
  /** The SDK's session id: the filename, and the handle `resume` takes. */
  id: string;
  /** The first thing the user said. The title, in the absence of one. */
  opening: string;
  /** Last write, epoch milliseconds. From the filesystem, not from the records. */
  updatedMs: number;
  bytes: number;
}

/**
 * `C:\Users\tung\Desktop\agentide` -> `C--Users-tung-Desktop-agentide`.
 *
 * The SDK's scheme, not ours, mirrored from `mangle` in `conversations.rs`. Any change
 * here has to be made there too, and the test pins the same path both files use.
 */
export function mangle(path: string): string {
  return path.replace(/[\\/:.]/g, "-");
}

/** Where this workspace's transcripts would be, if it has any. */
export function transcriptDir(cwd: string, home = homedir()): string {
  return join(home, ".claude", "projects", mangle(cwd));
}

/**
 * The opening prompt and the workspace, from the first records of a transcript.
 *
 * Stops at the first user message with text in it. A transcript whose head holds no
 * prompt is a session that was opened and abandoned, and there is nothing to resume in it.
 */
async function head(file: string): Promise<{ opening: string; cwd: string } | null> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let cwd = "";
  let seen = 0;
  try {
    for await (const line of lines) {
      if (seen++ >= HEAD_RECORDS) break;
      // Cheap rejection before the parse: most records are tool output and file snapshots,
      // and parsing one of those to learn it is not a prompt is the whole cost of this.
      if (!line.includes('"type":"user"') && !line.includes('"cwd"')) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!cwd && typeof record.cwd === "string") cwd = record.cwd;
      if (record.type !== "user") continue;
      const opening = messageText(record.message);
      // A record the harness wrote, not the person: local-command output arrives as a
      // `user` message wrapped in `<local-command-caveat>` and friends. Labelling a row
      // with one shows a paragraph of boilerplate where the question should be, so the
      // scan keeps going to the thing that was actually asked.
      if (opening && !/^<[a-z][a-z-]*>/i.test(opening)) return { opening, cwd };
    }
  } catch {
    // An unreadable transcript is one fewer row, not a failed command.
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
  return null;
}

/** The text of a `message.content`, which is either a string or a list of blocks. */
function messageText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => (block as { type?: string }).type === "text")
    .map((block) => String((block as { text?: string }).text ?? ""))
    .join(" ")
    .trim();
}

/**
 * This workspace's conversations, most recently written first.
 *
 * Empty rather than throwing when the directory is not there: a workspace nobody has had a
 * conversation in is the ordinary case on the first run, not a failure.
 */
export async function listConversations(
  cwd: string,
  limit = RESUME_LIMIT,
  home = homedir(),
): Promise<PastConversation[]> {
  const dir = transcriptDir(cwd, home);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }

  // Sorted by mtime before anything is opened, so only the newest few are ever read. The
  // rest of the directory costs one `stat` each and no parsing at all.
  const stamped = await Promise.all(
    names.map(async (name) => {
      try {
        const info = await stat(join(dir, name));
        return { name, updatedMs: info.mtimeMs, bytes: info.size };
      } catch {
        return null;
      }
    }),
  );
  const newest = stamped
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((left, right) => right.updatedMs - left.updatedMs)
    .slice(0, limit);

  const out: PastConversation[] = [];
  for (const entry of newest) {
    const found = await head(join(dir, entry.name));
    if (!found) continue;
    // The mangled name is a guess; this is where it is confirmed, against the real paths
    // rather than their mangled forms -- comparing the mangling to itself would agree
    // precisely when two different paths collided, which is the case it exists to catch.
    if (found.cwd && !samePath(found.cwd, cwd)) continue;
    out.push({
      id: entry.name.replace(/\.jsonl$/, ""),
      opening: found.opening.replace(/\s+/g, " ").slice(0, 160),
      updatedMs: entry.updatedMs,
      bytes: entry.bytes,
    });
  }
  return out;
}

/**
 * Whether two spellings are the same directory.
 *
 * Windows hands the same folder back as `C:\a\b`, `c:/a/b` and with a trailing separator,
 * and the SDK records whichever one it was given. Case-insensitive because this only ever
 * runs against paths on this machine, where it is.
 */
function samePath(left: string, right: string): boolean {
  const flat = (path: string) =>
    path.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  return flat(left) === flat(right);
}

/** "3 minutes ago", roughly. A timestamp is not what anyone is scanning this list for. */
export function ago(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : `${Math.round(days / 30)}mo ago`;
}
