/** External MCP servers, from `.agentide/mcp.json` under the home directory and under the
 * workspace, the project winning a clash. `disabled` and `note` are ours, stripped before the SDK. */

import { homedir } from "node:os";
import { join } from "node:path";

import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { expandVars, isOff, issues, listening, readJson, warn } from "./config-file.ts";
import { IDE_SERVER_NAME } from "./ide-tools.ts";
import type { GatedServer } from "./protocol.ts";

/** Same relative location in both places, so there is one path to remember. */
const CONFIG_PATH = join(".agentide", "mcp.json");

/** agentide's own fields, on every transport, stripped before the SDK sees the entry. `note` has no
 * runtime effect on purpose: it is the comment this file format cannot otherwise hold. */
const ANNOTATIONS = {
  disabled: z.boolean().optional(),
  note: z.string().optional(),
  /** Start this server only when something is already listening there. For the servers that are a
   * client of an app -- IDA, Blender, Figma -- the port is the condition under which tools work. */
  requires: z
    .strictObject({
      port: z.number().int().min(1).max(65_535),
      host: z.string().min(1).optional(),
    })
    .optional(),
};

/** Fields the SDK accepts on all three transports. Listed, not passed through, so a strict schema
 * names a typo. `alwaysLoad` stays off: measured, subprocess servers are connected by init anyway. */
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

/** What one turn's configuration came to. The held-back list is returned, not just warned about: an
 * unstarted server is absent from the SDK's init, so its tools look like tools that never existed. */
export interface LoadedMcpServers {
  servers: Record<string, McpServerConfig>;
  gated: GatedServer[];
}

/** Load and merge both files. `home` is a parameter only so the tests can point at a temporary
 * tree; production never passes it. */
export async function loadMcpServers(
  cwd: string,
  home: string = homedir(),
): Promise<LoadedMcpServers> {
  // Project last: a repository naming a server the user also names is the more specific claim.
  const merged = {
    ...readConfig(join(home, CONFIG_PATH)),
    ...readConfig(join(cwd, CONFIG_PATH)),
  };

  // Disabled entries survive the merge as `null` and are dropped only here, so a workspace can
  // switch off a server the user turned on. Filtering per file would leave the user's entry standing.
  const live = Object.entries(merged).filter(
    (entry): entry is [string, Gated] => entry[1] !== null,
  );

  // Every gate at once: run in sequence, each server's timeout stacks on the way to the first token.
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
    // Said twice over: the warning is for whoever reads stderr, the returned entry is for the strip
    // above the composer. Otherwise the model simply reports that the tool does not exist.
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

/** One file's worth of servers; a file that is not there is the normal case. `null` is a disabled
 * entry: present, and deliberately off. See `loadMcpServers`. */
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

    // Checked before the transport, because `{"disabled": true}` and nothing else is the natural way
    // to write it: validating first would reject it as missing `command` and leave the server up.
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
      // Named, never valued: this is the path a token travels, and printing the value would put it
      // in the log the person pastes into a bug report.
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
            // Localhost by default: each of these is a bridge inside an app on this machine, and a
            // `requires` pointing elsewhere asks something other than "is the app open".
            ...(gate ? { requires: { port: gate.port, host: gate.host ?? "127.0.0.1" } } : {}),
          };
  }
  return servers;
}

/** Whether a name may be used at all. Only one is reserved, and for one reason. */
function accept(path: string, name: string): boolean {
  if (name !== IDE_SERVER_NAME) return true;
  // The bug this refuses cost three phases: a second server under this key connects, contributes its
  // own tools, and the IDE's disappear with no error on either side. See `ide-tools.ts`.
  warn(`${path}: "${IDE_SERVER_NAME}" is reserved for the IDE's own tools; that entry was ignored`);
  return false;
}

/** agentide's fields off, the SDK's fields through. `null` for a disabled entry: the SDK has no
 * notion of one, so "off" has to mean "not in the map" by the time it looks. */
function strip(entry: ServerEntry): McpServerConfig | null {
  if (entry.disabled) return null;
  const { disabled: _disabled, note: _note, requires: _requires, ...config } = entry;
  return config;
}

/** Which transport an entry claims to be, so an error names the field that is wrong rather than
 * every field of all three shapes at once. */
function schemaFor(value: unknown) {
  const type = (value as { type?: unknown } | null)?.type;
  if (type === "sse") return SseSchema;
  if (type === "http") return HttpSchema;
  return StdioSchema;
}
