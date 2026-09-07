/**
 * The gap between writing `providers.json` and the sidecar reading it.
 *
 * This exists because of a real report: "Use local model" wrote the entry, told the user to
 * pick the model from the Model menu, and the menu did not have it -- the sidecar had read
 * the file at startup, before the entry existed, and reads it again only at the start of a
 * turn. Every case here is about that window opening and closing correctly.
 */

import { beforeEach, describe, expect, test } from "vitest";

import {
  __testing,
  mergeProviders,
  publishPendingProvider,
  settleProviders,
} from "./pending-providers";
import type { ProviderInfo } from "./protocol";

beforeEach(() => {
  __testing.reset();
});

const entry = (key: string): ProviderInfo => ({
  key,
  models: [{ id: `${key}-model`, name: key, supportsEffort: false }],
  host: "127.0.0.1",
  port: 8080,
});

describe("merging", () => {
  test("nothing pending changes nothing", () => {
    const known = [entry("a")];
    expect(mergeProviders(known, [])).toBe(known);
  });

  test("a just-written provider shows up before the sidecar has read it", () => {
    // The whole point: the menu has to offer what the button just created.
    expect(mergeProviders([], [entry("qwen")]).map((p) => p.key)).toEqual(["qwen"]);
  });

  test("it does not appear twice once the sidecar reports it", () => {
    const merged = mergeProviders([entry("qwen")], [entry("qwen")]);
    expect(merged.map((p) => p.key)).toEqual(["qwen"]);
  });

  test("the sidecar's own row wins, because it read the file", () => {
    const real = { ...entry("qwen"), port: 9999 };
    expect(mergeProviders([real], [entry("qwen")])[0]?.port).toBe(9999);
  });

  test("pending entries come after the known ones", () => {
    // The menu is ordered, and a row that jumps to the top when it is written and back
    // down when it is read would move under the pointer.
    expect(mergeProviders([entry("a")], [entry("b")]).map((p) => p.key)).toEqual(["a", "b"]);
  });
});

describe("settling", () => {
  test("an entry the sidecar has read is no longer held", () => {
    publishPendingProvider(entry("qwen"));
    settleProviders([entry("qwen")]);
    expect(mergeProviders([], []).length).toBe(0);
    // And the merge no longer adds it back from the store.
    expect(mergeProviders([entry("qwen")], []).map((p) => p.key)).toEqual(["qwen"]);
  });

  test("one that has not arrived is still held", () => {
    publishPendingProvider(entry("qwen"));
    settleProviders([entry("other")]);
    expect(mergeProviders([entry("other")], [entry("qwen")]).map((p) => p.key)).toEqual([
      "other",
      "qwen",
    ]);
  });
});

describe("publishing", () => {
  test("writing the same model twice does not list it twice", () => {
    // Pressing the button again after a paused download must not put a second row in the
    // menu. The dedupe is the store's, so the store is what this reads.
    publishPendingProvider(entry("qwen"));
    publishPendingProvider({ ...entry("qwen"), port: 8091 });
    expect(__testing.pending()).toHaveLength(1);
    expect(__testing.pending()[0]?.port).toBe(8091);
  });

  test("subscribers are told, so the picker re-renders without a restart", () => {
    // The component only re-renders if this fires. A store that held the right value and
    // announced nothing would look exactly like the bug this module fixes.
    let told = 0;
    const stop = __testing.subscribe(() => {
      told += 1;
    });
    publishPendingProvider(entry("qwen"));
    expect(told).toBe(1);

    // And again when one settles, so the row does not linger after the real list has it.
    settleProviders([entry("qwen")]);
    expect(told).toBe(2);
    stop();
  });

  test("settling nothing announces nothing", () => {
    let told = 0;
    const stop = __testing.subscribe(() => {
      told += 1;
    });
    settleProviders([entry("unrelated")]);
    expect(told).toBe(0);
    stop();
  });
});
