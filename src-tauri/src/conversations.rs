//! Past conversations: the agent SDK's own transcripts, and the CLI's, which are the same
//! files.
//!
//! Existing transcripts are never modified. The SDK owns them -- it appends to them as a
//! turn runs and resumes from them when asked -- and editing one in place would be editing
//! a file the SDK is holding open. The one thing here that writes, [`conversation_import`],
//! only ever writes a *new* file: it copies a transcript from another project into this
//! workspace under a fresh session id, so the original stays exactly as its owner left it.
//!
//! ## Where they live
//!
//! `~/.claude/projects/<mangled cwd>/<session id>.jsonl`, one JSON record per line. The
//! directory name is the workspace path with every separator and colon replaced by `-`,
//! which is a lossy transformation and therefore not one to trust blindly: two different
//! paths can mangle to the same name. So the mangled name is a *guess* that is confirmed
//! by reading a record's own `cwd`, and a directory whose records disagree is skipped.
//!
//! ## What a summary costs
//!
//! Summarising means scanning each file, because the title, the first prompt and the turn
//! count are at different ends of it. That is affordable for one workspace and expensive
//! across all of them. Measured on this machine: 16 project directories, 151 transcripts,
//! the five largest files 44.7, 33.5, 29.6, 28.6 and 23.7 MB, and the biggest single
//! directory 182 MB over 79 files.
//!
//! So the listings are split by what they cost. [`claude_projects_list`] reads the head of
//! one transcript per directory -- 152ms for the whole store -- and the per-conversation
//! summaries wait until a directory is expanded, which is 39ms for this project's own 24
//! and 2.1s for that 182 MB one. Debug-build numbers, which is what `cargo test` will
//! reproduce; the shipped build is faster.
//!
//! Two things keep those numbers down, and both look like something to simplify away:
//!
//! - Nothing reads a file into a `String` first. `read_to_string` on the 44.7 MB
//!   transcript is 44.7 MB resident to look at four fields, and [`cwd_of`] did exactly
//!   that for up to 40 files per directory.
//! - Nothing parses a line into a `serde_json::Value` unless it needs the message in it.
//!   A transcript's weight is tool output and file snapshots that no listing looks at.
//!   Reading [`Head`] instead took this project's own listing from 365ms to 39ms.

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
    /// Modified time of the newest transcript, epoch milliseconds. From the filesystem,
    /// not from the records: reading a timestamp out of every file is what this listing
    /// exists to avoid.
    pub updated_ms: Option<i64>,
    /// Total size of those transcripts, so the cost of expanding is visible first.
    pub bytes: u64,
}

/// One message, flattened for display.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationEntry {
    /// `user` or `assistant`.
    pub role: String,
    pub text: String,
    pub at_ms: Option<i64>,
    /// Tool names this message called, so a reply that only used tools is not blank.
    pub tools: Vec<String>,
}

// --- Locating the directory ------------------------------------------------------

/// `C:\Users\tung\Desktop\agentide` -> `C--Users-tung-Desktop-agentide`.
///
/// Every separator, colon and dot becomes `-`. Lossy on purpose -- it is the SDK's
/// scheme, not ours -- which is why callers confirm the guess against a record's `cwd`.
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

/// Hand `visit` one line at a time until it breaks or the file ends.
///
/// The reason nothing here calls `read_to_string`: a transcript is a whole session's tool
/// output and the big ones on this machine are 20-45 MB. Slurping one to look at its first
/// few records costs its whole size in resident memory, and `confirms` does that up to 40
/// times for a single directory. Streaming keeps the peak at one line.
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

/// Two caps on the head-of-file scan, because either one alone has a hole: 200 records is
/// nothing when the records are prompts, and everything when one of them is a 5 MB tool
/// result. In practice the `cwd` is on the third line.
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

    // Days since the Unix epoch, by the civil-from-days algorithm. Correct for every
    // Gregorian date, which matters less than it being total: a transcript with an odd
    // timestamp should sort oddly, not fail to list.
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(((days * 86_400 + hour * 3_600 + minute * 60) * 1_000) + (second * 1000.0) as i64)
}

/// The fields a listing reads, without building the record it read them from.
///
/// Parsing a line into a `serde_json::Value` allocates a map, a `String` per key and a
/// node per value -- for records whose bulk is tool output and file snapshots that nothing
/// here looks at. Deserializing into this skips those fields instead: serde walks past
/// them without allocating, and a `Cow` borrows out of the line unless the JSON escaped
/// it. Measured over the whole store, the summaries it produces are identical and this
/// project's own listing went from 365ms to 39ms.
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
    /// The record's head, or nothing when the line is not a record this understands.
    ///
    /// A field of an unexpected type fails the whole deserialize, where a `Value` would
    /// have parsed and simply not matched -- so a failure falls back to `Value` rather
    /// than dropping the record. That path costs nothing until the day a record changes
    /// shape, which is the day a silently shorter list would be hardest to explain.
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
fn message_text(message: &serde_json::Value) -> (String, Vec<String>) {
    let content = message.get("content");
    if let Some(text) = content.and_then(|value| value.as_str()) {
        return (text.to_string(), Vec::new());
    }
    let mut parts = Vec::new();
    let mut tools = Vec::new();
    if let Some(blocks) = content.and_then(|value| value.as_array()) {
        for block in blocks {
            match block.get("type").and_then(|value| value.as_str()) {
                Some("text") => {
                    if let Some(text) = block.get("text").and_then(|value| value.as_str()) {
                        parts.push(text.to_string());
                    }
                }
                Some("tool_use") => {
                    if let Some(name) = block.get("name").and_then(|value| value.as_str()) {
                        tools.push(name.to_string());
                    }
                }
                _ => {}
            }
        }
    }
    (parts.join("\n\n"), tools)
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
                            let (body, _) = message_text(message);
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
pub fn conversations_list(
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

/// One conversation's messages, for reading.
///
/// `from_dir` names a directory under `~/.claude/projects` to read out of instead of this
/// workspace's own -- that is how the settings panel previews another project's history
/// before importing it. Absent means this workspace.
#[tauri::command]
pub fn conversation_read(
    workspace: State<'_, WorkspaceState>,
    id: String,
    from_dir: Option<String>,
) -> Result<Vec<ConversationEntry>, IpcError> {
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

    let mut out = Vec::new();
    each_line(&file, |line| {
        // Most of a transcript by weight is records with no message in them -- system
        // notes, environment attachments, file-history snapshots that carry whole file
        // bodies. Reading the type first means only the messages get parsed properly.
        let says_something = Head::read(line)
            .and_then(|head| head.kind.map(|kind| kind == "user" || kind == "assistant"))
            .unwrap_or(false);
        if says_something {
            if let Ok(record) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(entry) = entry_of(&record) {
                    out.push(entry);
                }
            }
        }
        ControlFlow::Continue(())
    })
    .map_err(|err| IpcError::from_io(&err, format!("cannot read {}", file.display())))?;
    Ok(out)
}

/// One record as a displayable message, or nothing when it is not one.
fn entry_of(record: &serde_json::Value) -> Option<ConversationEntry> {
    let role = match record.get("type").and_then(|value| value.as_str()) {
        Some(role @ ("user" | "assistant")) => role,
        _ => return None,
    };
    let (body, tools) = message_text(record.get("message")?);
    if body.trim().is_empty() && tools.is_empty() {
        return None;
    }
    Some(ConversationEntry {
        role: role.to_string(),
        text: body,
        at_ms: millis(record.get("timestamp").and_then(|value| value.as_str())),
        tools,
    })
}

// --- Browsing every project ------------------------------------------------------

/// Every project directory that holds at least one readable transcript, newest first.
///
/// Deliberately shallow. Each directory costs one `read_dir`, a `metadata` per file and the
/// head of a single transcript -- so the whole listing is a few dozen kilobytes read even
/// though the store is hundreds of megabytes. The per-conversation detail waits until a
/// directory is expanded.
#[tauri::command]
pub fn claude_projects_list() -> Result<Vec<ClaudeProject>, IpcError> {
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
pub fn claude_conversations_list(dir: String) -> Result<Vec<ConversationSummary>, IpcError> {
    summarise_dir(&project_dir_named(&dir)?)
}

/// Epoch milliseconds of a file's modified time, when the filesystem knows it.
fn modified_ms(meta: &std::fs::Metadata) -> Option<i64> {
    let at = meta.modified().ok()?;
    let since = at.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(since.as_millis() as i64)
}

/// A directory name from the frontend, resolved under `~/.claude/projects`.
///
/// The name is joined onto a path, so it must not be able to leave it.
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

/// Rewrite one record so it belongs to `session` in `cwd`.
///
/// Only the two top-level fields that name the file's own identity are touched. Everything
/// else is left exactly as written, including three fields it is tempting to touch:
///
/// - `session_id` (underscored) is *not* this transcript's id. In the real store it holds
///   a different uuid, the same one across several transcripts -- some other identity
///   entirely -- and rewriting it would be inventing a fact.
/// - `uuid`/`parentUuid` chain the records to each other. They only have to be consistent
///   within the file, and they already are.
/// - message content is history. The environment snapshot the model was shown names the
///   old workspace; changing it would be editing what was said, not where it now lives.
///
/// Every top-level `cwd` is rewritten, not just those matching the source workspace: the
/// listing decides which workspace a directory belongs to by reading the first `cwd` it
/// finds in it, so one record left behind claiming another project can make this
/// workspace's own conversations stop listing.
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

/// Copy a conversation from another project into this workspace, under a new id.
///
/// A copy rather than a move, and a new id rather than the old one, for the same reason:
/// the original is somebody's history in another project and has to keep working there.
/// What comes back is a separate conversation that happens to start with the same
/// messages -- continuing it here does not continue it over there.
#[tauri::command]
pub fn conversation_import(
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
///
/// Read line by line and written the same way, so importing the 44.7 MB transcript costs
/// one line of memory rather than two copies of the file.
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
    fn reads_text_and_tool_calls_out_of_a_message() {
        let message = serde_json::json!({
            "content": [
                { "type": "text", "text": "renaming it" },
                { "type": "tool_use", "name": "ide_rename_symbol", "input": {} },
                { "type": "text", "text": "done" }
            ]
        });
        let (text, tools) = message_text(&message);
        assert_eq!(text, "renaming it\n\ndone");
        assert_eq!(tools, vec!["ide_rename_symbol"]);
    }

    #[test]
    fn a_plain_string_content_still_reads() {
        let message = serde_json::json!({ "content": "hello" });
        assert_eq!(message_text(&message).0, "hello");
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

    /// Three records in the shape a real transcript uses, taken from one on this machine:
    /// a `queue-operation` header with only a `sessionId`, then a user turn and an
    /// assistant turn carrying `cwd`, `version`, `gitBranch` and the uuid chain.
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
            .filter_map(entry_of)
            .map(|entry| entry.text)
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
