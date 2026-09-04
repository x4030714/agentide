import { URI } from "monaco-editor/base/common/uri.js";
import { describe, expect, it } from "vitest";

import { uriToPath } from "./lsp-session";
import { toFileUri } from "./protocol";
import type { WirePath } from "./protocol";

/**
 * The URI round trip, tested against Monaco's real `URI` rather than against a comment.
 *
 * A file's identity is spelled three ways at once: `toFileUri` builds one, Monaco stores
 * a normalised one on the model (`@monaco-editor/react` passes our string through
 * `Uri.parse`), and the language server echoes back a third. Any two of those disagreeing
 * means a diagnostic lands on no model, and the symptom — "diagnostics never appear" —
 * looks nothing like the cause. These tests pin all three to the same file.
 */

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
    // This is the leg that actually matters: the editor hands `toFileUri(path)` to
    // `Uri.parse`, and the model is keyed on whatever comes out. If we cannot get back to
    // the same path from that, model lookup by path is broken.
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
