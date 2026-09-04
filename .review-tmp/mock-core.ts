/**
 * Design-review harness (kept, not scrap).
 *
 * The UI cannot render in a plain browser -- it calls Tauri IPC -- so design review had
 * no way to see it. This mocks only the Tauri boundary (`@tauri-apps/api/core` and
 * `@tauri-apps/plugin-dialog`, aliased in `vite.review.config.ts`) and serves the REAL
 * components, CSS and Monaco theme at `npx vite --config vite.review.config.ts`.
 *
 * It ships no code into the app: nothing under `src/` imports it, and the root build
 * never sees it. Each later phase gets reviewed through it, so it stays.
 */

const ROOT = "C:/Users/tung/Desktop/agentide";

interface Entry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedMs: number | null;
}

function dir(parent: string, name: string): Entry {
  return { name, path: `${parent}/${name}`, isDir: true, size: 0, modifiedMs: Date.now() };
}
function file(parent: string, name: string, size: number): Entry {
  return { name, path: `${parent}/${name}`, isDir: false, size, modifiedMs: Date.now() };
}

const TREE: Record<string, Entry[]> = {
  [ROOT]: [
    dir(ROOT, "src"),
    dir(ROOT, "src-tauri"),
    file(ROOT, "index.html", 1620),
    file(ROOT, "package.json", 843),
    file(ROOT, "PRODUCT.md", 6114),
    file(ROOT, "vite.config.ts", 712),
  ],
  [`${ROOT}/src`]: [
    dir(`${ROOT}/src`, "lib"),
    dir(`${ROOT}/src`, "panes"),
    file(`${ROOT}/src`, "App.css", 6032),
    file(`${ROOT}/src`, "App.tsx", 3990),
    file(`${ROOT}/src`, "main.tsx", 238),
  ],
  [`${ROOT}/src/lib`]: [
    file(`${ROOT}/src/lib`, "bridge.ts", 1807),
    file(`${ROOT}/src/lib`, "format.ts", 664),
    file(`${ROOT}/src/lib`, "icons.tsx", 1918),
    file(`${ROOT}/src/lib`, "monaco-setup.ts", 7284),
    file(`${ROOT}/src/lib`, "protocol.ts", 3551),
  ],
  [`${ROOT}/src/panes`]: [
    file(`${ROOT}/src/panes`, "Editor.tsx", 6902),
    file(`${ROOT}/src/panes`, "FileTree.tsx", 4881),
  ],
  [`${ROOT}/src-tauri`]: [
    dir(`${ROOT}/src-tauri`, "src"),
    file(`${ROOT}/src-tauri`, "Cargo.toml", 498),
    file(`${ROOT}/src-tauri`, "tauri.conf.json", 1104),
  ],
  [`${ROOT}/src-tauri/src`]: [
    file(`${ROOT}/src-tauri/src`, "fs.rs", 12973),
    file(`${ROOT}/src-tauri/src`, "ipc.rs", 12229),
    file(`${ROOT}/src-tauri/src`, "lib.rs", 555),
    file(`${ROOT}/src-tauri/src`, "main.rs", 189),
  ],
};

const SAMPLE = `use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

/// A path as the Rust core hands it out: absolute, \`/\`-separated,
/// no verbatim prefix, upper-case drive letter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WirePath(String);

const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

impl WirePath {
    pub fn new(raw: &str) -> Result<Self, IpcError> {
        let trimmed = raw.strip_prefix(r"\\\\?\\").unwrap_or(raw);
        if trimmed.is_empty() {
            return Err(IpcError::invalid_path("path is empty"));
        }
        let mut out = trimmed.replace('\\\\', "/");
        if let Some(drive) = out.get(..2) {
            if drive.ends_with(':') {
                out.replace_range(..1, &drive[..1].to_uppercase());
            }
        }
        while out.len() > 1 && out.ends_with('/') && !is_root(&out) {
            out.pop();
        }
        Ok(Self(out))
    }

    /// Back to a native path for the filesystem calls.
    pub fn to_path(&self) -> PathBuf {
        Path::new(&self.0).to_path_buf()
    }
}
`;


/** A scripted turn, so the transcript can be seen without a model call. */
function scriptTurn(emit: (e: unknown) => void) {
  const S = "sess-1";
  const at = (ms: number, e: unknown) => setTimeout(() => emit(e), ms);
  const sdk = (ms: number, msg: unknown) => at(ms, { t: "event", sessionId: S, msg });

  at(0, { t: "ready", pid: 24180, sdkVersion: "0.3.259" });
  sdk(30, {
    type: "system", subtype: "init", model: "claude-opus-5",
    cwd: ROOT, tools: ["Read", "Edit", "Bash", "Grep", "Glob"], permissionMode: "default",
  });
  sdk(120, { type: "assistant", message: { content: [
    { type: "thinking", thinking: "The rename touches the command and its callers. I should ask the language server for the real call sites rather than grepping, since a text match would also hit the doc comments." },
    { type: "text", text: "Finding the real callers first." },
    { type: "tool_use", id: "t1", name: "mcp__ide__ide_references", input: { symbol: "open_workspace", path: `${ROOT}/src-tauri/src/fs.rs` } },
  ] } });
  sdk(220, { type: "user", isSynthetic: true, message: { content: [
    { type: "tool_result", tool_use_id: "t1", content: [
      "4 references",
      "  src-tauri/src/lib.rs:31",
      "  src-tauri/src/agent.rs:118",
      "  src/lib/bridge.ts:34",
      "  src/App.tsx:23",
    ].join("\n") },
  ] } });
  sdk(280, { type: "assistant", message: { content: [
    { type: "tool_use", id: "t2", name: "Read", input: { file_path: `${ROOT}/src-tauri/src/fs.rs` } },
  ] } });
  sdk(360, { type: "user", isSynthetic: true, message: { content: [
    { type: "tool_result", tool_use_id: "t2", content: "x".repeat(13040) },
  ] } });
  sdk(420, { type: "assistant", message: { content: [
    { type: "tool_use", id: "t3", name: "Edit", input: { file_path: `${ROOT}/src-tauri/src/fs.rs` } },
  ] } });
  sdk(500, { type: "user", isSynthetic: true, message: { content: [
    { type: "tool_result", tool_use_id: "t3", content: "applied" },
  ] } });
  sdk(560, { type: "system", subtype: "api_retry", attempt: 2, max_retries: 5, error_status: 429, error: "rate_limit" });
  sdk(620, { type: "assistant", message: { content: [
    { type: "tool_use", id: "t4", name: "Bash", input: { command: "cargo check --all-targets" } },
  ] } });
  sdk(700, { type: "tool_progress", tool_use_id: "t4", elapsed_time_seconds: 9 });
  at(760, { t: "permission_request", id: "p1", sessionId: S, tool: "Bash", input: { command: "cargo clippy --fix" } });
  sdk(900, { type: "assistant", message: { content: [
    { type: "text", text: "Renamed `open_workspace` to `open_root` and updated all four call sites. The Rust side still compiles; clippy needs your say-so before it rewrites anything." },
  ] } });
  sdk(960, { type: "result", subtype: "success", duration_ms: 12420, num_turns: 5, total_cost_usd: 0.0841 });
  at(1000, { t: "done", sessionId: S, reason: "success" });
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  await new Promise((r) => setTimeout(r, 10));
  switch (cmd) {
    case "open_workspace": {
      // Emit a watcher batch so the tree's change marks have something to render.
      const ch = args?.onEvent as { onmessage?: (m: unknown) => void } | undefined;
      setTimeout(() => {
        ch?.onmessage?.([
          { kind: "created", path: `${ROOT}/src/lib/format.ts` },
          { kind: "modified", path: `${ROOT}/src/lib/icons.tsx` },
          // Marked AND opened, so the capture proves a watcher role survives the
          // active row rather than being repainted amber by it.
          { kind: "created", path: `${ROOT}/src-tauri/src/fs.rs` },
          { kind: "modified", path: `${ROOT}/src-tauri/src/ipc.rs` },
        ]);
      }, 900);
      return { root: ROOT, name: "agentide" } as T;
    }
    case "close_workspace":
      return undefined as T;
    case "agent_start": {
      const ch = args?.onEvent as { onmessage?: (m: unknown) => void } | undefined;
      scriptTurn((e) => ch?.onmessage?.(e));
      return undefined as T;
    }
    case "agent_stop":
    case "agent_prompt":
    case "agent_interrupt":
    case "agent_permission_reply":
    case "agent_tool_reply":
      return undefined as T;
    case "list_dir": {
      const path = String(args?.path);
      return { path, entries: TREE[path] ?? [] } as T;
    }
    case "read_file":
      return {
        path: String(args?.path),
        text: SAMPLE,
        size: SAMPLE.length,
        modifiedMs: Date.now(),
        hadBom: false,
      } as T;
    default:
      throw { code: "io", message: `unmocked command: ${cmd}` };
  }
}

export class Channel<T> {
  onmessage: ((message: T) => void) | null = null;
  toJSON() {
    return "__CHANNEL__";
  }
}
