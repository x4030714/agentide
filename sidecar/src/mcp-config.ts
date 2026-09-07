/**
 * External MCP servers: the ones the person configured, as opposed to the `agentide`
 * server this process implements.
 *
 * Two files, both optional, both named `.agentide/mcp.json` -- one under the home
 * directory and one under the workspace. The user-level file is the reason this module
 * exists at all: a decompiler, a 3D editor or a browser driver is a tool of the person,
 * not of a repository, and without a user-level file the only way to reach one is to
 * copy the same entry into every workspace. The project file is for the servers that
 * genuinely belong to one codebase, and it wins on a name collision.
 *
 * ## Why a wrapper format rather than the SDK's own
 *
 * The SDK's map is exactly `name -> transport config`, which leaves nowhere to record
 * why an entry exists or to switch it off for an afternoon -- JSON has no comments, so
 * the alternative is deleting the entry and retyping it later. `disabled` and `note` are
 * ours; both are stripped before the object reaches the SDK, whose configs do not
 * declare them.
 *
 * ## Read per turn, never cached
 *
 * Two small files per prompt is not a cost worth optimising, and re-reading is what makes
 * an edit take effect on the next prompt instead of on the next restart -- the same rule
 * `.agentide/system.md` already follows.
 *
 * ## Failure is local
 *
 * A file that will not parse costs the servers it described and nothing else. It is a
 * hand-edited config; a stray comma must not end the turn the person is in the middle of.
 * Bad entries are skipped one at a time, so one typo does not take the rest of the file
 * with it.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { expandVars, isOff, issues, listening, readJson, warn } from "./config-file.ts";
import { IDE_SERVER_NAME } from "./ide-tools.ts";
import type { GatedServer } from "./protocol.ts";

/** Same relative location in both places, so there is one path to remember. */
const CONFIG_PATH = join(".agentide", "mcp.json");

/**
 * agentide's own fields, on every transport. Stripped before the SDK sees the entry.
 *
 * `note` has no runtime effect on purpose: it is the comment the file format cannot
 * otherwise hold, and the place to record what a server needs running before it works.
 */
const ANNOTATIONS = {
  disabled: z.boolean().optional(),
  note: z.string().optional(),
  /**
   * Start this server only when something is already listening here.
   *
   * For the servers that are a client of an application -- IDA, Blender, Figma -- the
   * server is useless without the application, and starting it anyway costs the spawn on
   * every turn and puts a row of failures where the working servers should be. The port
   * is a better question than "is the process running", because it is the condition under
   * which the tools actually work: Blender open with the addon's server not started
   * listens on nothing, and every tool would fail against it.
   */
  requires: z
    .strictObject({
      port: z.number().int().min(1).max(65_535),
      host: z.string().min(1).optional(),
    })
    .optional(),
};

/**
 * Fields the SDK accepts on all three transports, forwarded untouched.
 *
 * Listed rather than passed through: every schema here is strict, so an unknown key is
 * reported as a typo instead of being handed to the SDK. That trade costs a code change
 * when the SDK grows a field, and buys an error that names the misspelling.
 *
 * ## Why `alwaysLoad` is offered but not defaulted
 *
 * `ide-tools.ts` sets `alwaysLoad: true` on the in-process server because without it
 * those tools did not reach the model at all, so the obvious move is to set it here too.
 * It was measured instead, with a real turn and four servers configured, and the init
 * message -- the moment the prompt is built -- reported blender 28 tools, playwright 24,
 * chrome-devtools 29, all connected. Subprocess servers are up in time on their own; the
 * case that needed forcing was the in-process one, registered as `query()` was
 * constructed.
 *
 * So it stays off by default, because turning it on would put every tool of every
 * configured server into every prompt -- ~94 on that machine, against 13 of our own --
 * to fix a problem that was not there. An entry can still set it, which is the answer
 * for a server slow enough to miss the init on the machine it actually runs on.
 */
const SHARED = {
  timeout: z.number().int().positive().optional(),
  alwaysLoad: z.boolean().optional(),
};

const StdioSchema = z.strictObject({
  // Optional because omitting it means stdio; an entry with neither `type` nor `url` is
  // the common case and should not have to say so.
  type: z.literal("stdio").optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  ...SHARED,
  ...ANNOTATIONS,
});

const SseSchema = z.strictObject({
  type: z.literal("sse"),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  ...SHARED,
  ...ANNOTATIONS,
});

const HttpSchema = z.strictObject({
  type: z.literal("http"),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  ...SHARED,
  ...ANNOTATIONS,
});

/** One entry as written, agentide's fields included. */
type ServerEntry =
  | z.infer<typeof StdioSchema>
  | z.infer<typeof SseSchema>
  | z.infer<typeof HttpSchema>;

/** The file itself. Anything beside `mcpServers` is ignored rather than refused. */
const FileSchema = z.object({
  mcpServers: z.record(z.string(), z.unknown()).optional(),
});

/**
 * What one turn's configuration came to: the servers to start, and the ones a closed
 * gate held back.
 *
 * The held-back list is returned rather than only warned about, because a server that
 * is never started is absent from the SDK's own init message -- so from the UI's side
 * its tools look like tools that never existed. `session.ts` puts it on the wire and
 * the MCP strip draws a chip for each one.
 */
export interface LoadedMcpServers {
  servers: Record<string, McpServerConfig>;
  gated: GatedServer[];
}

/**
 * Load and merge both files. `cwd` is the workspace root the turn runs in.
 *
 * `home` is a parameter only so the tests can point at a temporary tree; production
 * never passes it.
 */
export async function loadMcpServers(
  cwd: string,
  home: string = homedir(),
): Promise<LoadedMcpServers> {
  // Project last: a repository that names a server the user also names is describing the
  // one this codebase needs, and that is the more specific claim.
  const merged = {
    ...readConfig(join(home, CONFIG_PATH)),
    ...readConfig(join(cwd, CONFIG_PATH)),
  };

  // Disabled entries survive the merge as `null` and are dropped only here, so that a
  // workspace can switch off a server the user turned on. Filtering per file instead
  // would make `disabled: true` in the project file do nothing at all -- the user's
  // entry would still be standing, and the off switch would look broken for the one
  // case it is most wanted in.
  const live = Object.entries(merged).filter(
    (entry): entry is [string, Gated] => entry[1] !== null,
  );

  // Every gate at once. They are independent, and a sequence of them would put each
  // server's timeout on the path to the first token one after another.
  const open = await Promise.all(
    live.map(([, entry]) =>
      entry.requires ? listening(entry.requires.port, entry.requires.host) : true,
    ),
  );

  const servers: Record<string, McpServerConfig> = {};
  const gated: GatedServer[] = [];
  live.forEach(([name, entry], index) => {
    if (open[index]) {
      servers[name] = entry.config;
      return;
    }
    // Said out loud twice over. The warning is for whoever is reading stderr; the
    // returned entry is for the strip above the composer, because the alternative is a
    // person asking the model to decompile something and being told the tool does not
    // exist. Both name the thing to go and open.
    const { host, port } = entry.requires!;
    gated.push({ name, host, port });
    warn(`MCP server "${name}" was not started: nothing is listening on ${host}:${port}`);
  });
  return { servers, gated };
}

/** A server that parsed, with the gate it has to pass before it is worth starting. */
interface Gated {
  config: McpServerConfig;
  requires?: { port: number; host: string };
}

/**
 * One file's worth of servers. A file that is not there is the normal case.
 *
 * `null` is a disabled entry: present, and deliberately off. See `loadMcpServers`.
 */
function readConfig(path: string): Record<string, Gated | null> {
  const parsed = readJson(path, "MCP servers");
  if (parsed === null) return {};

  const file = FileSchema.safeParse(parsed);
  if (!file.success) {
    warn(`${path}: ${issues(file.error)}; its MCP servers were skipped`);
    return {};
  }

  const servers: Record<string, Gated | null> = {};
  for (const [name, value] of Object.entries(file.data.mcpServers ?? {})) {
    // Refused entries are left out of the map entirely rather than tombstoned: an entry
    // this file could not understand says nothing about the one the other file has.
    if (!accept(path, name)) continue;

    // Switching a server off is checked before the transport is, because the natural way
    // to write it is `{"disabled": true}` and nothing else -- the transport lives in the
    // other file, which is the whole point of turning it off from here. Validating first
    // would reject that as a config missing its `command`, warn about a typo the person
    // did not make, and leave the server running: the one case the off switch exists for
    // would be the one case it did not work.
    if (isOff(value)) {
      servers[name] = null;
      continue;
    }

    const entry = schemaFor(value).safeParse(value);
    if (!entry.success) {
      warn(`${path}: MCP server "${name}" was ignored -- ${issues(entry.error)}`);
      continue;
    }

    const gate = entry.data.requires;
    const config = strip(entry.data);
    const resolved = expandVars(config);
    if ("missing" in resolved) {
      // Named, never valued: this is the path a token travels, and a warning that helpfully
      // printed the variable's contents would put it in the log the person pastes into a
      // bug report.
      warn(
        `${path}: MCP server "${name}" was ignored -- ${resolved.missing.join(" and ")} ` +
          `${resolved.missing.length === 1 ? "is" : "are"} not set in this process's environment`,
      );
      continue;
    }
    servers[name] =
      resolved.value === null
        ? null
        : {
            config: resolved.value,
            // Localhost by default: every one of these is a bridge inside an application
            // on this machine, and a `requires` pointing somewhere else would be asking a
            // different question than "is the app open".
            ...(gate ? { requires: { port: gate.port, host: gate.host ?? "127.0.0.1" } } : {}),
          };
  }
  return servers;
}

/** Whether a name may be used at all. Only one is reserved, and for one reason. */
function accept(path: string, name: string): boolean {
  if (name !== IDE_SERVER_NAME) return true;
  // The bug this refuses is the one that cost three phases: a second server under this
  // key connects, contributes its own tools, and the IDE's disappear with no error on
  // either side. See the name comment in `ide-tools.ts`.
  warn(`${path}: "${IDE_SERVER_NAME}" is reserved for the IDE's own tools; that entry was ignored`);
  return false;
}

/**
 * agentide's fields off, the SDK's fields through. `null` for a disabled entry, because
 * the SDK has no notion of one: "off" has to mean "not in the map" by the time it looks.
 */
function strip(entry: ServerEntry): McpServerConfig | null {
  if (entry.disabled) return null;
  const { disabled: _disabled, note: _note, requires: _requires, ...config } = entry;
  return config;
}

/**
 * Which transport an entry claims to be, so the error names the field that is wrong
 * rather than every field of all three shapes at once.
 */
function schemaFor(value: unknown) {
  const type = (value as { type?: unknown } | null)?.type;
  if (type === "sse") return SseSchema;
  if (type === "http") return HttpSchema;
  return StdioSchema;
}
