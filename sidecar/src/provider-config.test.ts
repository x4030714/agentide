/**
 * What `providers.json` is allowed to say, and what happens when it says something wrong.
 *
 * The refusals matter most. A provider that loads with a half-expanded token, or with no
 * port to check, produces a turn that fails against an endpoint nobody named -- Claude Code
 * does not fall back to the cloud when the base URL is dead, so a bad entry here is not a
 * degraded feature but a broken session.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  findProvider,
  loadProviders,
  providerEnv,
  publicProviders,
} from "./provider-config.ts";

/** A home with one `providers.json` in it. */
function homeWith(providers: unknown): string {
  const home = mkdtempSync(join(tmpdir(), "agentide-providers-"));
  mkdirSync(join(home, ".agentide"));
  writeFileSync(join(home, ".agentide", "providers.json"), JSON.stringify({ providers }, null, 2));
  return home;
}

/** The short form: a model file and a port. */
const LOCAL = { model: "D:/models/qwen3-coder-30b-q4_k_m.gguf", port: 8080 };

test("a model file and a port are a whole provider", () => {
  const [provider] = loadProviders(homeWith({ qwen: LOCAL }));
  assert.equal(provider?.key, "qwen");
  assert.equal(provider?.baseUrl, "http://127.0.0.1:8080");
  assert.equal(provider?.port, 8080);
});

test("the model is named after its file, quantisation and all", () => {
  // The suffix is the difference between two files of the same model, and the person
  // chose between them.
  const [provider] = loadProviders(homeWith({ qwen: LOCAL }));
  assert.deepEqual(provider?.models, [
    { id: "qwen3-coder-30b-q4_k_m", name: "qwen3-coder-30b-q4_k_m", supportsEffort: false },
  ]);
});

test("the start command begins with PowerShell's call operator", () => {
  // The terminal is PowerShell, where a quoted path in the first position is a string
  // expression rather than a command. Without `&` this does not fail to find the program --
  // it fails to parse, with `Unexpected token '-m'`. The model then never starts, and the
  // only symptom upstream is the port gate reporting that the backend did not come up,
  // which points at everything except the quoting.
  const [provider] = loadProviders(homeWith({ qwen: LOCAL }));
  assert.match(provider!.start!, /^& "/);
});

test("the start command runs the file through llama.cpp, bound to localhost", () => {
  // llama.cpp binds every interface by default, and a model server reachable from the
  // network is not what "run a model locally" asked for.
  const [provider] = loadProviders(homeWith({ qwen: LOCAL }));
  assert.match(provider!.start!, /llama-server/);
  assert.match(provider!.start!, /-m "D:\/models\/qwen3-coder-30b-q4_k_m\.gguf"/);
  assert.match(provider!.start!, /--port 8080/);
  assert.match(provider!.start!, /--host 127\.0\.0\.1/);
  assert.match(provider!.start!, /-c 65536/);
});

test("a path with spaces is quoted, because most model paths have them", () => {
  const [provider] = loadProviders(
    homeWith({ qwen: { model: "C:/My Models/qwen 3.gguf", port: 8080 } }),
  );
  assert.match(provider!.start!, /-m "C:\/My Models\/qwen 3\.gguf"/);
});

test("the engine and the context size can be said when the defaults are wrong", () => {
  const [provider] = loadProviders(
    homeWith({
      qwen: { ...LOCAL, engine: "C:/llama.cpp/llama-server.exe", contextLength: 32_768 },
    }),
  );
  assert.match(provider!.start!, /"C:\/llama\.cpp\/llama-server\.exe"/);
  assert.match(provider!.start!, /-c 32768/);
});

test("an explicit command wins over the model file", () => {
  // `start` is the escape hatch, and one that loses to the convenience it exists to
  // bypass is not an escape hatch.
  const [provider] = loadProviders(homeWith({ qwen: { ...LOCAL, start: "my-server --weird" } }));
  assert.equal(provider?.start, "my-server --weird");
});

test("a backend agentide does not launch has no start command", () => {
  const [provider] = loadProviders(
    homeWith({
      hosted: {
        baseUrl: "https://gateway.example",
        host: "gateway.example",
        port: 443,
        token: "sk-x",
        models: [{ id: "nemotron-4-340b", name: "Nemotron 340B" }],
      },
    }),
  );
  assert.equal(provider?.start, undefined);
  assert.equal(provider?.baseUrl, "https://gateway.example");
  assert.equal(provider?.host, "gateway.example");
});

test("a missing file is not a problem, it is the normal case", () => {
  assert.deepEqual(loadProviders(mkdtempSync(join(tmpdir(), "agentide-empty-"))), []);
});

test("a trailing slash is trimmed, since neither backend wants one", () => {
  // The CLI appends its own path; a double slash is a 404 that reads as the model being
  // wrong rather than the URL.
  const [provider] = loadProviders(
    homeWith({ lms: { baseUrl: "http://127.0.0.1:1234/", port: 1234, models: [{ id: "qwen" }] } }),
  );
  assert.equal(provider?.baseUrl, "http://127.0.0.1:1234");
});

test("effort is off unless a model claims it", () => {
  // Effort is an Anthropic concept. Offering the control for a model that ignores it is
  // the kind of silent no-op this project keeps paying for.
  const [provider] = loadProviders(homeWith({ qwen: LOCAL }));
  assert.equal(provider?.models[0]?.supportsEffort, false);
});

test("a token is expanded from the environment", () => {
  process.env.AGENTIDE_TEST_KEY = "sk-secret";
  try {
    const [provider] = loadProviders(homeWith({ hosted: { ...LOCAL, token: "${AGENTIDE_TEST_KEY}" } }));
    assert.equal(provider?.token, "sk-secret");
  } finally {
    delete process.env.AGENTIDE_TEST_KEY;
  }
});

test("a provider whose variable is not set is dropped, not half-expanded", () => {
  // Half-expanded is the dangerous outcome: the backend answers 401 and the person reads
  // that as a bad key rather than an unset variable.
  delete process.env.AGENTIDE_ABSENT_KEY;
  assert.deepEqual(loadProviders(homeWith({ hosted: { ...LOCAL, token: "${AGENTIDE_ABSENT_KEY}" } })), []);
});

test("a provider with no token still gets one", () => {
  // Sending none makes the CLI look for an Anthropic key instead, which fails in a way
  // that names neither the provider nor the missing field.
  const [provider] = loadProviders(homeWith({ qwen: LOCAL }));
  assert.equal(provider?.token, "agentide");
});

test("`disabled` switches one off without needing the rest to be valid", () => {
  assert.deepEqual(loadProviders(homeWith({ qwen: { disabled: true } })), []);
});

test("an entry with no port is refused", () => {
  // The gate is the only thing between a backend that is not running and a session where
  // every turn fails against an endpoint nobody named.
  assert.deepEqual(loadProviders(homeWith({ qwen: { model: "x.gguf" } })), []);
});

test("an entry naming neither a file nor a model list is refused", () => {
  assert.deepEqual(loadProviders(homeWith({ qwen: { port: 8080 } })), []);
});

test("an unknown field is refused rather than ignored", () => {
  // A typo that is silently dropped is a setting the person believes is in force.
  assert.deepEqual(loadProviders(homeWith({ qwen: { ...LOCAL, portt: 1 } })), []);
});

test("one bad provider does not take the good ones with it", () => {
  const loaded = loadProviders(homeWith({ broken: { port: 1 }, qwen: LOCAL }));
  assert.deepEqual(
    loaded.map((provider) => provider.key),
    ["qwen"],
  );
});

test("a file that is not JSON costs its providers and nothing else", () => {
  const home = mkdtempSync(join(tmpdir(), "agentide-bad-"));
  mkdirSync(join(home, ".agentide"));
  writeFileSync(join(home, ".agentide", "providers.json"), "{ not json");
  assert.deepEqual(loadProviders(home), []);
});

test("staying on the cloud is asking for no provider at all", () => {
  const providers = loadProviders(homeWith({ qwen: LOCAL }));
  assert.equal(findProvider(providers, undefined), null);
  assert.equal(findProvider(providers, "gone"), null);
  assert.equal(findProvider(providers, "qwen")?.key, "qwen");
});

test("the environment names only the two variables that redirect the CLI", () => {
  const [provider] = loadProviders(homeWith({ qwen: { ...LOCAL, token: "sk-local" } }));
  assert.deepEqual(providerEnv(provider!), {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:8080",
    ANTHROPIC_AUTH_TOKEN: "sk-local",
  });
});

test("detached is off, so a model server dies with the app unless asked otherwise", () => {
  const [provider] = loadProviders(homeWith({ qwen: LOCAL }));
  assert.equal(provider?.detached, false);
});

test("what the host is told carries no credential", () => {
  // The boundary is the point: a key that never crosses into the webview cannot be read
  // out of it.
  const providers = loadProviders(homeWith({ hosted: { ...LOCAL, token: "sk-do-not-leak" } }));
  const sent = JSON.stringify(publicProviders(providers));
  assert.ok(!sent.includes("sk-do-not-leak"), "the token reached the host");
  assert.ok(!sent.includes("baseUrl"), "the base URL reached the host");
  assert.ok(sent.includes("qwen3-coder-30b-q4_k_m"), "the models did not reach the host");
});
