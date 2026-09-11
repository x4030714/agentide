/** Turning what someone pasted or dropped into something the model can be given. */

import type { Attachment } from "./protocol";

/** What the Messages API accepts as an image. Anything else is a file. */
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

type ImageType = (typeof IMAGE_TYPES)[number];

function imageType(type: string): ImageType | null {
  return (IMAGE_TYPES as readonly string[]).includes(type) ? (type as ImageType) : null;
}

/**
 * The cap on one inlined image.
 *
 * Not a rule of the API's -- it is about the conversation. An image is base64 in the prompt
 * and stays there for every later turn, so a screenshot someone pastes without thinking is
 * paid for repeatedly. 4MB of PNG is a very large screenshot and about 5.3MB of base64.
 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Base64 without the `data:` prefix, which the API does not want. */
async function encode(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  // In chunks: `String.fromCharCode(...bytes)` on a megabyte overflows the argument limit,
  // which fails as a RangeError far from anything that looks like image handling.
  for (let at = 0; at < buffer.length; at += 8192) {
    binary += String.fromCharCode(...buffer.subarray(at, at + 8192));
  }
  return btoa(binary);
}

/** Why an attachment was refused, or null when it was not. */
export function refuse(file: { type: string; size: number }): string | null {
  if (!imageType(file.type)) return null;
  if (file.size > MAX_IMAGE_BYTES) {
    return `that image is ${Math.round(file.size / 1024 / 1024)}MB — the limit is ${MAX_IMAGE_BYTES / 1024 / 1024}MB`;
  }
  return null;
}

/**
 * One pasted or dropped item as an attachment.
 *
 * An image is read and inlined, because that is the only way a model sees one. Anything else
 * becomes its path, and the agent reads it with its own tools -- which costs one call rather
 * than the whole file in every turn that follows. A non-image with no path cannot be
 * attached at all, and says so rather than arriving empty.
 */
export async function toAttachment(
  file: File,
  pathOf: (file: File) => string | null,
): Promise<Attachment | { error: string }> {
  const type = imageType(file.type);
  if (type) {
    const refused = refuse(file);
    if (refused) return { error: refused };
    return { kind: "image", mediaType: type, data: await encode(file), ...(file.name ? { name: file.name } : {}) };
  }

  const path = pathOf(file);
  if (path) return { kind: "file", path };
  return {
    error: `${file.name || "that file"} has no path on disk, so it cannot be attached — save it first`,
  };
}

/** Whether a dropped path is something the model can look at, by its extension. A dropped
 * file has no MIME type -- the OS hands over a path and nothing else. */
export function imageTypeOf(path: string): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return null;
}

/**
 * A dropped path as an attachment.
 *
 * An image is read and inlined, because no tool hands a model something it can look at.
 * Everything else stays a path: the agent reads it with `Read` and the `ide_*` tools, which
 * costs one call rather than the whole file in every turn that follows.
 */
export async function fromPath(
  path: string,
  readBase64: (path: string, maxBytes: number) => Promise<string>,
): Promise<Attachment | { error: string }> {
  const mediaType = imageTypeOf(path);
  if (!mediaType) return { kind: "file", path };
  try {
    return {
      kind: "image",
      mediaType,
      data: await readBase64(path, MAX_IMAGE_BYTES),
      name: path.split(/[\\/]/).pop() ?? path,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** What a chip shows. An image pasted from the clipboard has no name of its own. */
export function attachmentLabel(attachment: Attachment): string {
  if (attachment.kind === "file") return attachment.path.split(/[\\/]/).pop() ?? attachment.path;
  return attachment.name ?? "pasted image";
}
