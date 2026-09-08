/** Past conversations for `/resume`, the small half of `conversations.rs` for a CLI with no Rust
 * core. Only each file's head is read -- they reach 40 MB -- and a record's `cwd` confirms the dir. */

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

/** The SDK's mangling scheme, not ours, mirrored from `mangle` in `conversations.rs`. A change
 * here has to be made there too. */
export function mangle(path: string): string {
  return path.replace(/[\\/:.]/g, "-");
}

/** Where this workspace's transcripts would be, if it has any. */
export function transcriptDir(cwd: string, home = homedir()): string {
  return join(home, ".claude", "projects", mangle(cwd));
}

/** The opening prompt and the workspace, from the first records. Stops at the first user message
 * with text in it: a head holding no prompt is a session opened and abandoned. */
async function head(file: string): Promise<{ opening: string; cwd: string } | null> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let cwd = "";
  let seen = 0;
  try {
    for await (const line of lines) {
      if (seen++ >= HEAD_RECORDS) break;
      // Cheap rejection before the parse: most records are tool output and file snapshots.
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
      // Local-command output arrives as a `user` message wrapped in `<local-command-caveat>`.
      // Labelling a row with one shows boilerplate where the question should be, so keep scanning.
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

/** This workspace's conversations, most recently written first. Empty rather than throwing: a
 * workspace nobody has talked in is the ordinary first run, not a failure. */
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
    // Where the mangled-name guess is confirmed, against the real paths rather than their mangled
    // forms -- those agree precisely when two paths collide, which is the case this catches.
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

/** Whether two spellings are the same directory. Windows hands back `C:\a\b`, `c:/a/b` and
 * trailing-separator forms of one folder, and the SDK records whichever it was given. */
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
