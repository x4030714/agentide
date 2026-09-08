import { URI } from "monaco-editor/base/common/uri.js";
import { describe, expect, it } from "vitest";

import { uriToPath } from "./lsp-session";
import { toFileUri } from "./protocol";
import type { WirePath } from "./protocol";

/** The URI round trip against Monaco's real `URI`. A file's identity is spelled three ways
 * — ours, Monaco's, the server's — and a mismatch lands diagnostics on no model at all. */

const PATHS = [
  "C:/Users/tung/Desktop/agentide/src/main.rs",
  "C:/Users/tung/a b/c.rs",
  "C:/Users/tung/re#sume/100%/what?.rs",
  "C:/Users/tung/naïve/ünïcode.rs",
  "//server/share/project/src/lib.rs",
] as WirePath[];

describe("path <-> uri", () => {
  it("round-trips every path shape back to itself", () => {
    for (const path of PATHS) {
      expect(uriToPath(toFileUri(path))).toBe(path);
    }
  });

  it("survives Monaco's own normalisation", () => {
    // The leg that matters: the editor hands `toFileUri(path)` to `Uri.parse` and keys the
    // model on the result. Fail here and model lookup by path is broken.
    for (const path of PATHS) {
      const monacoUri = URI.parse(toFileUri(path));
      expect(uriToPath(monacoUri.toString())).toBe(path);
    }
  });

  it("finds the same model URI when asked twice", () => {
    // `getModel` keys on the string form, so the whole scheme rests on this being stable.
    for (const path of PATHS) {
      expect(URI.parse(toFileUri(path)).toString()).toBe(URI.parse(toFileUri(path)).toString());
    }
  });

  it("accepts the spellings a server sends back", () => {
    // rust-analyzer lowercases the drive and percent-encodes the colon; we send neither.
    // Landing on the same path anyway is the entire reason nothing compares URI strings.
    const want = "C:/Users/tung/src/main.rs" as WirePath;
    expect(uriToPath("file:///c%3A/Users/tung/src/main.rs")).toBe(want);
    expect(uriToPath("file:///c:/Users/tung/src/main.rs")).toBe(want);
    expect(uriToPath("file:///C:/Users/tung/src/main.rs")).toBe(want);
  });

  it("does not throw on a malformed percent escape", () => {
    // A path is better than an exception thrown inside a notification handler, which
    // would take the rest of the batch of diagnostics down with it.
    expect(() => uriToPath("file:///C:/a/100%zz/b.rs")).not.toThrow();
  });
});
