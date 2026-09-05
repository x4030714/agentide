/**
 * The external MCP config: what reaches the SDK, and what a bad file costs.
 *
 * Real files in a temporary tree rather than a stubbed `fs`. The whole module is about
 * reading two files off disk and surviving what is in them, so a fake filesystem would
 * only prove the fake behaves.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { loadMcpServers } from "./mcp-config.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * A home and a workspace, each with an `.agentide/mcp.json` when text is given.
 *
 * `null` means the file is absent, which is the normal case for at least one of the two
 * on any real machine.
 */
function tree(user: string | null, project: string | null): { home: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), "agentide-mcp-"));
  roots.push(root);
  const home = join(root, "home");
  const cwd = join(root, "work");
  for (const [dir, text] of [
    [home, user],
    [cwd, project],
  ] as const) {
    mkdirSync(join(dir, ".agentide"), { recursive: true });
    if (text !== null) writeFileSync(join(dir, ".agentide", "mcp.json"), text, "utf8");
  }
  return { home, cwd };
}

/** One config file's JSON, so the cases below read as the entries they are about. */
function config(servers: Record<string, unknown>): string {
  return JSON.stringify({ mcpServers: servers });
}

/**
 * Run with stderr collected instead of printed.
 *
 * The warnings are the point of several of these cases -- a skipped entry that says
 * nothing is the failure mode this module exists to avoid -- and letting them through
 * would also bury the test runner's own output.
 */
async function capture<T>(body: () => Promise<T>): Promise<{ value: T; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    // Awaited inside the try, not outside: the loader is async now, and restoring
    // stderr before it settles would let every warning these cases assert on escape.
    return { value: await body(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

test("a server the workspace also names is the workspace's, not the user's", async () => {
  const { home, cwd } = tree(
    config({ ida: { command: "python", args: ["user.py"] }, blender: { command: "uvx" } }),
    config({ ida: { command: "python", args: ["project.py"] } }),
  );

  assert.deepEqual(await loadMcpServers(cwd, home), {
    ida: { command: "python", args: ["project.py"] },
    blender: { command: "uvx" },
  });
});

test("a user-level server applies in a workspace that has no config at all", async () => {
  const { home, cwd } = tree(config({ blender: { command: "uvx", args: ["blender-mcp"] } }), null);

  assert.deepEqual(await loadMcpServers(cwd, home), {
    blender: { command: "uvx", args: ["blender-mcp"] },
  });
});

test("no config files anywhere is silent, not an error", async () => {
  const { home, cwd } = tree(null, null);
  const { value, stderr } = await capture(() => loadMcpServers(cwd, home));

  assert.deepEqual(value, {});
  assert.equal(stderr, "");
});

test("a disabled entry is dropped rather than passed with a flag", async () => {
  const { home, cwd } = tree(
    config({
      figma: { type: "http", url: "http://127.0.0.1:3845/mcp", disabled: true },
      playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest"], disabled: false },
    }),
    null,
  );

  assert.deepEqual(await loadMcpServers(cwd, home), {
    playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
  });
});

test("a disabled entry in the workspace overrides an enabled one from the user file", async () => {
  // Written the way a person would write it: the transport lives in the user's file, and
  // this one says only that this workspace does not want it. An earlier version of this
  // test repeated `command` here, which is what let the bug through -- validating the
  // entry before reading `disabled` rejected the natural spelling as a config missing its
  // command, warned about a typo nobody made, and left the server running.
  const { home, cwd } = tree(
    config({ blender: { command: "uvx", args: ["blender-mcp"] } }),
    config({ blender: { disabled: true } }),
  );

  const { value, stderr } = await capture(() => loadMcpServers(cwd, home));
  assert.deepEqual(value, {});
  assert.equal(stderr, "", "turning a server off is not a mistake worth warning about");
});

test("a disabled entry that repeats its transport is still just off", async () => {
  // The verbose spelling has to keep working: it is what someone gets by copying the
  // entry and adding a flag, and it is what the file this ships with looks like.
  const { home, cwd } = tree(
    config({ blender: { command: "uvx", args: ["blender-mcp"], disabled: true } }),
    null,
  );

  assert.deepEqual(await loadMcpServers(cwd, home), {});
});

test("an entry that is only a disabled flag is off, not a broken config", async () => {
  const { home, cwd } = tree(config({ ghidra: { disabled: true } }), null);

  const { value, stderr } = await capture(() => loadMcpServers(cwd, home));
  assert.deepEqual(value, {});
  assert.equal(stderr, "");
});

test("note and disabled never reach the SDK", async () => {
  const { home, cwd } = tree(
    config({
      ida: {
        command: "python",
        args: ["ida_mcp_server.py"],
        env: { IDA_MCP_HOST: "127.0.0.1" },
        timeout: 30_000,
        alwaysLoad: true,
        disabled: false,
        note: "Needs IDA open with a binary loaded.",
      },
    }),
    null,
  );

  // Field for field, not `toMatchObject`: a leaked `note` is exactly the kind of extra
  // key a partial comparison would let through.
  assert.deepEqual(await loadMcpServers(cwd, home), {
    ida: {
      command: "python",
      args: ["ida_mcp_server.py"],
      env: { IDA_MCP_HOST: "127.0.0.1" },
      timeout: 30_000,
      alwaysLoad: true,
    },
  });
});

test("an entry keyed agentide is refused, so the IDE's own tools cannot be shadowed", async () => {
  const { home, cwd } = tree(null, config({ agentide: { command: "impostor" } }));
  const { value, stderr } = await capture(() => loadMcpServers(cwd, home));

  assert.deepEqual(value, {});
  assert.match(stderr, /reserved/);
});

test("a file that is not valid JSON costs its servers and not the turn", async () => {
  const { home, cwd } = tree(config({ blender: { command: "uvx" } }), '{ "mcpServers": { ,, }');
  const { value, stderr } = await capture(() => loadMcpServers(cwd, home));

  // The other file still loads: one broken config must not take the working one with it.
  assert.deepEqual(value, { blender: { command: "uvx" } });
  assert.match(stderr, /not valid JSON/);
});

test("a malformed entry is skipped by name and the rest of the file still loads", async () => {
  const { home, cwd } = tree(
    config({
      broken: { args: ["no command here"] },
      typo: { command: "uvx", commnad: "uvx" },
      good: { command: "npx" },
    }),
    null,
  );
  const { value, stderr } = await capture(() => loadMcpServers(cwd, home));

  assert.deepEqual(value, { good: { command: "npx" } });
  assert.match(stderr, /"broken"/);
  assert.match(stderr, /"typo"/);
});

test("sse and http entries keep their url and headers", async () => {
  // A literal header, not a `${VAR}` one: this case is about the transport fields
  // surviving the trip, and the three cases below own the substitution. It used to assert
  // that `${GITHUB_TOKEN}` came through unchanged, which stopped being true the moment
  // this module started expanding it.
  const { home, cwd } = tree(
    config({
      github: {
        type: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer literal-token", "X-Trace": "on" },
      },
      streamed: { type: "sse", url: "https://example.test/sse" },
    }),
    null,
  );

  assert.deepEqual(await loadMcpServers(cwd, home), {
    github: {
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer literal-token", "X-Trace": "on" },
    },
    streamed: { type: "sse", url: "https://example.test/sse" },
  });
});

test("an edit to the config is picked up without restarting the process", async () => {
  const { home, cwd } = tree(config({ blender: { command: "uvx" } }), null);

  assert.deepEqual(await loadMcpServers(cwd, home), { blender: { command: "uvx" } });
  writeFileSync(
    join(home, ".agentide", "mcp.json"),
    config({ blender: { command: "uvx", disabled: true } }),
    "utf8",
  );
  // Nothing is cached per cwd on purpose; this is the behaviour that makes that choice
  // worth its two file reads a turn.
  assert.deepEqual(await loadMcpServers(cwd, home), {});
});

test("a ${VAR} in a header is replaced from the environment", async () => {
  const { home, cwd } = tree(
    config({
      github: {
        type: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer ${AGENTIDE_TEST_TOKEN}" },
      },
    }),
    null,
  );

  process.env.AGENTIDE_TEST_TOKEN = "sentinel";
  try {
    assert.deepEqual(await loadMcpServers(cwd, home), {
      github: {
        type: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer sentinel" },
      },
    });
  } finally {
    delete process.env.AGENTIDE_TEST_TOKEN;
  }
});

test("a ${VAR} that is not set drops the server instead of sending the literal", async () => {
  // Expanding to "" would connect and refuse everything, which reads as broken tooling
  // rather than as a token nobody set.
  const { home, cwd } = tree(
    config({
      github: {
        type: "http",
        url: "https://example.invalid/mcp",
        headers: { Authorization: "Bearer ${AGENTIDE_ABSENT_TOKEN}" },
      },
    }),
    null,
  );

  const { value, stderr } = await capture(() => loadMcpServers(cwd, home));
  assert.deepEqual(value, {});
  assert.match(stderr, /AGENTIDE_ABSENT_TOKEN/);
});

test("a warning about a missing variable never prints its value", async () => {
  const { home, cwd } = tree(
    config({
      one: { command: "x", env: { A: "${AGENTIDE_SET_VAR}", B: "${AGENTIDE_UNSET_VAR}" } },
    }),
    null,
  );

  process.env.AGENTIDE_SET_VAR = "s3cret-value";
  try {
    const { stderr } = await capture(() => loadMcpServers(cwd, home));
    assert.ok(!stderr.includes("s3cret-value"), "a secret reached the log");
  } finally {
    delete process.env.AGENTIDE_SET_VAR;
  }
});

/** A closed port to point a gate at. Bound, read, then released. */
async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("a server that requires a port is not started when nothing is listening", async () => {
  const port = await deadPort();
  const { home, cwd } = tree(
    config({
      blender: { command: "uvx", args: ["blender-mcp"], requires: { port } },
      chrome: { command: "npx", args: ["chrome-devtools-mcp"] },
    }),
    null,
  );

  const { value, stderr } = await capture(() => loadMcpServers(cwd, home));
  // The ungated one is unaffected: a closed gate is about its own server and nothing else.
  assert.deepEqual(value, { chrome: { command: "npx", args: ["chrome-devtools-mcp"] } });
  assert.match(stderr, /"blender"/);
  assert.match(stderr, new RegExp(String(port)));
});

test("a server that requires a port is started when something is listening", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const { home, cwd } = tree(
      config({ ida: { command: "python", args: ["ida.py"], requires: { port } } }),
      null,
    );

    const { value, stderr } = await capture(() => loadMcpServers(cwd, home));
    // `requires` is ours; the SDK must not see it.
    assert.deepEqual(value, { ida: { command: "python", args: ["ida.py"] } });
    assert.equal(stderr, "");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a gate names the application to open, not just a failure", async () => {
  // The alternative is asking the model to decompile something and being told the tool
  // does not exist, which reads as a broken IDE rather than as a closed program.
  const port = await deadPort();
  const { home, cwd } = tree(config({ ida: { command: "python", requires: { port } } }), null);

  const { stderr } = await capture(() => loadMcpServers(cwd, home));
  assert.match(stderr, /nothing is listening on 127\.0\.0\.1:/);
});
