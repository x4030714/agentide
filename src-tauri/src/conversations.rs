//! Past conversations: the agent SDK's own transcripts, for this workspace.
//!
//! Nothing here writes. The SDK owns these files -- it appends to them as a turn runs and
//! resumes from them when asked -- and this module only reads what it already wrote. That
//! is deliberate: a transcript this app edited would be a transcript the SDK could no
//! longer resume, and resuming is the whole point of listing them.
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
//! count are at different ends of it. These are tens of kilobytes each and there are tens
//! of them, so the whole listing is a few megabytes of line-splitting -- cheap enough to
//! do on every open, which is what keeps the list from ever being stale.

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

/// Read a file's first record that names a `cwd`, to confirm which workspace it belongs to.
fn cwd_of(file: &Path) -> Option<String> {
    let text = std::fs::read_to_string(file).ok()?;
    for line in text.lines().take(200) {
        let record: serde_json::Value = serde_json::from_str(line).ok()?;
        if let Some(cwd) = record.get("cwd").and_then(|value| value.as_str()) {
            return Some(cwd.to_string());
        }
    }
    None
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
    let text = std::fs::read_to_string(file).ok()?;

    let mut summary = ConversationSummary {
        id,
        title: None,
        opening: None,
        started_ms: None,
        updated_ms: None,
        prompts: 0,
        replies: 0,
        branch: None,
    };

    for line in text.lines() {
        let Ok(record) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let at = millis(record.get("timestamp").and_then(|value| value.as_str()));
        if at.is_some() {
            if summary.started_ms.is_none() {
                summary.started_ms = at;
            }
            summary.updated_ms = at;
        }
        match record.get("type").and_then(|value| value.as_str()) {
            Some("ai-title") => {
                summary.title = record
                    .get("aiTitle")
                    .and_then(|value| value.as_str())
                    .map(str::to_string);
            }
            Some("user") => {
                summary.prompts += 1;
                if summary.opening.is_none() {
                    if let Some(message) = record.get("message") {
                        let (body, _) = message_text(message);
                        let trimmed = body.trim();
                        if !trimmed.is_empty() {
                            summary.opening = Some(trimmed.chars().take(160).collect());
                        }
                    }
                }
                if summary.branch.is_none() {
                    summary.branch = record
                        .get("gitBranch")
                        .and_then(|value| value.as_str())
                        .filter(|branch| !branch.is_empty())
                        .map(str::to_string);
                }
            }
            Some("assistant") => summary.replies += 1,
            _ => {}
        }
    }

    // A file with no prompt in it is a session that was opened and abandoned. Listing it
    // would be listing a row with nothing to say and nothing to resume.
    (summary.prompts > 0).then_some(summary)
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

    let mut out: Vec<ConversationSummary> = std::fs::read_dir(&dir)
        .map_err(|err| IpcError::from_io(&err, format!("cannot read {}", dir.display())))?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
        .filter_map(|path| summarise(&path))
        .collect();
    out.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms));
    Ok(out)
}

/// One conversation's messages, for reading.
#[tauri::command]
pub fn conversation_read(
    workspace: State<'_, WorkspaceState>,
    id: String,
) -> Result<Vec<ConversationEntry>, IpcError> {
    // The id is a filename, so it must not be able to name a file outside the directory.
    if id.is_empty() || id.contains(['/', '\\', ':']) || id.contains("..") {
        return Err(IpcError::new(ErrorCode::InvalidPath, "not a conversation id"));
    }
    let root = workspace
        .root()
        .ok_or_else(|| IpcError::new(ErrorCode::NotFound, "no workspace is open"))?;
    let dir = dir_for(&root)
        .ok_or_else(|| IpcError::new(ErrorCode::NotFound, "no conversations for this workspace"))?;
    let file = dir.join(format!("{id}.jsonl"));
    let text = std::fs::read_to_string(&file)
        .map_err(|err| IpcError::from_io(&err, format!("cannot read {}", file.display())))?;

    let mut out = Vec::new();
    for line in text.lines() {
        let Ok(record) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let role = match record.get("type").and_then(|value| value.as_str()) {
            Some(role @ ("user" | "assistant")) => role,
            _ => continue,
        };
        let Some(message) = record.get("message") else {
            continue;
        };
        let (body, tools) = message_text(message);
        if body.trim().is_empty() && tools.is_empty() {
            continue;
        }
        out.push(ConversationEntry {
            role: role.to_string(),
            text: body,
            at_ms: millis(record.get("timestamp").and_then(|value| value.as_str())),
            tools,
        });
    }
    Ok(out)
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
}
