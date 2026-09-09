//! Workspace filesystem access and the change watcher. Every command takes and returns
//! [`WirePath`], so path normalization happens once, in `ipc.rs`, and never here.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::{DirEntry as WalkEntry, WalkBuilder};
use notify::event::{ModifyKind, RenameMode};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::ipc::Channel;
use tauri::State;

use crate::ipc::{
    DirEntry, DirListing, ErrorCode, FileContents, FileStat, FsChangeKind, FsEvent, IpcError,
    WirePath, Workspace,
};

/// Directories that never belong in the tree, whatever `.gitignore` says. `checkpoints.rs`
/// mirrors this into the shadow repo's `info/exclude` so the two cannot drift apart.
pub const ALWAYS_IGNORED: [&str; 5] = [".git", ".agentide", "node_modules", "target", "dist"];

/// Opening anything larger than this in the editor is a mistake, not a feature.
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// A save typically produces several OS notifications; collapse everything that lands
/// within this window into one event per path.
const DEBOUNCE: Duration = Duration::from_millis(120);

/// Flush regardless once this many paths are pending, so a `npm install` storm cannot
/// keep the debounce window open forever.
const MAX_PENDING: usize = 512;

/// The open workspace: its root and its live watcher, or `None` when none is open.
/// Replacing this value drops the watcher, which is all that closing a workspace takes.
#[derive(Default)]
pub struct WorkspaceState(Mutex<Option<Open>>);

struct Open {
    root: WirePath,
    /// Held only so that dropping it stops the watch; never read.
    _watcher: RecommendedWatcher,
}

impl WorkspaceState {
    /// The open workspace root, or `None`. Callers outside `fs.rs` use this instead of
    /// taking a root from the frontend on every call.
    pub fn root(&self) -> Option<WirePath> {
        let open = self.0.lock().expect("workspace state poisoned");
        open.as_ref().map(|open| open.root.clone())
    }
}

/// Open `path` as the workspace and start streaming its changes to `on_event`. The root
/// comes back canonicalized, so every path derived from it compares equal by string.
#[tauri::command]
pub async fn open_workspace(
    state: State<'_, WorkspaceState>,
    path: WirePath,
    on_event: Channel<Vec<FsEvent>>,
) -> Result<Workspace, IpcError> {
    let root = WirePath::canonical(&path.to_path())?;
    let root_path = root.to_path();
    if !root_path.is_dir() {
        return Err(IpcError::new(
            ErrorCode::NotFound,
            format!("not a directory: {root}"),
        ));
    }

    let filter = IgnoreFilter::new(&root_path);
    let (tx, rx) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |event| {
        // The receiver is gone once the watcher is dropped; nothing to do about it here.
        let _ = tx.send(event);
    })
    .map_err(|err| IpcError::new(ErrorCode::Watch, format!("cannot create watcher: {err}")))?;
    watcher
        .watch(&root_path, RecursiveMode::Recursive)
        .map_err(|err| IpcError::new(ErrorCode::Watch, format!("cannot watch {root}: {err}")))?;

    std::thread::Builder::new()
        .name("agentide-fs-watch".into())
        .spawn(move || forward_changes(rx, filter, on_event))
        .map_err(|err| {
            IpcError::new(ErrorCode::Watch, format!("cannot start watch thread: {err}"))
        })?;

    let name = root.file_name().to_string();
    *state.0.lock().expect("workspace state poisoned") = Some(Open {
        root: root.clone(),
        _watcher: watcher,
    });
    Ok(Workspace { root, name })
}

/// Stop watching. The tree keeps whatever it has already loaded.
#[tauri::command]
pub fn close_workspace(state: State<'_, WorkspaceState>) {
    *state.0.lock().expect("workspace state poisoned") = None;
}

/// One directory level, gitignore-aware. The tree calls this once per expansion.
#[tauri::command]
pub async fn list_dir(path: WirePath) -> Result<DirListing, IpcError> {
    let dir = path.to_path();
    if !dir.is_dir() {
        return Err(IpcError::new(
            ErrorCode::NotFound,
            format!("not a directory: {path}"),
        ));
    }

    let mut entries = Vec::new();
    let walk = WalkBuilder::new(&dir)
        .max_depth(Some(1))
        // Dotfiles are real files in an IDE; `.git` is handled by ALWAYS_IGNORED.
        .hidden(false)
        // Honor `.gitignore` even when the folder is not a git repository.
        .require_git(false)
        .filter_entry(|entry| entry.depth() == 0 || !is_always_ignored(entry.path()))
        .build();

    for result in walk {
        // Depth 0 is the directory itself. An unreadable child is skipped rather than
        // failing the whole listing.
        let Ok(entry) = result else { continue };
        if entry.depth() == 0 {
            continue;
        }
        entries.push(to_dir_entry(&entry)?);
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(DirListing { path, entries })
}

/// Every file in the workspace, for the quick-open palette: one capped walk, not lazy, since
/// the palette ranks the whole project per keystroke. Same ignore rules as the tree.
#[tauri::command]
pub async fn list_files(
    workspace: State<'_, WorkspaceState>,
    limit: Option<usize>,
) -> Result<Vec<WirePath>, IpcError> {
    let Some(root) = workspace.root() else {
        return Ok(Vec::new());
    };
    // A palette listing 200k files helps nobody; past the cap the answer is "narrow it".
    let cap = limit.unwrap_or(20_000).min(100_000);

    let mut files = Vec::new();
    let walk = WalkBuilder::new(root.to_path())
        .hidden(false)
        .require_git(false)
        .filter_entry(|entry| entry.depth() == 0 || !is_always_ignored(entry.path()))
        .build();

    for result in walk {
        let Ok(entry) = result else { continue };
        // Directories are not openable, so they are not offered.
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        if let Ok(path) = WirePath::from_path(entry.path()) {
            files.push(path);
        }
        if files.len() >= cap {
            break;
        }
    }
    Ok(files)
}

/// Read a text file for the editor. Rejects directories, oversized and non-UTF-8 files.
#[tauri::command]
pub async fn read_file(path: WirePath) -> Result<FileContents, IpcError> {
    let target = path.to_path();
    let meta = fs::metadata(&target)
        .map_err(|err| IpcError::from_io(&err, format!("cannot stat {path}")))?;
    if meta.is_dir() {
        return Err(IpcError::new(
            ErrorCode::IsDirectory,
            format!("{path} is a directory"),
        ));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(IpcError::new(
            ErrorCode::TooLarge,
            format!("{path} is {} bytes, limit is {MAX_FILE_BYTES}", meta.len()),
        ));
    }

    let bytes =
        fs::read(&target).map_err(|err| IpcError::from_io(&err, format!("cannot read {path}")))?;
    // A NUL byte in the first block is the same heuristic git uses for "binary".
    if bytes.iter().take(8000).any(|b| *b == 0) {
        return Err(IpcError::new(
            ErrorCode::NotUtf8,
            format!("{path} looks like a binary file"),
        ));
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| IpcError::new(ErrorCode::NotUtf8, format!("{path} is not valid UTF-8")))?;
    let had_bom = text.starts_with('\u{feff}');

    Ok(FileContents {
        text: if had_bom { text[3..].to_string() } else { text },
        size: meta.len(),
        modified_ms: modified_ms(&meta),
        had_bom,
        path,
    })
}

/// Write a text file, creating parent directories as needed. `bom` re-adds the byte-order
/// mark the file was read with; see [`FileContents`].
#[tauri::command]
pub async fn write_file(
    path: WirePath,
    contents: String,
    bom: Option<bool>,
) -> Result<FileStat, IpcError> {
    let target = path.to_path();
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| IpcError::from_io(&err, format!("cannot create {}", parent.display())))?;
    }

    let mut bytes = Vec::with_capacity(contents.len() + 3);
    if bom.unwrap_or(false) {
        bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    bytes.extend_from_slice(contents.as_bytes());
    fs::write(&target, &bytes)
        .map_err(|err| IpcError::from_io(&err, format!("cannot write {path}")))?;

    let meta = fs::metadata(&target)
        .map_err(|err| IpcError::from_io(&err, format!("cannot stat {path}")))?;
    Ok(FileStat {
        size: meta.len(),
        modified_ms: modified_ms(&meta),
        path,
    })
}

fn to_dir_entry(entry: &WalkEntry) -> Result<DirEntry, IpcError> {
    let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
    let meta = entry.metadata().ok();
    Ok(DirEntry {
        name: entry.file_name().to_string_lossy().into_owned(),
        path: WirePath::from_path(entry.path())?,
        is_dir,
        size: if is_dir {
            0
        } else {
            meta.as_ref().map_or(0, |m| m.len())
        },
        modified_ms: meta.as_ref().and_then(modified_ms),
    })
}

fn modified_ms(meta: &fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|since| since.as_millis() as u64)
}

pub(crate) fn is_always_ignored(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| ALWAYS_IGNORED.contains(&name))
}

/// Decides which watcher events are worth waking the frontend for: the root `.gitignore` plus
/// [`ALWAYS_IGNORED`]. Nested ignore files cost too much per event; the price is a stray refresh.
struct IgnoreFilter {
    root: PathBuf,
    gitignore: Gitignore,
}

impl IgnoreFilter {
    fn new(root: &Path) -> Self {
        let mut builder = GitignoreBuilder::new(root);
        // A missing or malformed `.gitignore` just means fewer things are filtered.
        let _ = builder.add(root.join(".gitignore"));
        Self {
            root: root.to_path_buf(),
            gitignore: builder.build().unwrap_or_else(|_| Gitignore::empty()),
        }
    }

    fn is_ignored(&self, path: &Path) -> bool {
        let Ok(relative) = path.strip_prefix(&self.root) else {
            // Not under the workspace: not something the tree can show.
            return true;
        };
        if relative.components().any(|component| {
            component
                .as_os_str()
                .to_str()
                .is_some_and(|name| ALWAYS_IGNORED.contains(&name))
        }) {
            return true;
        }
        // `is_dir` is false for a path just deleted, so directory-only patterns can miss.
        self.gitignore
            .matched_path_or_any_parents(path, path.is_dir())
            .is_ignore()
    }
}

/// Debounce, filter and batch watcher events onto the frontend channel.
/// Runs until the watcher is dropped or the webview goes away.
fn forward_changes(
    rx: Receiver<notify::Result<Event>>,
    filter: IgnoreFilter,
    channel: Channel<Vec<FsEvent>>,
) {
    let mut pending: HashMap<WirePath, FsChangeKind> = HashMap::new();
    let mut deadline: Option<Instant> = None;

    loop {
        let wait = match deadline {
            Some(at) => at.saturating_duration_since(Instant::now()),
            None => Duration::from_secs(1),
        };
        match rx.recv_timeout(wait) {
            Ok(Ok(event)) => {
                collect(&event, &filter, &mut pending);
                if deadline.is_none() {
                    deadline = Some(Instant::now() + DEBOUNCE);
                }
                if pending.len() < MAX_PENDING {
                    continue;
                }
            }
            // A dropped notification or a path that vanished mid-scan; keep watching.
            Ok(Err(_)) => continue,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                let _ = flush(&mut pending, &channel);
                return;
            }
        }

        deadline = None;
        if flush(&mut pending, &channel).is_err() {
            // The webview is gone; there is no one left to notify.
            return;
        }
    }
}

fn flush(
    pending: &mut HashMap<WirePath, FsChangeKind>,
    channel: &Channel<Vec<FsEvent>>,
) -> Result<(), tauri::Error> {
    if pending.is_empty() {
        return Ok(());
    }
    let batch = pending
        .drain()
        .map(|(path, kind)| FsEvent { kind, path })
        .collect();
    channel.send(batch)
}

fn collect(event: &Event, filter: &IgnoreFilter, pending: &mut HashMap<WirePath, FsChangeKind>) {
    use FsChangeKind::{Created, Modified, Removed};

    let kinds: &[FsChangeKind] = match &event.kind {
        EventKind::Create(_) => &[Created],
        EventKind::Remove(_) => &[Removed],
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => &[Removed],
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => &[Created],
        // A both-ends rename carries the old path first and the new path second.
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => &[Removed, Created],
        EventKind::Modify(_) | EventKind::Any => &[Modified],
        // Opening or reading a file is not a change.
        EventKind::Access(_) | EventKind::Other => return,
    };

    for (index, path) in event.paths.iter().enumerate() {
        if filter.is_ignored(path) {
            continue;
        }
        let Ok(wire) = WirePath::from_path(path) else {
            continue;
        };
        let kind = kinds[index.min(kinds.len() - 1)];
        pending
            .entry(wire)
            .and_modify(|slot| {
                // A create followed by writes is still a create as far as the tree cares.
                if !(*slot == Created && kind == Modified) {
                    *slot = kind;
                }
            })
            .or_insert(kind);
    }
}

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
            let dir = std::env::temp_dir().join(format!("agentide-{tag}-{unique}"));
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
    fn write_then_read_round_trips_text_and_bom() {
        let dir = TempDir::new("rw");
        let path = dir.wire("nested/note.txt");
        let text = "line one\r\nsecond \u{2014} dash\n";

        done(write_file(path.clone(), text.to_string(), None)).expect("write failed");
        let plain = done(read_file(path.clone())).expect("read failed");
        assert_eq!(plain.text, text);
        assert!(!plain.had_bom);

        done(write_file(path.clone(), text.to_string(), Some(true))).expect("write with bom failed");
        let with_bom = done(read_file(path)).expect("read failed");
        assert_eq!(with_bom.text, text, "the BOM must not reach the editor");
        assert!(with_bom.had_bom);
        assert_eq!(with_bom.size, plain.size + 3);
    }

    /// Run one of the async commands to completion. They are `async` so Tauri keeps them off
    /// the thread that draws -- `git add --all` there froze the window.

    fn done<T>(work: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(work)
    }
    #[test]
    fn listing_puts_directories_first_and_drops_ignored_entries() {
        let dir = TempDir::new("list");
        fs::create_dir_all(dir.0.join("src")).unwrap();
        fs::create_dir_all(dir.0.join("node_modules/pkg")).unwrap();
        fs::write(dir.0.join(".gitignore"), "*.log\n").unwrap();
        fs::write(dir.0.join("app.txt"), "hi").unwrap();
        fs::write(dir.0.join("Build.txt"), "hi").unwrap();
        fs::write(dir.0.join("debug.log"), "hi").unwrap();

        let listing = done(list_dir(dir.wire(""))).expect("list failed");
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["src", ".gitignore", "app.txt", "Build.txt"]);
        assert!(listing.entries[0].is_dir, "directories sort first");
        assert!(listing.entries[1].path.to_string().ends_with("/.gitignore"));
    }

    #[test]
    fn read_file_refuses_what_the_editor_cannot_show() {
        let dir = TempDir::new("refuse");
        fs::write(dir.0.join("image.bin"), [0x89, 0x50, 0x00, 0x01]).unwrap();

        assert_eq!(
            done(read_file(dir.wire("image.bin"))).unwrap_err().code,
            ErrorCode::NotUtf8
        );
        assert_eq!(
            done(read_file(dir.wire(""))).unwrap_err().code,
            ErrorCode::IsDirectory
        );
        assert_eq!(
            done(read_file(dir.wire("absent.txt"))).unwrap_err().code,
            ErrorCode::NotFound
        );
    }

    #[test]
    fn watcher_filter_skips_vendor_and_gitignored_paths() {
        let dir = TempDir::new("filter");
        fs::write(dir.0.join(".gitignore"), "*.log\nbuild/\n").unwrap();
        let filter = IgnoreFilter::new(&dir.0);

        assert!(!filter.is_ignored(&dir.0.join("src/main.rs")));
        assert!(filter.is_ignored(&dir.0.join("node_modules/pkg/index.js")));
        assert!(filter.is_ignored(&dir.0.join("src/target/debug/app.exe")));
        assert!(filter.is_ignored(&dir.0.join("logs/debug.log")));
        assert!(filter.is_ignored(&dir.0.join("build/out.txt")));
        assert!(filter.is_ignored(Path::new("C:/somewhere/else.txt")));
    }
}
