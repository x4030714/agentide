import { describe, expect, it } from "vitest";

import { MAX_IMAGE_BYTES, attachmentLabel, fromPath, refuse, toAttachment } from "./attachments";

/** A `File` without a DOM: only `type`, `size`, `name` and `arrayBuffer` are read. */
function file(name: string, type: string, bytes: Uint8Array): File {
  return {
    name,
    type,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer,
  } as unknown as File;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("attaching an image", () => {
  it("inlines it, because that is the only way a model sees one", async () => {
    const result = await toAttachment(file("shot.png", "image/png", PNG), () => null);
    expect(result).toMatchObject({ kind: "image", mediaType: "image/png", name: "shot.png" });
    // Base64 of the PNG magic number, with no `data:` prefix — the API rejects one.
    expect((result as { data: string }).data).toBe("iVBORw0KGgo=");
  });

  it("encodes a large image without overflowing the argument limit", async () => {
    // `String.fromCharCode(...bytes)` on a megabyte throws a RangeError far from anything
    // that looks like image handling, so the encoder chunks. This is that case.
    const big = new Uint8Array(300_000).fill(0x41);
    const result = await toAttachment(file("big.png", "image/png", big), () => null);
    expect("error" in result).toBe(false);
    expect((result as { data: string }).data.length).toBeGreaterThan(390_000);
  });

  it("refuses one too large to carry through the rest of the conversation", () => {
    // It is not an API limit. An inlined image stays in the prompt for every later turn.
    expect(refuse({ type: "image/png", size: MAX_IMAGE_BYTES + 1 })).toMatch(/limit/);
    expect(refuse({ type: "image/png", size: 1024 })).toBeNull();
  });

  it("treats a format the API does not take as a file, not an image", async () => {
    // A BMP is an image to a person and not to the Messages API; inlining it would be
    // refused by the model rather than by us.
    const result = await toAttachment(file("old.bmp", "image/bmp", PNG), () => "C:/w/old.bmp");
    expect(result).toEqual({ kind: "file", path: "C:/w/old.bmp" });
  });
});

describe("attaching a file", () => {
  it("sends the path, not the contents", async () => {
    // The agent has Read and the `ide_*` tools. Inlining costs the whole file in this turn
    // and in every turn after it; a path costs one tool call.
    const result = await toAttachment(file("main.rs", "text/plain", PNG), () => "C:/w/main.rs");
    expect(result).toEqual({ kind: "file", path: "C:/w/main.rs" });
  });

  it("says so when there is no path to send", async () => {
    // A webview drop has no path. Better a reason than an attachment that resolves to
    // nothing on the other side.
    const result = await toAttachment(file("notes.txt", "text/plain", PNG), () => null);
    expect(result).toMatchObject({ error: expect.stringContaining("no path") });
  });
});

describe("what a chip says", () => {
  it("names a file by its last segment", () => {
    expect(attachmentLabel({ kind: "file", path: "C:/w/src/main.rs" })).toBe("main.rs");
  });

  it("names a pasted image, which has no name of its own", () => {
    expect(attachmentLabel({ kind: "image", mediaType: "image/png", data: "x" })).toBe(
      "pasted image",
    );
  });
});

describe("dropping a path", () => {
  const reader = async () => "ZHJvcHBlZA==";

  it("inlines an image, recognised by extension", async () => {
    // A dropped file arrives as a path and nothing else — the OS hands over no MIME type.
    const result = await fromPath("C:/w/shot.PNG", reader);
    expect(result).toEqual({
      kind: "image",
      mediaType: "image/png",
      data: "ZHJvcHBlZA==",
      name: "shot.PNG",
    });
  });

  it("leaves anything else as a path for the agent to read", async () => {
    expect(await fromPath("C:/w/src/main.rs", reader)).toEqual({
      kind: "file",
      path: "C:/w/src/main.rs",
    });
  });

  it("reports why an image could not be read rather than attaching nothing", async () => {
    const failing = async () => {
      throw new Error("shot.png is 9MB; the limit for an attached image is 4MB");
    };
    expect(await fromPath("C:/w/shot.png", failing)).toEqual({
      error: "shot.png is 9MB; the limit for an attached image is 4MB",
    });
  });
});
