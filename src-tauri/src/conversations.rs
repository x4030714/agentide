//! Past conversations: the agent SDK's own transcripts under `~/.claude/projects`. Existing
//! files are never modified, and never slurped -- the big ones on this machine reach 45 MB.

use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::fs::WorkspaceState;
use crate::ipc::{ErrorCode, IpcError, WirePath};

/// One past conversation, as much as can be known without opening it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    /// The SDK's session id, which is also the filename and the handle for resuming.
    pub id: String,
    /// The SDK's own generated title, when it made one.
    pub title: Option<String>,
    /// The first thing the user said, which is the title when there is no title.
    pub opening: Option<String>,
    /// Unix epoch milliseconds of the first and last records that carry a time.
    pub started_ms: Option<i64>,
    pub updated_ms: Option<i64>,
    pub prompts: u32,
    pub replies: u32,
    /// The branch the conversation was had on, when the records say.
    pub branch: Option<String>,
    /// Size of the transcript on disk. Shown because importing copies the file, and a
    /// 45 MB copy is worth knowing about before the click rather than after it.
    pub bytes: u64,
}

/// One directory under `~/.claude/projects`: a workspace someone has had conversations in.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeProject {
    /// The directory name, which is the handle for listing and importing out of it.
    pub dir: String,
    /// The workspace the transcripts themselves name. Read out of a record rather than
    /// un-mangled from `dir`, because the mangling cannot be reversed.
    pub cwd: String,
    /// How many `.jsonl` transcripts the directory holds.
    pub conversations: u32,
    /// Modified time of the newest transcript, epoch milliseconds. From the filesystem, not
    /// the records: reading a timestamp out of every file is what this listing exists to avoid.
    pub updated_ms: Option<i64>,
    /// Total size of those transcripts, so the cost of expanding is visible first.
    pub bytes: u64,
}

/// One record of a past conversation, as close to what the SDK streamed as the file keeps.
/// The frontend replays these through the same reducer as a live turn, so a message is handed
/// over whole. It used to be flattened here into text plus tool names, and a reopened
/// conversation drew every tool call as `(used ide_run)` with no operand, no result and
/// nothing to open -- a second reader of content blocks is a second place for them to go wrong.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConversationRecord {
    /// A `user` or `assistant` record, with the API message as written.
    #[serde(rename_all = "camelCase")]
    Message {
        role: String,
        message: serde_json::Value,
        at_ms: Option<i64>,
        /// Put in the conversation by the harness rather than typed: a hook's context, a
        /// "continue" nudge, a background task's completion notice. A user record by type
        /// only; Claude Code hides these in its own transcript too.
        injected: bool,
        /// The summary Claude Code wrote when it compacted. Also a user record by type only,
        /// and the history it summarises is above it in the same file.
        compaction: bool,
    },
    /// The end of a turn, from the SDK's `turn_duration` note. Live, a `result` message
    /// carries this; the file does not keep those.
    #[serde(rename_all = "camelCase")]
    TurnEnd { at_ms: Option<i64>, duration_ms: Option<i64> },
    /// The context was compacted here.
    #[serde(rename_all = "camelCase")]
    Compacted {
        at_ms: Option<i64>,
        trigger: Option<String>,
        pre_tokens: Option<i64>,
        post_tokens: Option<i64>,
    },
}

// --- Locating the directory ------------------------------------------------------

/// `C:\Users\tung\Desktop\agentide` -> `C--Users-tung-Desktop-agentide`: every separator,
/// colon and dot becomes `-`. The SDK's lossy scheme, so callers confirm it against a `cwd`.
fn mangle(path: &Path) -> String {
    path.to_string_lossy()
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '.' => '-',
            other => other,
        })
        .collect()
}

fn projects_dir() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)?;
    let dir = home.join(".claude").join("projects");
    dir.is_dir().then_some(dir)
}

/// Hand `visit` one line at a time until it breaks or the file ends. Why nothing here calls
/// `read_to_string`: transcripts reach 45 MB, and `confirms` opens up to 40 per directory.
fn each_line(file: &Path, mut visit: impl FnMut(&str) -> ControlFlow<()>) -> std::io::Result<()> {
    let mut reader = BufReader::new(File::open(file)?);
    // Reused across lines so a 55,000-record file is one allocation, not 55,000.
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        if visit(line.trim_end()).is_break() {
            return Ok(());
        }
    }
}

/// Two caps on the head-of-file scan: 200 records is nothing when they are prompts and
/// everything when one is a 5 MB tool result. In practice the `cwd` is on the third line.
const HEAD_RECORDS: usize = 200;
const HEAD_BYTES: usize = 1 << 20;

/// Read a file's first record that names a `cwd`, to confirm which workspace it belongs to.
fn cwd_of(file: &Path) -> Option<String> {
    let mut found = None;
    let mut records = 0usize;
    let mut bytes = 0usize;
    each_line(file, |line| {
        records += 1;
        bytes += line.len();
        if let Ok(record) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(cwd) = record.get("cwd").and_then(|value| value.as_str()) {
                found = Some(cwd.to_string());
                return ControlFlow::Break(());
            }
        }
        if records >= HEAD_RECORDS || bytes >= HEAD_BYTES {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    })
    .ok()?;
    found
}

/// Two paths are the same workspace if they normalise to the same `WirePath`.
fn same_workspace(a: &str, b: &WirePath) -> bool {
    WirePath::parse(a).map(|parsed| parsed == *b).unwrap_or(false)
}

/// The directory holding this workspace's conversations, confirmed rather than assumed.
fn dir_for(root: &WirePath) -> Option<PathBuf> {
    let projects = projects_dir()?;
    let guess = projects.join(mangle(&root.to_path()));
    if guess.is_dir() && confirms(&guess, root) {
        return Some(guess);
    }
    // The mangling changed, or two paths collided. Ask the files themselves.
    for entry in std::fs::read_dir(&projects).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() && confirms(&path, root) {
            return Some(path);
        }
    }
    None
}

/// Does any transcript in `dir` say it belongs to `root`?
fn confirms(dir: &Path, root: &WirePath) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten().take(40) {
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "jsonl") {
            if let Some(cwd) = cwd_of(&path) {
                return same_workspace(&cwd, root);
            }
        }
    }
    false
}

// --- Reading ---------------------------------------------------------------------

fn millis(value: Option<&str>) -> Option<i64> {
    // The SDK writes RFC 3339; parsing just the parts avoids a date dependency for what
    // is only ever displayed as "3 hours ago".
    let text = value?;
    let (date, rest) = text.split_once('T')?;
    let time = rest.trim_end_matches('Z');
    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: i64 = date_parts.next()?.parse().ok()?;
    let day: i64 = date_parts.next()?.parse().ok()?;
    let mut time_parts = time.split(':');
    let hour: i64 = time_parts.next()?.parse().ok()?;
    let minute: i64 = time_parts.next()?.parse().ok()?;
    let second: f64 = time_parts.next()?.parse().ok()?;

    // Days since the Unix epoch, by civil-from-days. Being total matters more than being
    // exact: a transcript with an odd timestamp should sort oddly, not fail to list.
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(((days * 86_400 + hour * 3_600 + minute * 60) * 1_000) + (second * 1000.0) as i64)
}

/// The fields a listing reads, without building the record it read them from. serde walks
/// past the tool output a `Value` would allocate: this listing went from 365ms to 39ms.
#[derive(serde::Deserialize)]
struct Head<'a> {
    #[serde(rename = "type", default, borrow)]
    kind: Option<std::borrow::Cow<'a, str>>,
    #[serde(default, borrow)]
    timestamp: Option<std::borrow::Cow<'a, str>>,
    #[serde(rename = "aiTitle", default, borrow)]
    ai_title: Option<std::borrow::Cow<'a, str>>,
    #[serde(rename = "gitBranch", default, borrow)]
    git_branch: Option<std::borrow::Cow<'a, str>>,
}

impl<'a> Head<'a> {
    /// The record's head, or nothing when the line is not a record this understands. A field
    /// of an unexpected type fails the whole deserialize, so a failure falls back to `Value`.
    fn read(line: &'a str) -> Option<Self> {
        if let Ok(head) = serde_json::from_str::<Head<'a>>(line) {
            return Some(head);
        }
        let record: serde_json::Value = serde_json::from_str(line).ok()?;
        let field = |name: &str| {
            record
                .get(name)
                .and_then(|value| value.as_str())
                .map(|text| std::borrow::Cow::Owned(text.to_string()))
        };
        Some(Head {
            kind: field("type"),
            timestamp: field("timestamp"),
            ai_title: field("aiTitle"),
            git_branch: field("gitBranch"),
        })
    }
}

/// The text of a `message.content`, which is either a string or a list of blocks.
fn message_text(message: &serde_json::Value) -> String {
    let content = message.get("content");
    if let Some(text) = content.and_then(|value| value.as_str()) {
        return text.to_string();
    }
    let mut parts = Vec::new();
    if let Some(blocks) = content.and_then(|value| value.as_array()) {
        for block in blocks {
            if block.get("type").and_then(|value| value.as_str()) == Some("text") {
                if let Some(text) = block.get("text").and_then(|value| value.as_str()) {
                    parts.push(text.to_string());
                }
            }
        }
    }
    parts.join("\n\n")
}

/// Drop the bytes of every image in a message, in the prompt and inside tool results alike.
/// Nothing draws them on a replay -- a prompt row keeps a label per image, never the data --
/// and a conversation with fifty screenshots is tens of megabytes of base64 crossing IPC and
/// being parsed by the webview for nothing.
fn strip_images(message: &mut serde_json::Value) {
    fn strip_blocks(blocks: &mut serde_json::Value) {
        let Some(blocks) = blocks.as_array_mut() else { return };
        for block in blocks {
            match block.get("type").and_then(|value| value.as_str()) {
                Some("image") => {
                    if let Some(object) = block.as_object_mut() {
                        object.remove("source");
                    }
                }
                Some("tool_result") => {
                    if let Some(content) = block.get_mut("content") {
                        strip_blocks(content);
                    }
                }
                _ => {}
            }
        }
    }
    if let Some(content) = message.get_mut("content") {
        strip_blocks(content);
    }
}

fn summarise(file: &Path) -> Option<ConversationSummary> {
    let id = file.file_stem()?.to_string_lossy().to_string();

    let mut summary = ConversationSummary {
        id,
        title: None,
        opening: None,
        started_ms: None,
        updated_ms: None,
        prompts: 0,
        replies: 0,
        branch: None,
        bytes: file.metadata().map(|meta| meta.len()).unwrap_or(0),
    };

    // The whole file, because the title is written at the end and the counts need all of
    // it -- but one line at a time, so a 45 MB transcript is not 45 MB resident.
    each_line(file, |line| {
        let Some(head) = Head::read(line) else {
            return ControlFlow::Continue(());
        };
        let at = millis(head.timestamp.as_deref());
        if at.is_some() {
            if summary.started_ms.is_none() {
                summary.started_ms = at;
            }
            summary.updated_ms = at;
        }
        match head.kind.as_deref() {
            Some("ai-title") => {
                summary.title = head.ai_title.map(|title| title.into_owned());
            }
            Some("user") => {
                summary.prompts += 1;
                // The one place a listing needs the message itself, and it needs it once.
                // Re-parsing this single line is what buys skipping the other 55,000.
                if summary.opening.is_none() {
                    if let Ok(record) = serde_json::from_str::<serde_json::Value>(line) {
                        if let Some(message) = record.get("message") {
                            let body = message_text(message);
                            let trimmed = body.trim();
                            if !trimmed.is_empty() {
                                summary.opening = Some(trimmed.chars().take(160).collect());
                            }
                        }
                    }
                }
                if summary.branch.is_none() {
                    summary.branch = head
                        .git_branch
                        .filter(|branch| !branch.is_empty())
                        .map(|branch| branch.into_owned());
                }
            }
            Some("assistant") => summary.replies += 1,
            _ => {}
        }
        ControlFlow::Continue(())
    })
    .ok()?;

    // A file with no prompt in it is a session that was opened and abandoned. Listing it
    // would be listing a row with nothing to say and nothing to resume.
    (summary.prompts > 0).then_some(summary)
}

/// Every conversation in one directory, most recently active first.
fn summarise_dir(dir: &Path) -> Result<Vec<ConversationSummary>, IpcError> {
    let mut out: Vec<ConversationSummary> = std::fs::read_dir(dir)
        .map_err(|err| IpcError::from_io(&err, format!("cannot read {}", dir.display())))?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
        .filter_map(|path| summarise(&path))
        .collect();
    out.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms));
    Ok(out)
}

// --- Commands --------------------------------------------------------------------

/// Every past conversation for the open workspace, most recently active first.
#[tauri::command]
pub async fn conversations_list(
    workspace: State<'_, WorkspaceState>,
) -> Result<Vec<ConversationSummary>, IpcError> {
    let Some(root) = workspace.root() else {
        return Ok(Vec::new());
    };
    let Some(dir) = dir_for(&root) else {
        // No transcripts yet is not an error; it is what a new workspace looks like.
        return Ok(Vec::new());
    };
    summarise_dir(&dir)
}

/// One conversation's messages, for reading. `from_dir` names another directory under
/// `~/.claude/projects`: that is how settings previews another project before importing.
#[tauri::command]
pub async fn conversation_read(
    workspace: State<'_, WorkspaceState>,
    id: String,
    from_dir: Option<String>,
) -> Result<Vec<ConversationRecord>, IpcError> {
    let dir = match from_dir {
        Some(name) => project_dir_named(&name)?,
        None => {
            let root = workspace
                .root()
                .ok_or_else(|| IpcError::new(ErrorCode::NotFound, "no workspace is open"))?;
            dir_for(&root).ok_or_else(|| {
                IpcError::new(ErrorCode::NotFound, "no conversations for this workspace")
            })?
        }
    };
    let file = dir.join(transcript_name(&id)?);
    read_records(&file)
        .map_err(|err| IpcError::from_io(&err, format!("cannot read {}", file.display())))
}

/// Every record of one transcript that the replay draws, in file order.
fn read_records(file: &Path) -> std::io::Result<Vec<ConversationRecord>> {
    let mut out = Vec::new();
    each_line(file, |line| {
        // Most of a transcript by weight is records with no message -- environment
        // attachments, file snapshots, the per-turn bookkeeping. Read the type first, parse
        // only what the replay draws.
        let worth_parsing = Head::read(line)
            .and_then(|head| {
                head.kind
                    .map(|kind| kind == "user" || kind == "assistant" || kind == "system")
            })
            .unwrap_or(false);
        if worth_parsing {
            if let Ok(record) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(entry) = record_of(record) {
                    out.push(entry);
                }
            }
        }
        ControlFlow::Continue(())
    })?;
    Ok(out)
}

/// A string field of a record, by JSON pointer.
fn text_at<'a>(record: &'a serde_json::Value, path: &str) -> Option<&'a str> {
    record.pointer(path).and_then(|value| value.as_str())
}

/// One record as the replay draws it, or nothing when it is not part of the conversation.
fn record_of(mut record: serde_json::Value) -> Option<ConversationRecord> {
    let at_ms = millis(text_at(&record, "/timestamp"));
    let kind = text_at(&record, "/type")?.to_string();
    match kind.as_str() {
        "user" | "assistant" => {
            let flag = |name: &str| record.get(name).and_then(|value| value.as_bool()) == Some(true);
            // Three markers, not one, because the file has been written by several versions
            // of the CLI: `isMeta` is the oldest, `promptSource` names who wrote the text, and
            // a task notification carries an `origin` even when its source says `sdk`.
            let injected = flag("isMeta")
                || text_at(&record, "/promptSource") == Some("system")
                || text_at(&record, "/origin/kind") == Some("task-notification");
            let compaction = flag("isCompactSummary");
            let mut message = record.get_mut("message")?.take();
            strip_images(&mut message);
            Some(ConversationRecord::Message { role: kind, message, at_ms, injected, compaction })
        }
        "system" => match text_at(&record, "/subtype") {
            Some("turn_duration") => Some(ConversationRecord::TurnEnd {
                at_ms,
                duration_ms: record.get("durationMs").and_then(|value| value.as_i64()),
            }),
            Some("compact_boundary") => {
                let count = |name: &str| {
                    record.pointer(&format!("/compactMetadata/{name}")).and_then(|value| value.as_i64())
                };
                Some(ConversationRecord::Compacted {
                    at_ms,
                    trigger: text_at(&record, "/compactMetadata/trigger").map(String::from),
                    pre_tokens: count("preTokens"),
                    post_tokens: count("postTokens"),
                })
            }
            // Local-command echoes, hook summaries, away summaries: about the session rather
            // than part of the conversation.
            _ => None,
        },
        _ => None,
    }
}

// --- Browsing every project ------------------------------------------------------

/// Every project directory holding a readable transcript, newest first. Deliberately shallow
/// -- one `read_dir` plus one transcript head each -- so per-conversation detail can wait.
#[tauri::command]
pub async fn claude_projects_list() -> Result<Vec<ClaudeProject>, IpcError> {
    let Some(projects) = projects_dir() else {
        // No `~/.claude/projects` means Claude Code has never run here. Not an error.
        return Ok(Vec::new());
    };

    let mut out = Vec::new();
    for entry in std::fs::read_dir(&projects)
        .map_err(|err| IpcError::from_io(&err, format!("cannot read {}", projects.display())))?
        .flatten()
    {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Ok(children) = std::fs::read_dir(&dir) else {
            continue;
        };

        let mut files: Vec<(PathBuf, u64, Option<i64>)> = Vec::new();
        for child in children.flatten() {
            let path = child.path();
            if !path.extension().is_some_and(|ext| ext == "jsonl") {
                continue;
            }
            let (size, modified) = match child.metadata() {
                Ok(meta) => (meta.len(), modified_ms(&meta)),
                Err(_) => (0, None),
            };
            files.push((path, size, modified));
        }
        if files.is_empty() {
            continue;
        }
        // Newest first, so the search for a readable `cwd` starts with the file most
        // likely to have one and usually stops there.
        files.sort_by(|a, b| b.2.cmp(&a.2));

        let Some(cwd) = files
            .iter()
            .take(10)
            .find_map(|(path, _, _)| cwd_of(path))
        else {
            // Every transcript we tried is unreadable or names no workspace, so there is
            // nothing truthful to label the row with.
            continue;
        };

        out.push(ClaudeProject {
            dir: entry.file_name().to_string_lossy().to_string(),
            cwd,
            conversations: files.len() as u32,
            updated_ms: files.iter().filter_map(|(_, _, at)| *at).max(),
            bytes: files.iter().map(|(_, size, _)| size).sum(),
        });
    }

    out.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms));
    Ok(out)
}

/// Every conversation in one project directory, most recently active first.
#[tauri::command]
pub async fn claude_conversations_list(dir: String) -> Result<Vec<ConversationSummary>, IpcError> {
    summarise_dir(&project_dir_named(&dir)?)
}

/// Epoch milliseconds of a file's modified time, when the filesystem knows it.
fn modified_ms(meta: &std::fs::Metadata) -> Option<i64> {
    let at = meta.modified().ok()?;
    let since = at.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(since.as_millis() as i64)
}

/// A directory name from the frontend, resolved under `~/.claude/projects`. It is joined
/// onto a path, so it must not be able to leave it.
fn project_dir_named(name: &str) -> Result<PathBuf, IpcError> {
    if name.is_empty() || name.contains(['/', '\\', ':']) || name.contains("..") {
        return Err(IpcError::new(
            ErrorCode::InvalidPath,
            "not a project directory name",
        ));
    }
    let dir = projects_dir()
        .ok_or_else(|| IpcError::new(ErrorCode::NotFound, "no ~/.claude/projects on this machine"))?
        .join(name);
    if !dir.is_dir() {
        return Err(IpcError::new(
            ErrorCode::NotFound,
            format!("no project directory named {name}"),
        ));
    }
    Ok(dir)
}

/// A session id from the frontend, as a filename it cannot escape the directory with.
fn transcript_name(id: &str) -> Result<String, IpcError> {
    if id.is_empty() || id.contains(['/', '\\', ':']) || id.contains("..") {
        return Err(IpcError::new(ErrorCode::InvalidPath, "not a conversation id"));
    }
    Ok(format!("{id}.jsonl"))
}

// --- Importing -------------------------------------------------------------------

/// Rewrite a record's identity: `session`, and every top-level `cwd` since the listing trusts
/// the first it finds. `session_id`, the uuid chain and message content are history, untouched.
fn rebrand(record: &mut serde_json::Value, session: &str, cwd: &str) {
    let Some(fields) = record.as_object_mut() else {
        return;
    };
    if fields.contains_key("sessionId") {
        fields.insert("sessionId".into(), serde_json::Value::String(session.into()));
    }
    if fields.contains_key("cwd") {
        fields.insert("cwd".into(), serde_json::Value::String(cwd.into()));
    }
}

/// Copy a conversation from another project into this workspace, under a new id. A copy and
/// a new id because the original is somebody's history over there and has to keep working.
#[tauri::command]
pub async fn conversation_import(
    workspace: State<'_, WorkspaceState>,
    id: String,
    from_dir: String,
) -> Result<String, IpcError> {
    let source = project_dir_named(&from_dir)?.join(transcript_name(&id)?);
    let root = workspace
        .root()
        .ok_or_else(|| IpcError::new(ErrorCode::NotFound, "no workspace is open"))?;

    // The workspace may never have had a turn, in which case its directory does not exist
    // yet and the mangled name is the one the SDK would itself have chosen.
    let projects = projects_dir()
        .ok_or_else(|| IpcError::new(ErrorCode::NotFound, "no ~/.claude/projects on this machine"))?;
    let target = dir_for(&root).unwrap_or_else(|| projects.join(mangle(&root.to_path())));
    std::fs::create_dir_all(&target)
        .map_err(|err| IpcError::from_io(&err, format!("cannot create {}", target.display())))?;

    let session = uuid::Uuid::new_v4().to_string();
    // The native spelling, because that is what the SDK writes into `cwd` itself -- the
    // wire form's forward slashes would make this workspace look like a different one.
    let cwd = root.to_path().to_string_lossy().to_string();

    let destination = target.join(format!("{session}.jsonl"));
    match copy_transcript(&source, &destination, &session, &cwd) {
        Ok(0) => {
            // An empty copy is worse than none: the SDK would offer to resume nothing.
            let _ = std::fs::remove_file(&destination);
            Err(IpcError::new(
                ErrorCode::NotFound,
                format!("{id} has no records to import"),
            ))
        }
        Ok(_) => Ok(session),
        Err(err) => {
            // Same reason: a half-written transcript is a resumable file with a hole in it.
            let _ = std::fs::remove_file(&destination);
            Err(IpcError::from_io(
                &err,
                format!("cannot copy {}", source.display()),
            ))
        }
    }
}

/// Stream `source` into `destination`, rebranding each record. Returns the record count.
/// Line by line both ways, so importing the 44.7 MB transcript costs one line of memory.
fn copy_transcript(
    source: &Path,
    destination: &Path,
    session: &str,
    cwd: &str,
) -> std::io::Result<u32> {
    let mut out = std::io::BufWriter::new(File::create(destination)?);
    let mut records = 0u32;

    each_line(source, |line| {
        if line.is_empty() {
            return ControlFlow::Continue(());
        }
        records += 1;
        match serde_json::from_str::<serde_json::Value>(line) {
            Ok(mut record) => {
                rebrand(&mut record, session, cwd);
                // A record that would not re-serialise is a hole in the history, so the
                // line it came from goes through untouched instead.
                let written = serde_json::to_string(&record).unwrap_or_else(|_| line.to_string());
                let _ = writeln!(out, "{written}");
            }
            // Not JSON, so not something to rewrite. Copied through: whatever wrote it
            // knows what it means.
            Err(_) => {
                let _ = writeln!(out, "{line}");
            }
        }
        ControlFlow::Continue(())
    })?;

    out.flush()?;
    Ok(records)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mangles_a_windows_path_the_way_the_sdk_does() {
        assert_eq!(
            mangle(Path::new(r"C:\Users\tung\Desktop\agentide")),
            "C--Users-tung-Desktop-agentide"
        );
    }

    #[test]
    fn dots_become_dashes_too() {
        assert_eq!(
            mangle(Path::new(r"C:\Users\tung\antiaim.rip-v2")),
            "C--Users-tung-antiaim-rip-v2"
        );
    }

    #[test]
    fn parses_an_rfc_3339_timestamp() {
        // Checked against `Date.parse` for the exact string the SDK wrote in a real transcript.
        let ms = millis(Some("2026-09-04T18:31:14.605Z")).expect("parsed");
        assert_eq!(ms, 1_788_546_674_605);
    }

    #[test]
    fn the_epoch_is_the_epoch() {
        assert_eq!(millis(Some("1970-01-01T00:00:00.000Z")), Some(0));
    }

    #[test]
    fn a_malformed_timestamp_is_absent_rather_than_wrong() {
        assert_eq!(millis(Some("not a date")), None);
        assert_eq!(millis(None), None);
    }

    #[test]
    fn reads_the_text_out_of_a_message_and_skips_the_tool_calls() {
        let message = serde_json::json!({
            "content": [
                { "type": "text", "text": "renaming it" },
                { "type": "tool_use", "name": "ide_rename_symbol", "input": {} },
                { "type": "text", "text": "done" }
            ]
        });
        assert_eq!(message_text(&message), "renaming it\n\ndone");
    }

    #[test]
    fn a_plain_string_content_still_reads() {
        let message = serde_json::json!({ "content": "hello" });
        assert_eq!(message_text(&message), "hello");
    }

    // --- What a record becomes on replay ---------------------------------------------

    fn message_of(record: ConversationRecord) -> (String, serde_json::Value, bool, bool) {
        match record {
            ConversationRecord::Message { role, message, injected, compaction, .. } => {
                (role, message, injected, compaction)
            }
            other => panic!("expected a message, got {other:?}"),
        }
    }

    #[test]
    fn a_message_is_handed_over_whole_rather_than_flattened() {
        // The tool call and the thinking must survive: the replay draws them as rows, and a
        // flattened `(used ide_run)` is the mess this exists to stop.
        let content = serde_json::json!([
            { "type": "thinking", "thinking": "which file", "signature": "x" },
            { "type": "text", "text": "renaming it" },
            { "type": "tool_use", "id": "toolu_1", "name": "ide_rename_symbol", "input": { "newName": "b" } }
        ]);
        let record = serde_json::json!({
            "type": "assistant",
            "timestamp": "2026-09-04T19:37:52.100Z",
            "message": { "role": "assistant", "content": content.clone() }
        });
        let (role, message, injected, compaction) = message_of(record_of(record).expect("a message"));
        assert_eq!(role, "assistant");
        assert_eq!(message["content"], content);
        assert!(!injected);
        assert!(!compaction);
    }

    #[test]
    fn what_the_harness_put_in_the_persons_mouth_is_marked_as_such() {
        let user = |extra: serde_json::Value| {
            let mut record = serde_json::json!({
                "type": "user",
                "message": { "role": "user", "content": "<task-notification>done</task-notification>" }
            });
            record.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            message_of(record_of(record).expect("a message")).2
        };
        assert!(user(serde_json::json!({ "isMeta": true })));
        assert!(user(serde_json::json!({ "promptSource": "system" })));
        // A task notification whose source says `sdk` still names its origin.
        assert!(user(serde_json::json!({ "promptSource": "sdk", "origin": { "kind": "task-notification" } })));
        assert!(!user(serde_json::json!({ "promptSource": "typed" })));
        assert!(!user(serde_json::json!({ "isMeta": false })));
    }

    #[test]
    fn the_compaction_summary_is_a_user_record_by_type_only() {
        let record = serde_json::json!({
            "type": "user",
            "isCompactSummary": true,
            "message": { "role": "user", "content": "This session is being continued..." }
        });
        assert!(message_of(record_of(record).expect("a message")).3);
    }

    #[test]
    fn an_image_crosses_as_a_placeholder_wherever_it_sits() {
        let record = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": [
                { "type": "tool_result", "tool_use_id": "toolu_1", "content": [
                    { "type": "text", "text": "the page" },
                    { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "AAAA" } }
                ]},
                { "type": "text", "text": "and this one" },
                { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "BBBB" } }
            ]}
        });
        let (_, message, _, _) = message_of(record_of(record).expect("a message"));
        assert_eq!(
            message["content"],
            serde_json::json!([
                { "type": "tool_result", "tool_use_id": "toolu_1", "content": [
                    { "type": "text", "text": "the page" },
                    { "type": "image" }
                ]},
                { "type": "text", "text": "and this one" },
                { "type": "image" }
            ])
        );
    }

    #[test]
    fn the_turn_boundary_and_the_compaction_are_the_only_system_notes_kept() {
        let ended = record_of(serde_json::json!({
            "type": "system", "subtype": "turn_duration", "durationMs": 4200,
            "timestamp": "2026-09-04T19:37:52.100Z"
        }));
        assert!(matches!(ended, Some(ConversationRecord::TurnEnd { duration_ms: Some(4200), at_ms: Some(_) })));

        let compacted = record_of(serde_json::json!({
            "type": "system", "subtype": "compact_boundary",
            "compactMetadata": { "trigger": "auto", "preTokens": 966212, "postTokens": 13534 }
        }));
        match compacted {
            Some(ConversationRecord::Compacted { trigger, pre_tokens, post_tokens, .. }) => {
                assert_eq!(trigger.as_deref(), Some("auto"));
                assert_eq!((pre_tokens, post_tokens), (Some(966212), Some(13534)));
            }
            other => panic!("expected a compaction, got {other:?}"),
        }

        for subtype in ["local_command", "stop_hook_summary", "away_summary", "informational"] {
            let note = record_of(serde_json::json!({ "type": "system", "subtype": subtype, "content": "x" }));
            assert!(note.is_none(), "{subtype} became a record");
        }
        assert!(record_of(serde_json::json!({ "type": "attachment" })).is_none());
    }

    /// A scratch directory that removes itself when the test ends.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let unique = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock before epoch")
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("agentide-convo-{tag}-{unique}"));
            std::fs::create_dir_all(&dir).expect("cannot create scratch dir");
            Self(dir)
        }

        fn write(&self, name: &str, contents: &str) -> PathBuf {
            let path = self.0.join(name);
            std::fs::write(&path, contents).expect("cannot write scratch file");
            path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Three records in the shape a real transcript uses, taken from one on this machine: a
    /// `queue-operation` header, then a user and an assistant turn with `cwd` and the uuids.
    const OLD_ID: &str = "4fe71ece-56a4-432f-9674-b6503d4287d2";
    fn sample_transcript() -> String {
        [
            r#"{"type":"queue-operation","operation":"enqueue","timestamp":"2026-09-04T19:37:46.294Z","sessionId":"4fe71ece-56a4-432f-9674-b6503d4287d2"}"#,
            r#"{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"text","text":"what does a language server do"}]},"uuid":"398d25a5-ad3b-46c2-b636-07c88eac7e8f","timestamp":"2026-09-04T19:37:46.529Z","userType":"external","entrypoint":"sdk-cli","cwd":"C:\\Users\\tung\\Documents\\project","sessionId":"4fe71ece-56a4-432f-9674-b6503d4287d2","version":"2.1.261","gitBranch":"master"}"#,
            r#"{"parentUuid":"398d25a5-ad3b-46c2-b636-07c88eac7e8f","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"it indexes your code"}]},"uuid":"7c1a0f5e-1111-2222-3333-444455556666","timestamp":"2026-09-04T19:37:52.100Z","cwd":"C:\\Users\\tung\\Documents\\project","sessionId":"4fe71ece-56a4-432f-9674-b6503d4287d2","session_id":"b25f15b9-05a9-4bbd-a1ed-0ae5f7605835","version":"2.1.261","gitBranch":"master"}"#,
        ]
        .join("\n")
    }

    fn copied() -> (TempDir, Vec<serde_json::Value>) {
        let dir = TempDir::new("import");
        let source = dir.write(&format!("{OLD_ID}.jsonl"), &sample_transcript());
        let destination = dir.0.join("new.jsonl");
        let records = copy_transcript(
            &source,
            &destination,
            "11112222-3333-4444-5555-666677778888",
            r"C:\Users\tung\Desktop\agentide",
        )
        .expect("copy failed");
        assert_eq!(records, 3);
        let text = std::fs::read_to_string(&destination).expect("copy is unreadable");
        let parsed = text
            .lines()
            .map(|line| serde_json::from_str(line).expect("copy is not json"))
            .collect();
        (dir, parsed)
    }

    #[test]
    fn an_imported_transcript_keeps_every_message_it_came_with() {
        let (_dir, records) = copied();
        let said: Vec<String> = records
            .iter()
            .cloned()
            .filter_map(record_of)
            .map(|record| message_text(&message_of(record).1))
            .collect();
        assert_eq!(said, ["what does a language server do", "it indexes your code"]);
    }

    #[test]
    fn an_imported_transcript_answers_to_its_new_id_in_every_record() {
        let (_dir, records) = copied();
        for record in &records {
            assert_eq!(
                record["sessionId"], "11112222-3333-4444-5555-666677778888",
                "a record still names the old session"
            );
        }
    }

    #[test]
    fn an_imported_transcript_names_the_workspace_it_was_imported_into() {
        let (_dir, records) = copied();
        let cwds: Vec<&str> = records
            .iter()
            .filter_map(|record| record.get("cwd").and_then(|value| value.as_str()))
            .collect();
        assert_eq!(
            cwds,
            [r"C:\Users\tung\Desktop\agentide", r"C:\Users\tung\Desktop\agentide"]
        );
        // The header record carried no `cwd`, and inventing one for it would be inventing
        // a fact about a record that never had it.
        assert!(records[0].get("cwd").is_none());
    }

    #[test]
    fn importing_leaves_fields_it_does_not_understand_alone() {
        let (_dir, records) = copied();
        let assistant = &records[2];
        // `session_id` is a different id from `sessionId` -- in the real store it is
        // shared across transcripts -- so rewriting it would be a guess.
        assert_eq!(assistant["session_id"], "b25f15b9-05a9-4bbd-a1ed-0ae5f7605835");
        assert_eq!(assistant["version"], "2.1.261");
        assert_eq!(assistant["gitBranch"], "master");
        assert_eq!(assistant["parentUuid"], "398d25a5-ad3b-46c2-b636-07c88eac7e8f");
        assert_eq!(assistant["uuid"], "7c1a0f5e-1111-2222-3333-444455556666");
    }

    #[test]
    fn importing_does_not_touch_the_file_it_copied_from() {
        let dir = TempDir::new("source");
        let source = dir.write(&format!("{OLD_ID}.jsonl"), &sample_transcript());
        copy_transcript(&source, &dir.0.join("new.jsonl"), "fresh", "elsewhere")
            .expect("copy failed");
        assert_eq!(
            std::fs::read_to_string(&source).expect("source is gone"),
            sample_transcript()
        );
    }

    #[test]
    fn a_line_that_is_not_json_survives_the_copy_verbatim() {
        let dir = TempDir::new("junk");
        let source = dir.write("in.jsonl", "not json at all\n{\"sessionId\":\"old\"}");
        let destination = dir.0.join("out.jsonl");
        copy_transcript(&source, &destination, "fresh", "elsewhere").expect("copy failed");
        let text = std::fs::read_to_string(&destination).expect("copy is unreadable");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[0], "not json at all");
        assert_eq!(lines[1], r#"{"sessionId":"fresh"}"#);
    }

    #[test]
    fn the_workspace_is_read_from_the_first_record_that_names_one() {
        let dir = TempDir::new("cwd");
        let file = dir.write("t.jsonl", &sample_transcript());
        assert_eq!(cwd_of(&file).as_deref(), Some(r"C:\Users\tung\Documents\project"));
    }

    #[test]
    fn a_transcript_with_no_workspace_gives_up_instead_of_reading_all_of_it() {
        let dir = TempDir::new("nocwd");
        // Twice the record cap, so returning at all means the scan stopped early.
        let lines: Vec<String> = (0..HEAD_RECORDS * 2)
            .map(|n| format!(r#"{{"type":"queue-operation","n":{n}}}"#))
            .collect();
        let file = dir.write("t.jsonl", &lines.join("\n"));
        assert_eq!(cwd_of(&file), None);
    }

    #[test]
    fn a_project_directory_name_cannot_escape_the_projects_folder() {
        for bad in ["..", "../elsewhere", r"..\elsewhere", "C:/Windows", ""] {
            assert!(
                project_dir_named(bad).is_err(),
                "{bad} was accepted as a project directory"
            );
        }
    }

    #[test]
    fn a_conversation_id_cannot_escape_its_directory() {
        for bad in ["../secret", r"..\secret", "C:/Windows/win", ""] {
            assert!(
                transcript_name(bad).is_err(),
                "{bad} was accepted as a conversation id"
            );
        }
        assert_eq!(transcript_name(OLD_ID).expect("valid id"), format!("{OLD_ID}.jsonl"));
    }
}
