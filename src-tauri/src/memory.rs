//! The agent's memory vault: where it is, that it exists, and how much is in it. The path
//! rule is duplicated from `sidecar/src/memory-config.ts` -- change it in both places.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};

use crate::fs::is_always_ignored;
use crate::ipc::{ErrorCode, IpcError, WirePath};

/// Must match `DEFAULT_VAULT` in `sidecar/src/memory-config.ts` -- a mismatch would seed and
/// measure one folder while the model wrote into another.
const DEFAULT_VAULT: &str = "agentide-vault";

/// Read per call rather than cached, so moving the vault takes effect on the next open.
const CONFIG_PATH: &str = ".agentide/memory.json";

/// Reaching this means the vault is pointed at a source tree or a home directory. Settings
/// opens on this walk, so it stops rather than counting files nobody will read.
const MAX_NOTES: usize = 20_000;

/// The user's file, as much of it as this side cares about. `enabled` is the sidecar's
/// switch; it is read here only so Settings can say the vault is not being written to.
#[derive(Deserialize)]
struct ConfigFile {
    vault: Option<String>,
    enabled: Option<bool>,
}

/// Where memory lives for this machine, and whether the SDK is being told to use it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryVault {
    pub vault: WirePath,
    pub enabled: bool,
}

/// What is in the vault, without opening any of it.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStats {
    /// Markdown files, at any depth.
    pub notes: u32,
    /// Bytes of those files only, so the number answers "how much has been remembered"
    /// rather than "how big is this directory".
    pub bytes: u64,
    /// Unix epoch milliseconds of the most recently written note, or `null` for an empty
    /// vault. The one number that says whether memory is actually being used.
    pub newest_ms: Option<i64>,
}

// --- Commands --------------------------------------------------------------

// `async` throughout: a synchronous command runs on the thread the webview draws from,
// and a walk of a large tree froze the window.

/// The configured vault, expanded and normalized.
#[tauri::command]
pub async fn memory_vault() -> Result<MemoryVault, IpcError> {
    resolve()
}

/// Create the vault if it is absent, and explain itself in a README if it is empty.
/// Never overwrites: past the first write the folder is the person's.
#[tauri::command]
pub async fn memory_seed(vault: WirePath) -> Result<(), IpcError> {
    seed(&vault)
}

/// Count the notes. Runs when Settings opens, so it stats and never reads.
#[tauri::command]
pub async fn memory_stats(vault: WirePath) -> Result<MemoryStats, IpcError> {
    scan(&vault)
}

/// Show the vault in the OS file manager.
#[tauri::command]
pub async fn memory_reveal(vault: WirePath) -> Result<(), IpcError> {
    reveal(&vault)
}

// --- The work --------------------------------------------------------------

fn resolve() -> Result<MemoryVault, IpcError> {
    let home = home_dir()?;
    let file: ConfigFile = match fs::read_to_string(home.join(CONFIG_PATH)) {
        Ok(text) => serde_json::from_str(&text).unwrap_or(ConfigFile {
            vault: None,
            enabled: None,
        }),
        // A missing file is the normal case. A malformed one costs its override and nothing
        // else, which is what the sidecar does with the same file.
        Err(_) => ConfigFile {
            vault: None,
            enabled: None,
        },
    };

    let raw = match file.vault.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        Some(configured) => expand(configured, &home),
        None => home.join(DEFAULT_VAULT),
    };
    // Not replaced by the default when it will not normalize: the sidecar hands the raw
    // value to the SDK, so Settings would describe a folder nobody is writing to.
    let vault = WirePath::from_path(&raw).map_err(|err| {
        IpcError::new(
            ErrorCode::InvalidPath,
            format!(
                "{CONFIG_PATH} names a vault that is not an absolute path: {}. \
                 Use a full path or one starting with ~/.",
                err.message
            ),
        )
    })?;

    Ok(MemoryVault {
        vault,
        enabled: file.enabled.unwrap_or(true),
    })
}

fn seed(vault: &WirePath) -> Result<(), IpcError> {
    let dir = vault.to_path();
    fs::create_dir_all(&dir)
        .map_err(|err| IpcError::from_io(&err, format!("cannot create {vault}")))?;

    let mut entries = fs::read_dir(&dir)
        .map_err(|err| IpcError::from_io(&err, format!("cannot read {vault}")))?;
    if entries.next().is_some() {
        return Ok(());
    }

    fs::write(dir.join("README.md"), README)
        .map_err(|err| IpcError::from_io(&err, format!("cannot write {vault}/README.md")))
}

fn scan(vault: &WirePath) -> Result<MemoryStats, IpcError> {
    let dir = vault.to_path();
    if !dir.is_dir() {
        return Err(IpcError::new(
            ErrorCode::NotFound,
            format!("no vault at {vault}"),
        ));
    }

    let mut stats = MemoryStats::default();
    // The file tree's walker and ignore rules: a vault kept in git would otherwise have its
    // object store counted.
    let walk = WalkBuilder::new(&dir)
        .hidden(false)
        .require_git(false)
        .filter_entry(|entry| entry.depth() == 0 || !is_always_ignored(entry.path()))
        .build();

    for result in walk {
        let Ok(entry) = result else { continue };
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let is_note = entry
            .path()
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"));
        if !is_note {
            continue;
        }

        stats.notes += 1;
        if let Ok(meta) = entry.metadata() {
            stats.bytes += meta.len();
            if let Some(ms) = modified_ms(&meta) {
                stats.newest_ms = Some(stats.newest_ms.map_or(ms, |best: i64| best.max(ms)));
            }
        }
        if stats.notes as usize >= MAX_NOTES {
            break;
        }
    }
    Ok(stats)
}

fn reveal(vault: &WirePath) -> Result<(), IpcError> {
    #[cfg(windows)]
    let mut command = {
        let mut command = std::process::Command::new("explorer");
        command.arg(vault.to_path());
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(vault.to_path());
        command
    };
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(vault.to_path());
        command
    };

    // Spawned, never waited on: `explorer` exits 1 even when it opened the window, so only
    // a failure to start at all is worth reporting.
    command
        .spawn()
        .map(|_| ())
        .map_err(|err| IpcError::from_io(&err, format!("cannot open {vault}")))
}

fn home_dir() -> Result<PathBuf, IpcError> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| {
            IpcError::new(
                ErrorCode::NotFound,
                "no home directory: neither USERPROFILE nor HOME is set",
            )
        })
}

/// `~/thing` against the real home. The SDK understands the tilde; the filesystem does not,
/// and this path is used to create the folder as well as to configure the SDK.
fn expand(raw: &str, home: &Path) -> PathBuf {
    let slashed = raw.replace('\\', "/");
    if slashed == "~" {
        return home.to_path_buf();
    }
    // Only a leading `~/`, exactly as `memory-config.ts` does it: a `~` anywhere else is
    // part of a legitimate folder name.
    match slashed.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(slashed),
    }
}

fn modified_ms(meta: &fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|since| since.as_millis() as i64)
}

/// The first thing in a new vault. Short on purpose: the format it describes is the SDK's,
/// so detail here would go stale against a dependency.
const README: &str = "\
---
title: About this vault
---

# agentide's memory

This folder is where the coding agent keeps what it learns — a decision and the reason
for it, a constraint found the hard way, a fact about this machine. It writes here itself,
and every write stops for approval first, unless the session is running in Auto mode.

Notes are plain markdown with YAML frontmatter, and they link to each other with
`[[wikilinks]]`. That is also Obsidian's format, so this folder opens as a vault with no
conversion and no plugin — point Obsidian at it and the links render as a graph. Obsidian
is optional; without it this is still a folder of text files.

Edit anything here by hand. The agent reads what you write the same way it reads its own
notes, and deleting a note is how you make it forget something.

The location is `~/agentide-vault` by default. To move it, put a path in
`~/.agentide/memory.json`:

```json
{ \"vault\": \"D:/notes/agent\" }
```
";

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch directory that removes itself when the test ends.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let unique = std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock before epoch")
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("agentide-mem-{tag}-{unique}"));
            fs::create_dir_all(&dir).expect("cannot create scratch dir");
            Self(dir)
        }

        fn wire(&self, relative: &str) -> WirePath {
            WirePath::from_path(&self.0.join(relative)).expect("scratch path is not normalizable")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn seeding_a_missing_vault_creates_it_and_says_what_it_is_for() {
        let dir = TempDir::new("seed");
        let vault = dir.wire("vault");

        seed(&vault).expect("seed failed");

        let readme = fs::read_to_string(dir.0.join("vault/README.md")).expect("no README");
        assert!(readme.contains("[[wikilinks]]"), "the note format is the point");
        assert!(readme.contains("Auto mode"), "the one case with no prompt");
    }

    #[test]
    fn seeding_twice_leaves_the_second_readme_alone() {
        // Settings seeds on every open; rewriting would discard what the person put in it.
        let dir = TempDir::new("twice");
        let vault = dir.wire("vault");

        seed(&vault).expect("first seed failed");
        fs::write(dir.0.join("vault/README.md"), "mine now").expect("cannot edit README");
        seed(&vault).expect("second seed failed");

        assert_eq!(
            fs::read_to_string(dir.0.join("vault/README.md")).expect("no README"),
            "mine now"
        );
    }

    #[test]
    fn a_vault_with_notes_in_it_gets_no_readme_at_all() {
        // Pointing the config at an existing folder of notes must not add a file to it.
        let dir = TempDir::new("existing");
        fs::create_dir_all(dir.0.join("vault")).unwrap();
        fs::write(dir.0.join("vault/kept.md"), "# a note").unwrap();

        seed(&dir.wire("vault")).expect("seed failed");

        assert!(!dir.0.join("vault/README.md").exists());
    }

    #[test]
    fn counting_notes_ignores_everything_that_is_not_markdown() {
        let dir = TempDir::new("count");
        fs::create_dir_all(dir.0.join("vault/topics")).unwrap();
        fs::create_dir_all(dir.0.join("vault/.obsidian")).unwrap();
        fs::write(dir.0.join("vault/one.md"), "12345").unwrap();
        fs::write(dir.0.join("vault/topics/two.MD"), "1234567890").unwrap();
        // Obsidian state, a pasted image, and a directory ending in `.md`: none are notes.

        fs::write(dir.0.join("vault/.obsidian/workspace.json"), "{}").unwrap();
        fs::write(dir.0.join("vault/diagram.png"), [0u8; 40]).unwrap();
        fs::create_dir_all(dir.0.join("vault/not-a-note.md")).unwrap();

        let stats = scan(&dir.wire("vault")).expect("scan failed");
        assert_eq!(stats.notes, 2);
        assert_eq!(stats.bytes, 15, "only the notes are measured");
        assert!(stats.newest_ms.is_some());
    }

    #[test]
    fn an_empty_vault_counts_as_empty_rather_than_as_an_error() {
        let dir = TempDir::new("empty");
        let vault = dir.wire("vault");
        seed(&vault).expect("seed failed");
        fs::remove_file(dir.0.join("vault/README.md")).unwrap();

        let stats = scan(&vault).expect("scan failed");
        assert_eq!(stats.notes, 0);
        assert_eq!(stats.newest_ms, None);
    }

    #[test]
    fn a_vault_that_is_not_there_is_named_in_the_error() {
        let dir = TempDir::new("absent");

        let err = scan(&dir.wire("nowhere")).unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        assert!(err.message.contains("nowhere"));
    }

    #[test]
    fn a_tilde_path_resolves_against_home_and_a_plain_one_does_not() {
        let home = PathBuf::from("C:/Users/tung");

        assert_eq!(expand("~/vault", &home), home.join("vault"));
        assert_eq!(expand("~\\vault", &home), home.join("vault"));
        assert_eq!(expand("D:/notes", &home), PathBuf::from("D:/notes"));
        // A `~` in the middle is part of a name, not a home directory.
        assert_eq!(expand("D:/a~b", &home), PathBuf::from("D:/a~b"));
    }
}
