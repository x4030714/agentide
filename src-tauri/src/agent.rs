//! The agent sidecar: spawn, JSON-lines codec, request routing.
//!
//! The Claude Agent SDK is a Node library, so the agent loop runs in a child process and
//! talks newline-delimited JSON over stdio. This module owns that child: its lifetime,
//! its wire, and the routing between it and the webview.
//!
//! ## The wire
//!
//! Defined once, in `sidecar/src/protocol.ts`. [`HostMessage`] and [`SidecarMessage`]
//! below are the Rust half of that mirror; the parts the frontend also sees live in
//! `ipc.rs`. `sidecar/protocol-fixtures.json` holds one canonical message per variant and
//! both sides round-trip it in their own tests, so a field renamed on one side and not
//! the other fails a test rather than a session.
//!
//! ## Who answers
//!
//! The sidecar computes nothing that belongs to the IDE: a permission prompt and an IDE
//! tool both arrive here as a request with an id and block until something replies with
//! that id. [`AgentStartOptions`] is where the frontend declares what it is able to
//! answer. Anything it does not claim, this module answers itself -- immediately, and
//! honestly -- so a missing backend produces a tool error the model can route around
//! rather than a turn that never ends.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::fs::WorkspaceState;
use crate::ipc::{
    AgentEvent, DoneReason, ErrorCode, GatedServer, IpcError, JsonMap, ModelInfo,
    PermissionDecision, PromptOptions, ProviderInfo, ReplySource, SlashCommand, ToolResult,
    WirePath,
};

// ---------------------------------------------------------------------------
// The stdio wire
// ---------------------------------------------------------------------------

/// Host to sidecar. Mirror of `HostMessage` in `sidecar/src/protocol.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
enum HostMessage {
    /// Run a turn. `cwd` is filled from [`WorkspaceState`] on every prompt, so opening a
    /// different folder lands without restarting the sidecar.
    #[serde(rename_all = "camelCase")]
    Prompt {
        session_id: String,
        cwd: WirePath,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        options: Option<PromptOptions>,
    },
    #[serde(rename_all = "camelCase")]
    PermissionReply {
        id: String,
        decision: PermissionDecision,
        #[serde(skip_serializing_if = "Option::is_none")]
        updated_input: Option<JsonMap>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ToolReply { id: String, result: ToolResult },
    #[serde(rename_all = "camelCase")]
    Interrupt { session_id: String },
    /// Liveness probe, answered without touching the model. Used by the tests.
    #[serde(rename_all = "camelCase")]
    Ping { id: String },
}

/// Sidecar to host. Mirror of `SidecarMessage` in `sidecar/src/protocol.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
enum SidecarMessage {
    #[serde(rename_all = "camelCase")]
    Ready { pid: u32, sdk_version: String },
    #[serde(rename_all = "camelCase")]
    Event {
        session_id: String,
        msg: serde_json::Value,
    },
    /// Sent once per sidecar, during its first turn. Not tied to a session.
    #[serde(rename_all = "camelCase")]
    Models { models: Vec<ModelInfo> },
    /// Sent with the models, for the same reason: both describe the installation.
    #[serde(rename_all = "camelCase")]
    Commands { commands: Vec<SlashCommand> },
    /// The backends `providers.json` names. Sent at startup, so the picker is useful
    /// before any turn has run, and again each turn because the file is re-read each
    /// turn. Carries no credential: see [`ProviderInfo`].
    #[serde(rename_all = "camelCase")]
    Providers { providers: Vec<ProviderInfo> },
    /// The external MCP servers the sidecar held back this turn, because the application
    /// each one drives is not open. Sent every turn, empty list included.
    #[serde(rename_all = "camelCase")]
    McpGated {
        session_id: String,
        servers: Vec<GatedServer>,
    },
    #[serde(rename_all = "camelCase")]
    PermissionRequest {
        id: String,
        session_id: String,
        tool: String,
        input: JsonMap,
    },
    #[serde(rename_all = "camelCase")]
    ToolCall {
        id: String,
        session_id: String,
        name: String,
        args: JsonMap,
    },
    #[serde(rename_all = "camelCase")]
    Done {
        session_id: String,
        reason: DoneReason,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Pong { id: String },
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

/// Read buffer for the sidecar's stdout. Messages far larger than this are routine --
/// an `event` carrying a tool result carries whatever the tool read.
const READ_BUFFER: usize = 16 * 1024;

/// The ceiling the sidecar applies to its own lines. Past this the stream is
/// desynchronized rather than merely large, and buffering more of it helps nobody.
const MAX_LINE_BYTES: usize = 32 * 1024 * 1024;

/// Reassembles newline-delimited lines from arbitrary byte chunks.
///
/// Mirror of `LineDecoder` in `sidecar/src/protocol.ts`. A pipe read boundary falls
/// wherever the OS puts it: mid-message, mid-line and mid-UTF-8-character are all
/// normal. Buffering bytes rather than text means the split character needs no special
/// case; the carry buffer covers the split line. Neither a chunk smaller than a message
/// nor a message larger than a chunk is exceptional.
struct LineDecoder {
    carry: Vec<u8>,
    max_line_bytes: usize,
}

impl LineDecoder {
    fn new(max_line_bytes: usize) -> Self {
        Self {
            carry: Vec::new(),
            max_line_bytes,
        }
    }

    /// Append `chunk` and push every complete line it finishes onto `out`.
    ///
    /// Returns an error once the unterminated tail passes the ceiling; the carry is
    /// dropped, so a caller that keeps going resynchronizes at the next newline.
    fn push(&mut self, chunk: &[u8], out: &mut Vec<String>) -> Result<(), IpcError> {
        let mut rest = chunk;
        while let Some(at) = rest.iter().position(|byte| *byte == b'\n') {
            let (line, tail) = rest.split_at(at);
            self.carry.extend_from_slice(line);
            // A host writing CRLF is not this layer's problem to diagnose.
            if self.carry.last() == Some(&b'\r') {
                self.carry.pop();
            }
            if !self.carry.is_empty() {
                out.push(take_utf8(&mut self.carry)?);
            }
            self.carry.clear();
            rest = &tail[1..];
        }
        self.carry.extend_from_slice(rest);
        if self.carry.len() > self.max_line_bytes {
            let overflow = self.carry.len();
            self.carry = Vec::new();
            return Err(IpcError::new(
                ErrorCode::Agent,
                format!("agent wire line reached {overflow} bytes; stream desynchronized"),
            ));
        }
        Ok(())
    }

    /// Whatever is buffered at end of stream. A well-behaved peer leaves nothing.
    fn flush(&mut self) -> Option<String> {
        if self.carry.is_empty() {
            return None;
        }
        take_utf8(&mut self.carry).ok()
    }
}

fn take_utf8(bytes: &mut Vec<u8>) -> Result<String, IpcError> {
    String::from_utf8(std::mem::take(bytes)).map_err(|err| {
        IpcError::new(
            ErrorCode::Agent,
            format!("agent wire line is not valid UTF-8: {err}"),
        )
    })
}

// ---------------------------------------------------------------------------
// Process
// ---------------------------------------------------------------------------

/// How long the sidecar gets to exit after its stdin closes, before it is killed.
const SHUTDOWN_GRACE: Duration = Duration::from_millis(1500);

/// How often to check whether it has.
const SHUTDOWN_POLL: Duration = Duration::from_millis(20);

/// How many stderr lines to keep so a crash can be explained after the fact.
const STDERR_TAIL: usize = 40;

/// What the frontend can answer for itself.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStartOptions {
    /// Names of `ide_*` tools the frontend will answer with `agent_tool_reply`.
    ///
    /// Anything not named here is answered by this module immediately, with a message
    /// saying which backend is missing. That keeps an unbuilt tool a one-line tool error
    /// instead of a thirty-second stall in every turn that touches it.
    #[serde(default)]
    pub host_tools: Vec<String>,
    /// The frontend will answer permission requests with `agent_permission_reply`. When
    /// false -- which is the case until Phase 2 ships the approval UI -- every prompt is
    /// denied at once with an explanation, rather than left waiting on nobody.
    #[serde(default)]
    pub host_permissions: bool,
}

/// The parts of a running agent that the reader thread and the commands share.
struct Router {
    channel: Channel<AgentEvent>,
    /// `None` once the pipe has been closed or has failed; every write checks.
    stdin: Mutex<Option<ChildStdin>>,
    /// Request id -> session id, for everything waiting on the frontend.
    pending: Mutex<HashMap<String, String>>,
    host_tools: Vec<String>,
    host_permissions: bool,
}

impl Router {
    fn emit(&self, event: AgentEvent) {
        // A closed channel means the webview is gone; the exit path handles that.
        let _ = self.channel.send(event);
    }

    fn send(&self, message: &HostMessage) -> Result<(), IpcError> {
        let line = serde_json::to_string(message).map_err(|err| {
            IpcError::new(
                ErrorCode::Agent,
                format!("cannot encode a message for the agent: {err}"),
            )
        })?;
        let mut slot = self.stdin.lock().expect("agent stdin poisoned");
        let stdin = slot.as_mut().ok_or_else(|| {
            IpcError::new(ErrorCode::Agent, "the agent host is no longer accepting input")
        })?;
        let written = stdin
            .write_all(line.as_bytes())
            .and_then(|()| stdin.write_all(b"\n"))
            .and_then(|()| stdin.flush());
        if let Err(err) = written {
            // A broken pipe means the child is gone. Drop the handle so the next caller
            // gets the clear error above instead of a second io failure.
            *slot = None;
            return Err(IpcError::from_io(&err, "cannot reach the agent host"));
        }
        Ok(())
    }

    fn close_stdin(&self) {
        *self.stdin.lock().expect("agent stdin poisoned") = None;
    }

    /// Record that the frontend owes an answer for `id`.
    fn expect_reply(&self, id: &str, session_id: &str) {
        self.pending
            .lock()
            .expect("agent pending poisoned")
            .insert(id.to_string(), session_id.to_string());
    }

    /// Take ownership of answering `id`, or `None` if something already did.
    fn claim(&self, id: &str) -> Option<String> {
        self.pending
            .lock()
            .expect("agent pending poisoned")
            .remove(id)
    }

    fn take_pending(&self) -> Vec<String> {
        let mut pending = self.pending.lock().expect("agent pending poisoned");
        let mut ids: Vec<String> = pending.drain().map(|(id, _)| id).collect();
        ids.sort();
        ids
    }

    fn answer_permission(
        &self,
        id: String,
        session_id: String,
        decision: PermissionDecision,
        updated_input: Option<JsonMap>,
        message: Option<String>,
        source: ReplySource,
    ) -> Result<(), IpcError> {
        self.send(&HostMessage::PermissionReply {
            id: id.clone(),
            decision,
            updated_input,
            message,
        })?;
        self.emit(AgentEvent::PermissionDecided {
            id,
            session_id,
            decision,
            source,
        });
        Ok(())
    }

    fn answer_tool(
        &self,
        id: String,
        session_id: String,
        result: ToolResult,
        source: ReplySource,
    ) -> Result<(), IpcError> {
        self.send(&HostMessage::ToolReply {
            id: id.clone(),
            result: result.clone(),
        })?;
        self.emit(AgentEvent::ToolResult {
            id,
            session_id,
            result,
            source,
        });
        Ok(())
    }

    /// Forward one sidecar message to the frontend, answering it here when nobody else
    /// will. Called only from the reader thread, so the frontend sees events in the
    /// order the sidecar produced them.
    fn dispatch(&self, message: SidecarMessage) {
        match message {
            SidecarMessage::Ready { pid, sdk_version } => {
                self.emit(AgentEvent::Ready { pid, sdk_version });
            }
            SidecarMessage::Event { session_id, msg } => {
                self.emit(AgentEvent::Event { session_id, msg });
            }
            SidecarMessage::Models { models } => {
                self.emit(AgentEvent::Models { models });
            }
            SidecarMessage::Providers { providers } => {
                self.emit(AgentEvent::Providers { providers });
            }
            SidecarMessage::Commands { commands } => {
                self.emit(AgentEvent::Commands { commands });
            }
            SidecarMessage::McpGated {
                session_id,
                servers,
            } => {
                self.emit(AgentEvent::McpGated {
                    session_id,
                    servers,
                });
            }
            SidecarMessage::PermissionRequest {
                id,
                session_id,
                tool,
                input,
            } => {
                self.emit(AgentEvent::PermissionRequest {
                    id: id.clone(),
                    session_id: session_id.clone(),
                    tool,
                    input,
                });
                if self.host_permissions {
                    self.expect_reply(&id, &session_id);
                    return;
                }
                let reason = "this build has no approval UI; \
                    start the agent with a permissionMode that pre-approves what you want it to do"
                    .to_string();
                report(self.answer_permission(
                    id,
                    session_id,
                    PermissionDecision::Deny,
                    None,
                    Some(reason),
                    ReplySource::Host,
                ));
            }
            SidecarMessage::ToolCall {
                id,
                session_id,
                name,
                args,
            } => {
                self.emit(AgentEvent::ToolCall {
                    id: id.clone(),
                    session_id: session_id.clone(),
                    name: name.clone(),
                    args,
                });
                if self.host_tools.contains(&name) {
                    self.expect_reply(&id, &session_id);
                    return;
                }
                report(self.answer_tool(
                    id,
                    session_id,
                    ToolResult::error(unavailable(&name)),
                    ReplySource::Host,
                ));
            }
            SidecarMessage::Done {
                session_id,
                reason,
                error,
            } => {
                self.emit(AgentEvent::Done {
                    session_id,
                    reason,
                    error,
                });
            }
            // Liveness only. The frontend has no use for it; the tests read it directly.
            SidecarMessage::Pong { .. } => {}
        }
    }
}

/// What the model is told when a tool has no backend in this build.
///
/// Phrased as a fact plus an instruction: a model that is told only "unavailable" retries
/// the call, and a model that is told nothing invents an answer.
fn unavailable(name: &str) -> String {
    let blocker = match name {
        "ide_open" | "ide_selection" | "ide_open_editors" => {
            "the editor is not connected to the agent in this build"
        }
        "ide_diagnostics" => "no language server is running in this build",
        _ => "this build has no backend for it",
    };
    format!(
        "{name} is unavailable: {blocker}. Do not call it again this turn; \
         work from the files on disk instead."
    )
}

fn report(result: Result<(), IpcError>) {
    if let Err(err) = result {
        eprintln!("[agent] {err}");
    }
}

struct Agent {
    router: Arc<Router>,
    process: Arc<Mutex<Child>>,
    /// Set before a deliberate shutdown so the reader thread stays quiet about it.
    stopping: Arc<AtomicBool>,
}

impl Drop for Agent {
    /// Owning the child's lifetime means killing it here too: a `Child` that goes out of
    /// scope keeps running, and the sidecar has no parent to notice it is orphaned.
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.router.close_stdin();
        // Closing stdin is the sidecar's shutdown signal, and it is the path that also
        // tears down the SDK's own child process. Killing outright would leave that one
        // behind on Windows, where there is no process group to signal.
        if await_exit(&self.process, Instant::now() + SHUTDOWN_GRACE).is_none() {
            let mut child = self.process.lock().expect("agent process poisoned");
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Poll until the child exits or `deadline` passes. `None` means it is still running.
///
/// The lock is released around each sleep so this can run on the reader thread and the
/// shutdown path at the same time without either blocking the other.
fn await_exit(process: &Mutex<Child>, deadline: Instant) -> Option<Option<i32>> {
    loop {
        {
            let mut child = process.lock().expect("agent process poisoned");
            match child.try_wait() {
                Ok(Some(status)) => return Some(status.code()),
                // Already reaped by the other waiter; the code is gone with it.
                Err(_) => return Some(None),
                Ok(None) => {}
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(SHUTDOWN_POLL);
    }
}

/// The state Tauri manages. `None` until `agent_start`.
#[derive(Default)]
pub struct AgentState(Mutex<Option<Agent>>);

/// How to run the sidecar.
///
/// Development runs the esbuild bundle under the system `node`. `std::process::Command`
/// is not gated by a Tauri capability, so this needs no `shell:allow-execute` entry and
/// there is no `"sidecar": true` permission to forget. Release will ship the bundle plus
/// a Node runtime as a `bundle.externalBin` and this function will return that binary
/// with no script argument instead; nothing else in this module changes.
fn resolve_command() -> Result<Command, IpcError> {
    let script = sidecar_script();
    if !script.is_file() {
        return Err(IpcError::new(
            ErrorCode::Agent,
            format!(
                "the agent host bundle is missing at {}; run `npm run build` in sidecar/",
                script.display()
            ),
        ));
    }
    let mut command = Command::new(node_runtime());
    command.arg(&script);
    // The child inherits this process's environment deliberately: ANTHROPIC_API_KEY, or
    // the credentials of an existing Claude Code login, is how the SDK authenticates.
    // Nothing here reads, stores or logs either.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        /// Without this a console window flashes up behind the app on every spawn.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(command)
}

/// Where the packaged app keeps its resources, learned once at startup.
///
/// A `OnceLock` rather than plumbing an `AppHandle` down here: the path is a property of
/// the installation, fixed before the first command runs, and threading a handle through
/// every call site to read a constant would be worse than saying so once.
static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Called from `lib.rs`'s setup, where the `AppHandle` exists.
pub fn set_resource_dir(dir: PathBuf) {
    let _ = RESOURCE_DIR.set(dir);
}

fn sidecar_script() -> PathBuf {
    if let Some(overridden) = std::env::var_os("AGENTIDE_SIDECAR") {
        return PathBuf::from(overridden);
    }
    // Installed: the bundle ships as a Tauri resource.
    if let Some(resources) = RESOURCE_DIR.get() {
        let bundled = resources.join("sidecar/main.mjs");
        if bundled.is_file() {
            // Through `WirePath` to strip the `\\?\` verbatim prefix Tauri hands back.
            // Node cannot resolve a main module through one: it gives up partway and
            // reports `EISDIR ... lstat 'C:'`, which says nothing about the real cause.
            // Every other path in this app is normalized for the same reason.
            return WirePath::from_path(&bundled)
                .map(|path| path.to_path())
                .unwrap_or(bundled);
        }
    }
    // Developing: `CARGO_MANIFEST_DIR` is `src-tauri`, and the bundle sits beside it.
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sidecar/dist/main.mjs")
}

/// The Node that runs the sidecar.
///
/// The packaged app ships its own next to the executable, so it does not depend on the
/// machine having Node installed, or on the version it happens to have. Falling back to
/// `node` on PATH is the development path -- and the honest failure when a bundle is
/// somehow incomplete, since the error it produces names a missing program rather than
/// something subtler.
fn node_runtime() -> PathBuf {
    if let Some(overridden) = std::env::var_os("AGENTIDE_NODE") {
        return PathBuf::from(overridden);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let name = if cfg!(windows) { "node.exe" } else { "node" };
            let shipped = dir.join(name);
            if shipped.is_file() {
                return shipped;
            }
        }
    }
    PathBuf::from("node")
}

/// Start the sidecar and stream its events to `on_event`.
///
/// Replaces any agent already running, which stops the old one first.
#[tauri::command]
pub async fn agent_start(
    state: State<'_, AgentState>,
    options: AgentStartOptions,
    on_event: Channel<AgentEvent>,
) -> Result<(), IpcError> {
    let mut child = resolve_command()?
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| IpcError::from_io(&err, "cannot start the agent host"))?;

    // This one carries the most: the host starts the Claude CLI, which starts an MCP
    // server per configured entry, and all of them join the job through their parent.
    crate::reaper::adopt(child.id());

    // `spawn` succeeded, so all three pipes exist.
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let router = Arc::new(Router {
        channel: on_event,
        stdin: Mutex::new(Some(stdin)),
        pending: Mutex::new(HashMap::new()),
        host_tools: options.host_tools,
        host_permissions: options.host_permissions,
    });
    let process = Arc::new(Mutex::new(child));
    let stopping = Arc::new(AtomicBool::new(false));
    let tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL)));

    spawn_thread("agentide-agent-err", {
        let tail = Arc::clone(&tail);
        move || drain_stderr(stderr, &tail)
    })?;
    spawn_thread("agentide-agent-out", {
        let router = Arc::clone(&router);
        let process = Arc::clone(&process);
        let stopping = Arc::clone(&stopping);
        move || supervise(stdout, &router, &process, &stopping, &tail)
    })?;

    // Assigning replaces the previous agent, whose `Drop` stops it.
    *state.0.lock().expect("agent state poisoned") = Some(Agent {
        router,
        process,
        stopping,
    });
    Ok(())
}

/// Stop the sidecar. Safe to call when none is running.
#[tauri::command]
pub fn agent_stop(state: State<'_, AgentState>) {
    // Dropping the `Agent` is what stops it; see `Drop for Agent`.
    let previous = state.0.lock().expect("agent state poisoned").take();
    drop(previous);
}

/// Run a turn. The workspace root travels as `cwd`, read here rather than passed in.
#[tauri::command]
pub fn agent_prompt(
    state: State<'_, AgentState>,
    workspace: State<'_, WorkspaceState>,
    session_id: String,
    text: String,
    options: Option<PromptOptions>,
) -> Result<(), IpcError> {
    let cwd = workspace.root().ok_or_else(|| {
        IpcError::new(
            ErrorCode::Agent,
            "open a folder before prompting the agent: it has no working directory",
        )
    })?;
    with_agent(&state, |agent| {
        agent.router.send(&HostMessage::Prompt {
            session_id,
            cwd,
            text,
            options,
        })
    })
}

/// Stop the running turn and drop anything queued behind it.
#[tauri::command]
pub fn agent_interrupt(state: State<'_, AgentState>, session_id: String) -> Result<(), IpcError> {
    with_agent(&state, |agent| {
        agent.router.send(&HostMessage::Interrupt { session_id })
    })
}

/// Answer a `permission_request`. Fails if something already answered it.
#[tauri::command]
pub fn agent_permission_reply(
    state: State<'_, AgentState>,
    id: String,
    decision: PermissionDecision,
    updated_input: Option<JsonMap>,
    message: Option<String>,
) -> Result<(), IpcError> {
    with_agent(&state, |agent| {
        let session_id = agent.router.claim(&id).ok_or_else(|| stale(&id))?;
        agent.router.answer_permission(
            id,
            session_id,
            decision,
            updated_input,
            message,
            ReplySource::Ui,
        )
    })
}

/// Answer a `tool_call`. Fails if something already answered it.
#[tauri::command]
pub fn agent_tool_reply(
    state: State<'_, AgentState>,
    id: String,
    result: ToolResult,
) -> Result<(), IpcError> {
    with_agent(&state, |agent| {
        let session_id = agent.router.claim(&id).ok_or_else(|| stale(&id))?;
        agent
            .router
            .answer_tool(id, session_id, result, ReplySource::Ui)
    })
}

/// Stop the sidecar on the way out of the app.
///
/// Tauri does not guarantee that managed state is dropped on exit, and an agent host left
/// running would keep a Node process and its SDK child alive with no window attached.
pub fn shutdown(app: &AppHandle) {
    let state = app.state::<AgentState>();
    let previous = state.0.lock().expect("agent state poisoned").take();
    drop(previous);
}

fn with_agent<T>(
    state: &AgentState,
    action: impl FnOnce(&Agent) -> Result<T, IpcError>,
) -> Result<T, IpcError> {
    let guard = state.0.lock().expect("agent state poisoned");
    let agent = guard.as_ref().ok_or_else(|| {
        IpcError::new(
            ErrorCode::Agent,
            "the agent host is not running; start it first",
        )
    })?;
    action(agent)
}

fn stale(id: &str) -> IpcError {
    IpcError::new(
        ErrorCode::Agent,
        format!("request {id} is no longer waiting for an answer"),
    )
}

fn spawn_thread(
    name: &str,
    body: impl FnOnce() + Send + 'static,
) -> Result<std::thread::JoinHandle<()>, IpcError> {
    std::thread::Builder::new()
        .name(name.to_string())
        .spawn(body)
        .map_err(|err| {
            IpcError::new(
                ErrorCode::Agent,
                format!("cannot start the {name} thread: {err}"),
            )
        })
}

/// Read the sidecar's stdout until it ends, then report that it is gone.
///
/// Every path out of the read loop -- clean exit, crash, unreadable stream -- lands in
/// the same place: reap the child, close the input side so no later command writes into
/// a dead pipe, and tell the frontend which requests will never be answered. A pending
/// permission prompt or tool call fails with the sidecar rather than outliving it.
fn supervise(
    stdout: ChildStdout,
    router: &Arc<Router>,
    process: &Arc<Mutex<Child>>,
    stopping: &AtomicBool,
    tail: &Mutex<VecDeque<String>>,
) {
    let trouble = read_stdout(stdout, router);

    let code = await_exit(process, Instant::now() + SHUTDOWN_GRACE).unwrap_or_else(|| {
        // stdout closed but the process is still up: it is not going to say anything
        // more, so stop waiting for it.
        let mut child = process.lock().expect("agent process poisoned");
        let _ = child.kill();
        child.wait().ok().and_then(|status| status.code())
    });

    router.close_stdin();
    let pending = router.take_pending();
    if stopping.load(Ordering::SeqCst) {
        // We asked for this; the frontend already knows.
        return;
    }

    let mut message = match code {
        Some(0) | None => "the agent host exited".to_string(),
        Some(code) => format!("the agent host exited with code {code}"),
    };
    if let Some(trouble) = trouble {
        message.push_str(&format!(": {trouble}"));
    }
    let tail = tail.lock().expect("agent stderr tail poisoned");
    if let Some(last) = tail.iter().next_back() {
        message.push_str(&format!(" -- last output: {last}"));
    }
    router.emit(AgentEvent::Exited {
        code,
        message,
        pending,
    });
}

/// Decode and dispatch until the pipe ends. Returns why, if it was not a clean EOF.
fn read_stdout(mut stdout: ChildStdout, router: &Router) -> Option<String> {
    let mut decoder = LineDecoder::new(MAX_LINE_BYTES);
    let mut buffer = vec![0u8; READ_BUFFER];
    let mut lines = Vec::new();

    loop {
        let read = match stdout.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(err) => return Some(format!("cannot read from the agent host: {err}")),
        };
        lines.clear();
        if let Err(err) = decoder.push(&buffer[..read], &mut lines) {
            return Some(err.message);
        }
        for line in &lines {
            match serde_json::from_str::<SidecarMessage>(line) {
                Ok(message) => router.dispatch(message),
                // One bad line is a protocol bug, not a reason to stop reading the rest.
                Err(err) => eprintln!("[agent] unreadable line from the agent host: {err}"),
            }
        }
    }

    decoder
        .flush()
        .map(|partial| format!("the agent host stopped mid-message after {} bytes", partial.len()))
}

/// Mirror the sidecar's stderr to ours and keep the tail for the exit message.
fn drain_stderr(stderr: ChildStderr, tail: &Mutex<VecDeque<String>>) {
    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
        eprintln!("[sidecar] {line}");
        let mut tail = tail.lock().expect("agent stderr tail poisoned");
        if tail.len() == STDERR_TAIL {
            tail.pop_front();
        }
        tail.push_back(line);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The other half of the mirror. `sidecar/src/codec.test.ts` runs the same file
    /// through the TypeScript types; both must pass for the two to be in step.
    const FIXTURES: &str = include_str!("../../sidecar/protocol-fixtures.json");

    #[derive(Deserialize)]
    struct Fixture {
        name: String,
        message: serde_json::Value,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixtureFile {
        host_to_sidecar: Vec<Fixture>,
        sidecar_to_host: Vec<Fixture>,
    }

    fn fixtures() -> FixtureFile {
        serde_json::from_str(FIXTURES).expect("protocol-fixtures.json is not readable")
    }

    /// Parse each fixture into the Rust type and serialize it back. A field this side
    /// renamed, retyped or dropped shows up as a difference; an extra field in the
    /// fixture disappears on the way back out and shows up too.
    fn round_trip<T>(cases: &[Fixture])
    where
        T: Serialize + serde::de::DeserializeOwned,
    {
        assert!(!cases.is_empty(), "no fixtures to check");
        for case in cases {
            let typed: T = serde_json::from_value(case.message.clone())
                .unwrap_or_else(|err| panic!("{}: cannot parse: {err}", case.name));
            let again = serde_json::to_value(&typed)
                .unwrap_or_else(|err| panic!("{}: cannot serialize: {err}", case.name));
            assert_eq!(again, case.message, "{} does not round-trip", case.name);
        }
    }

    // The prompt fixtures carry Windows paths, which `WirePath` only accepts on Windows.
    #[cfg(windows)]
    #[test]
    fn fixtures_match_the_host_message_mirror() {
        round_trip::<HostMessage>(&fixtures().host_to_sidecar);
    }

    #[test]
    fn fixtures_match_the_sidecar_message_mirror() {
        round_trip::<SidecarMessage>(&fixtures().sidecar_to_host);
    }

    /// The tags a mirror declares, read out of serde's own complaint about one it does
    /// not know.
    ///
    /// Derived rather than written out here: a list kept by hand gets updated in the
    /// same edit that adds the variant, which leaves the coverage check agreeing with
    /// whatever was just written instead of demanding a fixture for it.
    fn declared_tags<T: std::fmt::Debug + serde::de::DeserializeOwned>() -> Vec<String> {
        let unknown = serde_json::json!({ "t": "no_such_variant" });
        let complaint = serde_json::from_value::<T>(unknown)
            .expect_err("an unknown tag must not parse")
            .to_string();
        let listed = complaint
            .split_once("expected one of ")
            .unwrap_or_else(|| panic!("serde no longer names the variants: {complaint}"))
            .1;
        let mut tags: Vec<String> = listed
            .split(',')
            .filter_map(|tag| tag.trim().strip_prefix('`')?.split('`').next())
            .map(str::to_string)
            .collect();
        tags.sort();
        assert!(!tags.is_empty(), "no variants found in: {complaint}");
        tags
    }

    #[test]
    fn fixtures_cover_every_variant() {
        let file = fixtures();
        let tag = |cases: &[Fixture]| {
            let mut tags: Vec<String> = cases
                .iter()
                .map(|case| case.message["t"].as_str().expect("tagged").to_string())
                .collect();
            tags.sort();
            tags.dedup();
            tags
        };
        assert_eq!(
            tag(&file.host_to_sidecar),
            declared_tags::<HostMessage>(),
            "a HostMessage variant has no fixture"
        );
        assert_eq!(
            tag(&file.sidecar_to_host),
            declared_tags::<SidecarMessage>(),
            "a SidecarMessage variant has no fixture"
        );
    }

    /// Every fixture as one stream, which is what the decoder actually faces.
    fn fixture_stream() -> Vec<u8> {
        let file = fixtures();
        let mut stream = Vec::new();
        for case in file.host_to_sidecar.iter().chain(&file.sidecar_to_host) {
            stream.extend_from_slice(case.message.to_string().as_bytes());
            stream.push(b'\n');
        }
        stream
    }

    #[test]
    fn decoder_reassembles_messages_split_across_chunks() {
        let stream = fixture_stream();
        let expected = stream.split(|byte| *byte == b'\n').count() - 1;
        // Sweep the chunk size so every boundary lands mid-message at least once,
        // including one byte at a time -- the worst case a pipe can hand us.
        for size in [1, 2, 3, 7, 13, 64, 1000, stream.len()] {
            let mut decoder = LineDecoder::new(MAX_LINE_BYTES);
            let mut lines = Vec::new();
            for chunk in stream.chunks(size) {
                decoder.push(chunk, &mut lines).expect("decode failed");
            }
            assert_eq!(decoder.flush(), None, "chunk size {size} left a partial line");
            assert_eq!(lines.len(), expected, "chunk size {size}");
            for line in &lines {
                serde_json::from_str::<serde_json::Value>(line)
                    .unwrap_or_else(|err| panic!("chunk size {size}: {err}"));
            }
        }
    }

    #[test]
    fn decoder_reassembles_a_line_longer_than_the_read_buffer() {
        // Half a megabyte in one message: far past any plausible pipe read size.
        let long = SidecarMessage::Event {
            session_id: "big".into(),
            msg: serde_json::json!({ "text": "x".repeat(512 * 1024) }),
        };
        let mut stream = serde_json::to_vec(&long).unwrap();
        stream.push(b'\n');
        stream.extend_from_slice(br#"{"t":"pong","id":"after"}"#);
        stream.push(b'\n');

        for size in [READ_BUFFER, 1024, 65536] {
            let mut decoder = LineDecoder::new(MAX_LINE_BYTES);
            let mut lines = Vec::new();
            for chunk in stream.chunks(size) {
                decoder.push(chunk, &mut lines).expect("decode failed");
            }
            assert_eq!(lines.len(), 2, "chunk size {size}");
            assert!(lines[0].len() > 512 * 1024, "chunk size {size}");
            // The message after the long one must still line up.
            assert_eq!(lines[1], r#"{"t":"pong","id":"after"}"#, "chunk size {size}");
            assert_eq!(decoder.flush(), None);
        }
    }

    #[test]
    fn decoder_handles_multibyte_characters_split_across_chunks() {
        let message = SidecarMessage::Event {
            session_id: "s".into(),
            // Every character is 2-4 bytes, so a 1-byte chunker splits inside all of them.
            msg: serde_json::json!({ "text": "\u{e9}\u{4e2d}\u{6587}\u{1f680}\u{fc}" }),
        };
        let mut stream = serde_json::to_vec(&message).unwrap();
        stream.push(b'\n');

        let mut decoder = LineDecoder::new(MAX_LINE_BYTES);
        let mut lines = Vec::new();
        for chunk in stream.chunks(1) {
            decoder.push(chunk, &mut lines).expect("decode failed");
        }
        assert_eq!(lines.len(), 1);
        let parsed: SidecarMessage = serde_json::from_str(&lines[0]).expect("parse failed");
        match parsed {
            SidecarMessage::Event { msg, .. } => {
                assert_eq!(msg["text"], "\u{e9}\u{4e2d}\u{6587}\u{1f680}\u{fc}");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn decoder_gives_up_rather_than_buffering_an_unbounded_line() {
        let mut decoder = LineDecoder::new(1024);
        let mut lines = Vec::new();
        assert!(decoder.push(&vec![b'a'; 4096], &mut lines).is_err());
        // The carry is dropped, so the next complete line still decodes.
        decoder
            .push(b"{\"t\":\"pong\",\"id\":\"x\"}\n", &mut lines)
            .expect("decode failed");
        assert_eq!(lines, [r#"{"t":"pong","id":"x"}"#]);
    }

    #[test]
    fn decoder_skips_blank_lines_and_crlf_terminators() {
        let mut decoder = LineDecoder::new(MAX_LINE_BYTES);
        let mut lines = Vec::new();
        decoder
            .push(b"\r\n\n{\"t\":\"pong\",\"id\":\"a\"}\r\n\n{\"t\":\"pong\",\"id\":\"b\"}\n", &mut lines)
            .expect("decode failed");
        assert_eq!(
            lines,
            [r#"{"t":"pong","id":"a"}"#, r#"{"t":"pong","id":"b"}"#]
        );
    }

    /// Spawn the real sidecar and round-trip a message over its real stdio.
    ///
    /// `ping` exists so this can prove the whole path -- spawn, encode, pipe, decode --
    /// without a prompt, a model or a token spent.
    #[test]
    fn built_sidecar_answers_over_its_real_stdio() {
        let script = sidecar_script();
        if !script.is_file() {
            // `npm run build` in sidecar/ has not run in this checkout.
            eprintln!("skipping: no sidecar bundle at {}", script.display());
            return;
        }

        let mut child = resolve_command()
            .expect("cannot build the sidecar command")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("cannot start the sidecar");

        let mut stdin = child.stdin.take().expect("piped stdin");
        let line = serde_json::to_string(&HostMessage::Ping {
            id: "smoke".to_string(),
        })
        .expect("encode failed");
        stdin.write_all(line.as_bytes()).expect("write failed");
        stdin.write_all(b"\n").expect("write failed");
        stdin.flush().expect("flush failed");

        // Read until the pong rather than a fixed count. The sidecar volunteers what it
        // knows at startup -- `ready`, then the configured providers -- and a loop that
        // stopped after two messages would consume those and report the answer missing.
        let mut stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
        let mut seen = Vec::new();
        for _ in 0..8 {
            let mut line = String::new();
            stdout.read_line(&mut line).expect("read failed");
            let message =
                serde_json::from_str::<SidecarMessage>(line.trim()).expect("parse failed");
            let answered = matches!(&message, SidecarMessage::Pong { id } if id == "smoke");
            seen.push(message);
            if answered {
                break;
            }
        }

        // Closing stdin is the shutdown signal; the sidecar must take it.
        drop(stdin);
        let status = child.wait().expect("wait failed");

        assert!(
            matches!(seen[0], SidecarMessage::Ready { .. }),
            "the first message must be `ready`, got {:?}",
            seen[0]
        );
        // Somewhere after it, not immediately after it. The sidecar volunteers what it
        // knows at startup — the configured providers today, more later — and pinning the
        // pong to index 1 made this test fail every time it learned to say something new,
        // which is a false alarm about the thing it is not testing.
        assert!(
            seen.iter().any(
                |message| matches!(message, SidecarMessage::Pong { id } if id == "smoke")
            ),
            "no pong came back over the real stdio; got {seen:?}"
        );
        assert!(status.success(), "the sidecar did not exit cleanly");
    }
}
