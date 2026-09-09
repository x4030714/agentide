//! Types that cross the Tauri IPC boundary, each mirrored in `src/lib/protocol.ts` --
//! change one and change the other. Paths cross as [`WirePath`], normalized on the way in.

use std::fmt;
use std::path::{Path, PathBuf};

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// A normalized absolute path: `/`-separated, no verbatim prefix, upper-case drive letter,
/// no trailing slash. Windows names one directory three ways; `Deserialize` settles it once.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct WirePath(String);

impl WirePath {
    /// Normalize a path string from outside (the frontend, a CLI argument). Purely lexical,
    /// so it works for paths that do not exist yet; [`WirePath::canonical`] when they must.
    pub fn parse(raw: &str) -> Result<Self, IpcError> {
        normalize(raw)
    }

    /// Normalize a path produced on the Rust side (a `read_dir` entry, a watcher event).
    pub fn from_path(path: &Path) -> Result<Self, IpcError> {
        let raw = path.to_str().ok_or_else(|| {
            IpcError::new(
                ErrorCode::InvalidPath,
                format!("path is not valid UTF-8: {}", path.display()),
            )
        })?;
        Self::parse(raw)
    }

    /// Resolve `..`, symlinks and short names against the filesystem. The path must exist.
    /// Used once per workspace root, so every path derived from it compares by string.
    pub fn canonical(path: &Path) -> Result<Self, IpcError> {
        let resolved = std::fs::canonicalize(path)
            .map_err(|err| IpcError::from_io(&err, format!("cannot resolve {}", path.display())))?;
        Self::from_path(&resolved)
    }

    /// The native path, for use with `std::fs` and friends.
    pub fn to_path(&self) -> PathBuf {
        #[cfg(windows)]
        {
            PathBuf::from(self.0.replace('/', "\\"))
        }
        #[cfg(not(windows))]
        {
            PathBuf::from(&self.0)
        }
    }

    /// The last component, or the whole path for a root such as `C:/`.
    pub fn file_name(&self) -> &str {
        match self.0.rsplit_once('/') {
            Some((_, name)) if !name.is_empty() => name,
            _ => &self.0,
        }
    }
}

impl fmt::Display for WirePath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Debug for WirePath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.0, f)
    }
}

impl Serialize for WirePath {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for WirePath {
    /// Normalizing here is what makes the policy hold: there is no way to build a
    /// `WirePath` out of frontend input without going through [`normalize`].
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        WirePath::parse(&raw).map_err(|err| D::Error::custom(err.message))
    }
}

/// Split an already-slash-separated absolute path into its root prefix and the rest,
/// e.g. `("C:", "Users/tung")` or `("//server/share", "dir")`.
#[cfg(windows)]
fn split_root(path: &str) -> Option<(String, &str)> {
    if let Some(rest) = path.strip_prefix("//") {
        // UNC: server and share belong to the root and must survive `..` handling.
        let mut parts = rest.splitn(3, '/');
        let server = parts.next().filter(|s| !s.is_empty())?;
        let share = parts.next().filter(|s| !s.is_empty())?;
        return Some((format!("//{server}/{share}"), parts.next().unwrap_or("")));
    }
    let mut chars = path.chars();
    let drive = chars.next()?;
    if !drive.is_ascii_alphabetic() || chars.next() != Some(':') {
        return None;
    }
    // A drive with no separator (`C:foo`) is drive-relative, not absolute.
    let rest = path[2..].strip_prefix('/')?;
    Some((format!("{}:", drive.to_ascii_uppercase()), rest))
}

#[cfg(not(windows))]
fn split_root(path: &str) -> Option<(String, &str)> {
    path.strip_prefix('/').map(|rest| (String::new(), rest))
}

fn normalize(raw: &str) -> Result<WirePath, IpcError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(IpcError::new(ErrorCode::InvalidPath, "empty path"));
    }

    #[cfg(windows)]
    let slashed = {
        let swapped = trimmed.replace('\\', "/");
        // Verbatim prefixes: `\\?\C:\x` -> `C:/x`, `\\?\UNC\server\share` -> `//server/share`.
        if let Some(rest) = swapped.strip_prefix("//?/UNC/") {
            format!("//{rest}")
        } else if let Some(rest) = swapped.strip_prefix("//?/") {
            rest.to_string()
        } else {
            swapped
        }
    };
    #[cfg(not(windows))]
    let slashed = trimmed.to_string();

    let (root, rest) = split_root(&slashed).ok_or_else(|| {
        IpcError::new(
            ErrorCode::InvalidPath,
            format!("path is not absolute: {trimmed}"),
        )
    })?;

    let mut parts: Vec<&str> = Vec::new();
    for part in rest.split('/') {
        match part {
            "" | "." => {}
            // A `..` that would escape the root is dropped, which is how the OS treats it.
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }

    if parts.is_empty() {
        // `C:` alone means "current directory on C:" to Windows; `C:/` is the root we mean.
        let root = if root.starts_with("//") {
            root
        } else {
            format!("{root}/")
        };
        return Ok(WirePath(root));
    }
    Ok(WirePath(format!("{root}/{}", parts.join("/"))))
}

/// Machine-readable failure reason; the frontend switches on this, never on `message`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    InvalidPath,
    NotFound,
    PermissionDenied,
    /// Not UTF-8 text, so it cannot be opened in the editor.
    NotUtf8,
    TooLarge,
    IsDirectory,
    Io,
    Watch,
    /// The agent sidecar is not running, cannot be started, or cannot be reached.
    Agent,
    /// A checkpoint operation the shadow repository refused.
    Checkpoint,
    /// A hunk no longer matches the file it was computed from. Always a refusal to act,
    /// never a partial apply: a stale hunk applied blind corrupts the file.
    Stale,
    /// A window operation the runtime refused -- in practice only during shutdown, once
    /// the window the command names is gone.
    Window,
    /// A terminal session that cannot be started, or is no longer running.
    Pty,
    /// A language server that cannot be started, or is no longer running. A server that
    /// is not installed comes back as `NotFound` instead, so the two are distinguishable.
    Lsp,
    /// The user's own repository refused an operation. The message is git's own -- a hook
    /// that rejects a commit has already explained itself better than this app could.
    Git,
}

/// The error every command returns. `Serialize` so Tauri can hand it to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpcError {
    pub code: ErrorCode,
    pub message: String,
}

impl IpcError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// Map an io error onto a code the frontend can act on, keeping `context` as the
    /// human-readable half of the message.
    pub fn from_io(err: &std::io::Error, context: impl Into<String>) -> Self {
        let code = match err.kind() {
            std::io::ErrorKind::NotFound => ErrorCode::NotFound,
            std::io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
            _ => ErrorCode::Io,
        };
        Self::new(code, format!("{}: {err}", context.into()))
    }
}

impl fmt::Display for IpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for IpcError {}

/// A single entry in a directory listing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: WirePath,
    pub is_dir: bool,
    /// Bytes; always 0 for directories.
    pub size: u64,
    /// Unix epoch milliseconds, or `null` when the platform will not say.
    pub modified_ms: Option<u64>,
}

/// One directory level. The tree loads children lazily, one listing per expansion.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: WirePath,
    pub entries: Vec<DirEntry>,
}

/// A file's text plus the metadata needed to write it back unchanged.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContents {
    pub path: WirePath,
    /// UTF-8 text with any byte-order mark removed.
    pub text: String,
    pub size: u64,
    pub modified_ms: Option<u64>,
    /// The file started with a UTF-8 BOM. Hand this back to `write_file` or saving
    /// strips it -- common enough on Windows to be worth carrying.
    pub had_bom: bool,
}

/// What a write left on disk, so the editor can update its baseline without re-reading.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub path: WirePath,
    pub size: u64,
    pub modified_ms: Option<u64>,
}

/// The opened folder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub root: WirePath,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FsChangeKind {
    Created,
    Modified,
    Removed,
}

/// One coalesced filesystem change. Sent to the frontend in batches over a
/// `tauri::ipc::Channel`; the tree refreshes from these rather than polling.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEvent {
    pub kind: FsChangeKind,
    pub path: WirePath,
}

// --- Agent -----------------------------------------------------------------

// The stdio wire is defined once, in `sidecar/src/protocol.ts`. Below are the parts the
// frontend sees too, plus the events `agent.rs` adds; `agent.rs` holds the stdio-only half.

/// A JSON object carried through without being interpreted -- tool arguments, tool
/// inputs. Only the transcript UI knows what is inside.
pub type JsonMap = serde_json::Map<String, serde_json::Value>;

/// How the agent SDK resolves a tool call that is not pre-approved. Mirrors the SDK's
/// `PermissionMode`; Phase 2's mode toggle maps onto it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    Default,
    AcceptEdits,
    BypassPermissions,
    Plan,
    DontAsk,
    Auto,
}

/// How much reasoning the model spends on a turn. Mirrors the SDK's `EffortLevel`; not every
/// model takes every level, so a picker offers [`ModelInfo::supported_effort_levels`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EffortLevel {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

/// Per-turn agent configuration. Travels with each prompt rather than at startup so a
/// mode change takes effect on the next turn without restarting the sidecar.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Left unset means the SDK's own default, which is not a value this wire invents.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<EffortLevel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disallowed_tools: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<u32>,
    /// Appended to Claude Code's preset system prompt, never replacing it. `None` means
    /// the bare preset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt_append: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_partial_messages: Option<bool>,
    /// Continue a past conversation by its transcript id, rather than this session's own.
    /// Sent per prompt, because picking one is something the user does mid-session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_conversation: Option<String>,
    /// Which backend runs this turn: a key from `~/.agentide/providers.json`, or `None` for
    /// Anthropic's own. Only carried here -- the sidecar resolves it, where the secrets are.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    Allow,
    Deny,
}

/// Why a turn ended. `Interrupted` means the host asked, not that the model stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DoneReason {
    Success,
    Interrupted,
    MaxTurns,
    Error,
}

/// One model the installation can run: the subset of the SDK's `ModelInfo` a picker needs.
/// Deserialized, not opaque JSON, so an SDK rename fails a fixture instead of emptying a menu.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    /// Without the leading slash.
    pub name: String,
    pub description: String,
    /// What arguments it takes, e.g. `"<file>"`. Empty when it takes none.
    pub argument_hint: String,
    /// Other spellings that resolve to it, e.g. `/cost` for `/usage`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aliases: Option<Vec<String>>,
}

/// One external MCP server the sidecar held back, and where its application would be. `host`
/// and `port` travel with the name so the chip can say what to open, not just what is broken.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatedServer {
    pub name: String,
    pub host: String,
    pub port: u16,
}

/// One model a configured backend offers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    pub id: String,
    pub name: String,
    pub supports_effort: bool,
}

/// One thing this install is missing, and what to do about it. Mirrors `Problem` in
/// `sidecar/src/doctor.ts`: `blocked` means no turn can run, `degraded` means a feature is
/// absent but the agent still works.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub severity: String,
    pub title: String,
    pub fix: String,
}

/// A backend from `~/.agentide/providers.json`, as the host may see it. The base URL and
/// token stay in the sidecar; the host gets the models, the command, and where it listens.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    /// The key to send back as [`PromptOptions::provider`].
    pub key: String,
    pub models: Vec<ProviderModel>,
    /// The command that starts it, when the entry gives one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<String>,
    pub host: String,
    pub port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    /// The id to send back as [`PromptOptions::model`].
    pub value: String,
    /// The canonical id `value` resolves to, when `value` is an alias such as `sonnet`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_model: Option<String>,
    pub display_name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_effort: Option<bool>,
    /// The levels this model accepts. `None` means the SDK did not say.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supported_effort_levels: Option<Vec<EffortLevel>>,
}

/// The answer to an `ide_*` tool call; `ok` decides which other field is present. Success is
/// built by the frontend, failure only ever here -- that is what [`ToolResult::error`] is for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ToolResult {
    pub fn error(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            text: None,
            error: Some(message.into()),
        }
    }
}

/// Who answered a permission request or a tool call. `Host` means the Rust core answered for
/// the frontend -- every tool with no backend yet -- and the transcript renders those apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplySource {
    Ui,
    Host,
}

/// What the frontend receives over the agent `Channel`. One thread writes it in the order the
/// sidecar produced it: nothing reordered, nothing dropped, a `done` after every `event`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum AgentEvent {
    /// The sidecar's stdio loop is listening. Always the first event of a session.
    #[serde(rename_all = "camelCase")]
    Ready { pid: u32, sdk_version: String },
    /// One `SDKMessage` from the agent SDK, verbatim. Deliberately opaque in Rust: the
    /// SDK's message union is large and moves, so only the transcript destructures it.
    #[serde(rename_all = "camelCase")]
    Event {
        session_id: String,
        msg: serde_json::Value,
    },
    /// The models this installation can run. Arrives once per sidecar, during the first
    /// turn: the list only exists on a live query, so there is none before one starts.
    #[serde(rename_all = "camelCase")]
    Models { models: Vec<ModelInfo> },
    /// The slash commands this installation accepts. Arrives with the models and for the
    /// same reason: both describe the installation, and both need a live query to read.
    #[serde(rename_all = "camelCase")]
    Commands { commands: Vec<SlashCommand> },
    /// The backends `~/.agentide/providers.json` names -- a file, not a live query, so they
    /// arrive at startup and are re-sent each turn. Carries no credential: see [`ProviderInfo`].
    #[serde(rename_all = "camelCase")]
    Providers { providers: Vec<ProviderInfo> },
    /// What this machine is missing before a turn can run. Sent once at startup, so the
    /// window can say so before the first prompt fails.
    #[serde(rename_all = "camelCase")]
    Readiness { problems: Vec<Problem> },
    /// External MCP servers this turn was built without, because their application is not
    /// open. Sent every turn, empty list included: the empty list clears the last turn's chips.
    #[serde(rename_all = "camelCase")]
    McpGated {
        session_id: String,
        servers: Vec<GatedServer>,
    },
    /// A tool call awaiting approval. Answer with `agent_permission_reply`.
    #[serde(rename_all = "camelCase")]
    PermissionRequest {
        id: String,
        session_id: String,
        tool: String,
        input: JsonMap,
    },
    /// The answer that went back to the sidecar, whoever produced it.
    #[serde(rename_all = "camelCase")]
    PermissionDecided {
        id: String,
        session_id: String,
        decision: PermissionDecision,
        source: ReplySource,
    },
    /// An IDE tool needing data only the host has. Answer with `agent_tool_reply`.
    #[serde(rename_all = "camelCase")]
    ToolCall {
        id: String,
        session_id: String,
        name: String,
        args: JsonMap,
    },
    /// The answer that went back to the sidecar, whoever produced it.
    #[serde(rename_all = "camelCase")]
    ToolResult {
        id: String,
        session_id: String,
        result: ToolResult,
        source: ReplySource,
    },
    /// The turn ended. `error` carries detail when `reason` is `error`.
    #[serde(rename_all = "camelCase")]
    Done {
        session_id: String,
        reason: DoneReason,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// The sidecar is gone. `pending` names the requests that will never be answered, so
    /// the transcript can fail exactly those rows instead of waiting on them.
    #[serde(rename_all = "camelCase")]
    Exited {
        code: Option<i32>,
        message: String,
        pending: Vec<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    const SAMPLE: &str = r"c:\Users\tung\..\tung\Desktop\";
    #[cfg(not(windows))]
    const SAMPLE: &str = "/home/tung/../tung/desktop/";

    fn p(raw: &str) -> String {
        WirePath::parse(raw).unwrap().to_string()
    }

    #[cfg(windows)]
    #[test]
    fn normalizes_the_shapes_windows_hands_us() {
        assert_eq!(p(r"C:\Users\tung\Desktop"), "C:/Users/tung/Desktop");
        assert_eq!(p(r"\\?\C:\Users\tung"), "C:/Users/tung");
        assert_eq!(p("c:/users/tung"), "C:/users/tung");
        assert_eq!(p(r"C:\Users\\tung\.\Desktop\"), "C:/Users/tung/Desktop");
        assert_eq!(p(r"\\?\UNC\server\share\dir"), "//server/share/dir");
        assert_eq!(p(r"\\server\share\dir"), "//server/share/dir");
    }

    #[cfg(windows)]
    #[test]
    fn resolves_dot_dot_without_escaping_the_root() {
        assert_eq!(p(r"C:\a\b\..\c"), "C:/a/c");
        assert_eq!(p(r"C:\a\..\..\..\b"), "C:/b");
        assert_eq!(p(r"C:\"), "C:/");
        assert_eq!(p(r"C:\a\.."), "C:/");
        assert_eq!(p(r"\\server\share"), "//server/share");
    }

    #[cfg(windows)]
    #[test]
    fn round_trips_to_a_native_path() {
        let wire = WirePath::parse("c:/Users/tung/a b.txt").unwrap();
        assert_eq!(wire.to_path(), PathBuf::from(r"C:\Users\tung\a b.txt"));
        assert_eq!(wire.file_name(), "a b.txt");
        assert_eq!(WirePath::parse(r"C:\").unwrap().file_name(), "C:/");
    }

    #[test]
    fn rejects_what_it_cannot_normalize() {
        assert!(WirePath::parse("").is_err());
        assert!(WirePath::parse("   ").is_err());
        assert!(WirePath::parse("relative/path").is_err());
        #[cfg(windows)]
        assert!(WirePath::parse("C:relative").is_err());
    }

    #[test]
    fn normalization_is_idempotent() {
        let once = WirePath::parse(SAMPLE).unwrap();
        let twice = WirePath::parse(&once.to_string()).unwrap();
        assert_eq!(once, twice);
    }

    #[test]
    fn deserializing_normalizes() {
        let json = serde_json::to_string(SAMPLE).unwrap();
        let wire: WirePath = serde_json::from_str(&json).unwrap();
        assert_eq!(wire, WirePath::parse(SAMPLE).unwrap());
        assert!(serde_json::from_str::<WirePath>("\"nope\"").is_err());
    }
}

// --- Checkpoints -----------------------------------------------------------

// The shadow git repository at `.agentide/checkpoints.git` makes every agent edit
// reversible. These are the shapes it hands the frontend; the mechanism is `checkpoints.rs`.

/// One commit in the shadow repository.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub id: String,
    /// The first seven characters, for display. The full id is what commands take.
    pub short_id: String,
    /// Unix epoch milliseconds.
    pub created_ms: u64,
    pub label: String,
    /// `None` only for the first checkpoint of a workspace.
    pub parent: Option<String>,
    pub files_changed: u32,
    pub added: u32,
    pub removed: u32,
}

/// How a file differs from the checkpoint it is compared against.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileChange {
    Added,
    Modified,
    Deleted,
}

/// Why a file's text is absent from a diff. The row still renders; only the content is
/// withheld, so the queue never silently drops a change it cannot display.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Omitted {
    /// Not text, so there is nothing a diff editor could show.
    Binary,
    /// Larger than the per-file cap.
    TooLarge,
    /// The bulk diff's total budget ran out. Re-request this file on its own.
    Budget,
    NotUtf8,
}

/// One changed file, with both sides of the text where they can be shown.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    pub path: WirePath,
    /// Workspace-relative, forward-slashed. What git was asked about.
    pub relative: String,
    pub status: FileChange,
    pub added: u32,
    pub removed: u32,
    pub binary: bool,
    /// The text at the checkpoint. `None` for an added file, or when `omitted` is set.
    pub before: Option<String>,
    /// The text now. `None` for a deleted file, or when `omitted` is set.
    pub after: Option<String>,
    pub omitted: Option<Omitted>,
}

/// Every changed file between two points, or between a checkpoint and the work tree.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointDiff {
    pub from: String,
    /// `None` means "against the working tree as it is now".
    pub to: Option<String>,
    pub files: Vec<DiffFile>,
}

/// One hunk of a file's patch. `id` is content-derived and recomputed whenever hunks are
/// asked for, so a stale id fails with `ErrorCode::Stale` rather than reverting elsewhere.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub id: String,
    /// The `@@ ... @@` line, for display.
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub added: u32,
    pub removed: u32,
}

/// One file's hunks against a checkpoint.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHunks {
    pub path: WirePath,
    pub relative: String,
    /// Binary files have no hunks; `hunks` is empty and the whole file is the unit.
    pub binary: bool,
    pub hunks: Vec<Hunk>,
}

/// What reverting actually did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RevertAction {
    /// Put back from the checkpoint.
    Restored,
    /// It did not exist at the checkpoint, so it was removed.
    Deleted,
    /// Already matched the checkpoint; nothing was written.
    Unchanged,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertOutcome {
    pub path: WirePath,
    pub action: RevertAction,
    /// How many hunks were reverted; 0 for a whole-file revert.
    pub hunks: u32,
}

/// The result of rewinding the work tree to a checkpoint. `safety` is taken *before* the
/// rewind, so the one operation here that can remove work is itself undoable.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewindResult {
    pub safety: Checkpoint,
    /// Taken after, so the timeline records the rewind rather than hiding it.
    pub checkpoint: Checkpoint,
    pub restored: Vec<WirePath>,
    /// Created since the checkpoint and removed by the rewind.
    pub deleted: Vec<WirePath>,
    /// Created since the checkpoint and deliberately left alone.
    pub kept: Vec<WirePath>,
}

// --- Terminal --------------------------------------------------------------

// The shapes `pty.rs` hands the frontend. Output is not one of them: it crosses as raw
// bytes on the same channel, because decoding a chunk that ends mid-character corrupts it.

/// What to start. Everything but the id has a default: the workspace root, the user's
/// shell, and a terminal the size of a terminal.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnOptions {
    /// The frontend's handle for this session. Reusing one replaces the session it
    /// names, killing the process that was there.
    pub id: String,
    /// Defaults to the open workspace, then to the home directory.
    pub cwd: Option<WirePath>,
    /// argv, where `command[0]` is the program. Omitted means an interactive shell.
    pub command: Option<Vec<String>>,
    /// One command for the user's own shell to run and then exit, instead of an interactive
    /// session. Takes precedence over `command`; the frontend never learns which shell it is.
    pub shell_command: Option<String>,
    pub rows: Option<u16>,
    pub cols: Option<u16>,
}

/// A session that is running, as `pty_spawn` reports it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyInfo {
    pub id: String,
    /// What was actually started: the resolved shell, unless a command was given.
    pub program: String,
    pub cwd: WirePath,
    /// `None` if the platform will not say.
    pub pid: Option<u32>,
    pub rows: u16,
    pub cols: u16,
}

/// The JSON half of a pty channel; the other half is raw output bytes.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum PtyEvent {
    /// The child is gone, and so is the session: writing to the id now fails. Always the
    /// last thing a session sends, and it arrives after the last of its output.
    #[serde(rename_all = "camelCase")]
    Exited {
        id: String,
        /// `None` only when the platform would not report a code.
        code: Option<u32>,
        /// The signal that ended it, on platforms that have them.
        signal: Option<String>,
        message: String,
    },
}

// --- Language servers ------------------------------------------------------

// The shapes `lsp.rs` hands the frontend. Nothing here models LSP: a message crosses as
// [`RawJson`] and the frontend is the client -- ids, capabilities, `initialize`, the lot.

/// One JSON document, carried without being understood. `Box<RawValue>` serializes as the
/// JSON it already is: no `Value` tree, key order and number spelling survive, one parse.
pub type RawJson = Box<serde_json::value::RawValue>;

/// What to start.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspStartOptions {
    /// The frontend's handle for this server, in practice one per language per workspace.
    /// Starting onto an id that is already running replaces it, killing what was there.
    pub id: String,
    /// argv, where `command[0]` is the program, resolved against `PATH`. No table of known
    /// servers here: which server serves which language is the frontend's decision.
    pub command: Vec<String>,
    /// The directory the server is started in, and which the frontend will name as the
    /// workspace folder in `initialize`. Defaults to the open workspace.
    pub root: Option<WirePath>,
}

/// A server that is running, as `lsp_start` reports it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspInfo {
    pub id: String,
    pub program: String,
    pub root: WirePath,
    /// `None` if the platform will not say.
    pub pid: Option<u32>,
}

/// What arrives on a language server's channel. Order holds within a variant, not across:
/// `messages` and `stderr` are separate pipes. `exited` is the last thing a server sends.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum LspEvent {
    /// Protocol messages, oldest first. Batched -- see the `lsp.rs` module docs -- so a
    /// handler must loop, not assume one.
    #[serde(rename_all = "camelCase")]
    Messages { id: String, messages: Vec<RawJson> },
    /// The server talking about itself: stderr, plus any stdout that was not a well-formed
    /// message. Where clangd reports a missing `compile_commands.json`, so worth showing.
    #[serde(rename_all = "camelCase")]
    Stderr { id: String, lines: Vec<String> },
    /// The process is gone and so is the session: sending to the id now fails, and every
    /// outstanding request should be failed here. Arrives on a replacement as well as a stop.
    #[serde(rename_all = "camelCase")]
    Exited {
        id: String,
        /// `None` when the platform would not report a code.
        code: Option<i32>,
        /// Human-readable, and carrying the tail of stderr when there was any: a server
        /// that dies during startup explains itself here.
        message: String,
    },
}
