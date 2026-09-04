//! Checkpoints: the shadow git repository that makes every agent edit reversible.
//!
//! ## The mechanism
//!
//! A second, private git repository lives at `<root>/.agentide/checkpoints.git` with the
//! workspace itself as its work tree. Every command here runs as
//! `git --git-dir=<root>/.agentide/checkpoints.git --work-tree=<root> ...`, so the user's
//! own `.git`, index, history, stashes and hooks are never read and never written. That
//! separation is the whole point of the design: a checkpoint must be safe to take on
//! every prompt, in the middle of whatever the user was doing, and must never turn into
//! a commit they did not ask for.
//!
//! One commit before a turn is the only pre-image this module needs. Everything else is
//! a query against it:
//!
//! | Operation | How |
//! |---|---|
//! | revert one file | `git checkout <checkpoint> -- <path>` |
//! | revert some hunks | a subset of `git diff <checkpoint>`, reverse-applied |
//! | rewind the turn | `git read-tree -u --reset <checkpoint>` |
//!
//! ## Isolation
//!
//! `GIT_CONFIG_NOSYSTEM` plus a `GIT_CONFIG_GLOBAL` pointed at [`CONFIG_FILE`] mean the
//! user's git configuration cannot change how a checkpoint is taken or restored: no
//! `autocrlf` mangling line endings on the way back out, no `core.hooksPath` running
//! their pre-commit hook, no signing key, no global excludes file quietly dropping files
//! from the checkpoint. `info/attributes` does the same for in-tree `.gitattributes`,
//! which has no environment override -- `* -text -filter` there outranks a `* text=auto`
//! in the workspace, so a CRLF file comes back with its CRLFs.
//!
//! ## What is not checkpointed
//!
//! The workspace's own `.gitignore` is honored, and on top of it the shadow repo's
//! `info/exclude` names [`crate::fs::ALWAYS_IGNORED`] -- `.git`, `.agentide`,
//! `node_modules`, `target`, `dist`. Committing the user's real git directory into the
//! shadow repo would be a disaster, and the same list is what the file tree hides, so
//! "not in the tree" and "not in a checkpoint" cannot drift apart. A file the ignore
//! rules skip is never captured, and therefore never restored and never deleted.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf, MAIN_SEPARATOR_STR};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::Mutex;

use tauri::State;

use crate::fs::{WorkspaceState, ALWAYS_IGNORED};
use crate::ipc::{
    Checkpoint, CheckpointDiff, DiffFile, ErrorCode, FileChange, FileHunks, Hunk, IpcError,
    Omitted, RevertAction, RevertOutcome, RewindResult, WirePath,
};

/// The shadow repository, relative to the workspace root.
const REPO_DIR: &str = ".agentide/checkpoints.git";

/// The only configuration file the shadow repository reads. See the module docs.
const CONFIG_FILE: &str = ".agentide/git-config";

/// Per side, per file. Monaco is handed both texts at once, so a file over this is worth
/// naming in the queue but not worth shipping through the IPC boundary.
const MAX_DIFF_BYTES: u64 = 2 * 1024 * 1024;

/// Across one [`checkpoint_diff`]. A rewind-sized diff can name thousands of files;
/// past this the rest arrive as [`Omitted::Budget`] and the queue fetches them one at a
/// time with [`checkpoint_file_diff`].
const MAX_DIFF_TOTAL_BYTES: u64 = 24 * 1024 * 1024;

/// Context lines in the patches used for per-hunk revert. Three is git's default and the
/// number `git apply` is happiest re-finding a shifted hunk with.
const CONTEXT_LINES: &str = "3";

/// Serializes every checkpoint operation.
///
/// Tauri runs commands on a thread pool, so two invokes really do overlap; they would
/// then meet on one `index.lock`, which git fails on rather than waits for. A checkpoint
/// is a few hundred milliseconds, so queuing is cheaper than a lost turn.
static GIT: Mutex<()> = Mutex::new(());

// ---------------------------------------------------------------------------
// The repository
// ---------------------------------------------------------------------------

/// A handle on one workspace's shadow repository, created and repaired on demand.
struct Repo {
    /// The work tree, and the cwd every git process runs in.
    root: WirePath,
    /// Native path to the work tree, for `std::fs`.
    dir: PathBuf,
    /// `--git-dir`, slash-separated: git takes forward slashes on Windows, and passing
    /// them avoids escaping backslashes into the config file as well.
    git_dir: String,
    config: String,
}

impl Repo {
    /// Open the shadow repository of the workspace that is currently open.
    fn open(workspace: &WorkspaceState) -> Result<Self, IpcError> {
        let root = workspace.root().ok_or_else(|| {
            IpcError::new(
                ErrorCode::Checkpoint,
                "open a folder before using checkpoints: there is nothing to snapshot",
            )
        })?;
        Self::at(&root)
    }

    /// Open -- creating and repairing as needed -- the shadow repository under `root`.
    ///
    /// Idempotent and cheap: the config, exclude and attributes files are rewritten on
    /// every call so a version of this app that changes them fixes existing workspaces,
    /// and `git init` runs only when there is no repository yet.
    fn at(root: &WirePath) -> Result<Self, IpcError> {
        let dir = root.to_path();
        let repo = Self {
            root: root.clone(),
            git_dir: under(root, REPO_DIR),
            config: under(root, CONFIG_FILE),
            dir,
        };

        let config_path = repo.dir.join(".agentide").join("git-config");
        write_if_changed(&config_path, &config_text(&repo.git_dir))?;

        let git_dir = repo.dir.join(".agentide").join("checkpoints.git");
        if !git_dir.join("HEAD").is_file() {
            repo.run(&["init", "--quiet"])?;
        }
        let info = git_dir.join("info");
        std::fs::create_dir_all(&info)
            .map_err(|err| IpcError::from_io(&err, format!("cannot create {}", info.display())))?;
        write_if_changed(&info.join("exclude"), &exclude_text())?;
        // Outranks any `.gitattributes` in the workspace, which is what keeps a restored
        // file byte-identical to the one that was checkpointed.
        write_if_changed(&info.join("attributes"), "* -text -filter -ident\n")?;
        Ok(repo)
    }

    /// A git invocation against this repository, isolated from the user's git setup.
    fn git(&self) -> Command {
        let mut command = Command::new("git");
        command
            .current_dir(&self.dir)
            .arg("--git-dir")
            .arg(&self.git_dir)
            .arg("--work-tree")
            .arg(self.root.to_string())
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", &self.config)
            // No local operation needs credentials; without this one that thinks it does
            // would block on a prompt nobody can answer.
            .env("GIT_TERMINAL_PROMPT", "0")
            // Only affects translated messages, and this module reads some of them.
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Whatever the parent process was launched from must not redirect us at the
        // user's repository or override the identity on our commits.
        for name in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_COMMON_DIR",
            "GIT_OBJECT_DIRECTORY",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            "GIT_CONFIG",
            "GIT_AUTHOR_NAME",
            "GIT_AUTHOR_EMAIL",
            "GIT_AUTHOR_DATE",
            "GIT_COMMITTER_NAME",
            "GIT_COMMITTER_EMAIL",
            "GIT_COMMITTER_DATE",
        ] {
            command.env_remove(name);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            /// Without this a console window flashes up behind the app on every git call.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        command
    }

    /// Run git, capturing stdout. A non-zero exit becomes an [`IpcError`] carrying the
    /// tail of stderr, which is the only part of a git failure worth showing.
    fn run(&self, args: &[&str]) -> Result<Vec<u8>, IpcError> {
        let run = self.run_raw(args, None)?;
        if !run.status.success() {
            return Err(failed(args, &run));
        }
        Ok(run.stdout)
    }

    /// Run git and hand back the exit status instead of failing on it, for the calls
    /// whose answer *is* the status -- `check-ignore`, `rev-parse --verify`.
    fn run_status(&self, args: &[&str]) -> Result<Run, IpcError> {
        self.run_raw(args, None)
    }

    fn run_raw(&self, args: &[&str], input: Option<Vec<u8>>) -> Result<Run, IpcError> {
        let mut command = self.git();
        command.args(args);
        if input.is_some() {
            command.stdin(Stdio::piped());
        }
        let mut child = command.spawn().map_err(|err| {
            IpcError::new(
                ErrorCode::Checkpoint,
                format!("cannot run git: {err}; checkpoints need git on the PATH"),
            )
        })?;
        if let Some(bytes) = input {
            // Written from another thread because git may be producing output at the
            // same time: with both pipes full and one thread, neither side can move.
            // git exiting early (a patch that does not apply) closes the pipe, and a
            // broken pipe here is not something to report -- the exit status is.
            let mut stdin = child.stdin.take().expect("piped stdin");
            std::thread::spawn(move || {
                let _ = stdin.write_all(&bytes);
            });
        }
        let output = child
            .wait_with_output()
            .map_err(|err| IpcError::from_io(&err, "cannot read git output"))?;
        Ok(Run {
            status: output.status,
            stdout: output.stdout,
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        })
    }

    /// The newest checkpoint, or `None` when none has been taken yet.
    fn head(&self) -> Result<Option<String>, IpcError> {
        let run = self.run_status(&["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])?;
        if !run.status.success() {
            return Ok(None);
        }
        Ok(Some(text(run.stdout)?.trim().to_string()))
    }

    /// Turn a checkpoint id from the frontend into a full commit hash.
    ///
    /// Rejects anything that is not hexadecimal before it reaches git, so a checkpoint id
    /// can never arrive as `--upload-pack=...` or as a revision expression that reaches
    /// past the timeline.
    fn resolve(&self, id: &str) -> Result<String, IpcError> {
        let looks_like_a_hash =
            (4..=40).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_hexdigit());
        if !looks_like_a_hash {
            return Err(IpcError::new(
                ErrorCode::Checkpoint,
                format!("{id:?} is not a checkpoint id"),
            ));
        }
        let spec = format!("{id}^{{commit}}");
        let run = self.run_status(&["rev-parse", "--verify", "--quiet", &spec])?;
        if !run.status.success() {
            return Err(IpcError::new(
                ErrorCode::Stale,
                format!("checkpoint {id} is not in this workspace's timeline"),
            ));
        }
        Ok(text(run.stdout)?.trim().to_string())
    }

    /// Stage the whole work tree.
    ///
    /// Every comparison against the working tree runs this first: a file the agent
    /// created is untracked until it does, and `git diff <commit>` does not report
    /// untracked files. It is also the expensive half of taking a checkpoint -- one stat
    /// per tracked file, and a full hash of anything whose stat changed.
    fn stage(&self) -> Result<(), IpcError> {
        self.run(&["add", "--all"])?;
        Ok(())
    }

    /// Absolute path of a work-tree-relative path, for the wire.
    fn absolute(&self, relative: &str) -> Result<WirePath, IpcError> {
        WirePath::parse(&under(&self.root, relative))
    }

    /// Work-tree-relative, `/`-separated -- the shape git pathspecs want.
    ///
    /// Windows compares paths case-insensitively, and a path that reached the frontend
    /// through the editor may not carry the case the workspace root was opened with.
    fn relative(&self, path: &WirePath) -> Result<String, IpcError> {
        let root = self.root.to_string();
        let prefix = if root.ends_with('/') {
            root
        } else {
            format!("{root}/")
        };
        let full = path.to_string();
        let inside = if cfg!(windows) {
            full.len() > prefix.len() && full[..prefix.len()].eq_ignore_ascii_case(&prefix)
        } else {
            full.starts_with(&prefix)
        };
        if !inside {
            return Err(IpcError::new(
                ErrorCode::Checkpoint,
                format!("{path} is outside the workspace"),
            ));
        }
        Ok(full[prefix.len()..].to_string())
    }
}

struct Run {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: String,
}

fn failed(args: &[&str], run: &Run) -> IpcError {
    let what = args.first().copied().unwrap_or("git");
    let why = if run.stderr.is_empty() {
        format!("exited with {}", run.status)
    } else {
        run.stderr.clone()
    };
    IpcError::new(ErrorCode::Checkpoint, format!("git {what}: {why}"))
}

fn text(bytes: Vec<u8>) -> Result<String, IpcError> {
    String::from_utf8(bytes)
        .map_err(|_| IpcError::new(ErrorCode::Checkpoint, "git produced output that is not UTF-8"))
}

/// Join a workspace-relative path onto a root that may or may not end in `/`.
fn under(root: &WirePath, rest: &str) -> String {
    let root = root.to_string();
    if root.ends_with('/') {
        format!("{root}{rest}")
    } else {
        format!("{root}/{rest}")
    }
}

/// Write only when the contents differ, so the workspace watcher is not woken by a
/// checkpoint rewriting files that already say what they should.
fn write_if_changed(path: &Path, contents: &str) -> Result<(), IpcError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| {
            IpcError::from_io(&err, format!("cannot create {}", parent.display()))
        })?;
    }
    if std::fs::read_to_string(path).is_ok_and(|current| current == contents) {
        return Ok(());
    }
    std::fs::write(path, contents)
        .map_err(|err| IpcError::from_io(&err, format!("cannot write {}", path.display())))
}

fn config_text(git_dir: &str) -> String {
    format!(
        "# Written by agentide; edits here are overwritten.\n\
         #\n\
         # The shadow checkpoint repository reads this file and nothing else:\n\
         # GIT_CONFIG_NOSYSTEM is set and GIT_CONFIG_GLOBAL points here, so the user's\n\
         # own git configuration cannot change how a checkpoint is taken or restored.\n\
         [user]\n\
         \tname = agentide\n\
         \temail = checkpoints@agentide.local\n\
         [init]\n\
         \tdefaultBranch = checkpoints\n\
         [core]\n\
         \tautocrlf = false\n\
         \tsafecrlf = false\n\
         \tlongpaths = true\n\
         \tquotePath = false\n\
         \thooksPath = \"{git_dir}/hooks\"\n\
         \texcludesFile = \"{git_dir}/info/no-global-excludes\"\n\
         [commit]\n\
         \tgpgSign = false\n\
         [advice]\n\
         \taddEmbeddedRepo = false\n\
         \tdetachedHead = false\n\
         [safe]\n\
         \tdirectory = *\n"
    )
}

fn exclude_text() -> String {
    let mut text = String::from(
        "# Written by agentide; edits here are overwritten.\n\
         #\n\
         # On top of the workspace's own .gitignore. `.git` keeps the user's real\n\
         # repository out of the shadow one; `.agentide` keeps the shadow repository out\n\
         # of itself. The rest match the directories the file tree hides.\n",
    );
    for name in ALWAYS_IGNORED {
        text.push_str(name);
        text.push('\n');
    }
    text
}

// ---------------------------------------------------------------------------
// Taking and listing checkpoints
// ---------------------------------------------------------------------------

/// Commit the work tree. Always commits, even when nothing changed, so that a turn
/// always has an id to rewind to.
fn take(repo: &Repo, label: &str) -> Result<Checkpoint, IpcError> {
    repo.stage()?;
    repo.run(&[
        "commit",
        "--quiet",
        "--allow-empty",
        "--no-verify",
        "-m",
        &subject(label),
    ])?;
    let mut entries = log(repo, 1)?;
    entries.pop().ok_or_else(|| {
        IpcError::new(
            ErrorCode::Checkpoint,
            "the checkpoint commit did not appear in the timeline",
        )
    })
}

/// One line, no control characters, bounded -- git commit subjects are one line whether
/// or not the label was, and `%s` has to read back what went in.
fn subject(label: &str) -> String {
    let mut cleaned: String = label
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() {
        return "Checkpoint".to_string();
    }
    if cleaned.chars().count() > 200 {
        cleaned = cleaned.chars().take(200).collect();
    }
    cleaned
}

/// Record and field separators for the `git log` format below: control characters, so
/// [`subject`] has already removed them from anything a caller supplied.
const RECORD: char = '\u{1e}';
const FIELD: char = '\u{1f}';

/// The newest `limit` checkpoints, each with its diff against the one before it.
///
/// One git process regardless of how many checkpoints are asked for: `--numstat` yields
/// the per-commit file counts in the same pass, which is why this is not a loop of
/// `git diff` calls.
fn log(repo: &Repo, limit: u32) -> Result<Vec<Checkpoint>, IpcError> {
    if repo.head()?.is_none() {
        return Ok(Vec::new());
    }
    let format = format!("--format={RECORD}%H{FIELD}%ct{FIELD}%P{FIELD}%s");
    let count = format!("-{limit}");
    let raw = text(repo.run(&[
        "log",
        &count,
        &format,
        "--numstat",
        "-z",
        "--no-renames",
        "--no-ext-diff",
    ])?)?;

    let mut checkpoints = Vec::new();
    for record in raw.split(RECORD).skip(1) {
        // `-z` terminates the formatted header with a NUL; the numstat records follow it,
        // NUL-terminated in their turn.
        let (header, body) = record.split_once('\0').unwrap_or((record, ""));
        let mut fields = header.split(FIELD);
        let (Some(id), Some(seconds), Some(parents), Some(label)) = (
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
        ) else {
            continue;
        };
        let mut files_changed = 0;
        let mut added = 0;
        let mut removed = 0;
        for entry in body.split('\0').filter(|entry| !entry.trim().is_empty()) {
            let mut parts = entry.trim_start_matches('\n').splitn(3, '\t');
            let plus = parts.next().unwrap_or("");
            let minus = parts.next().unwrap_or("");
            if parts.next().is_none() {
                continue;
            }
            files_changed += 1;
            // A binary file counts as changed but reports its lines as `-`.
            added += plus.parse::<u32>().unwrap_or(0);
            removed += minus.parse::<u32>().unwrap_or(0);
        }
        checkpoints.push(Checkpoint {
            short_id: id.chars().take(7).collect(),
            id: id.to_string(),
            created_ms: seconds.parse::<u64>().unwrap_or(0) * 1000,
            label: label.to_string(),
            parent: parents.split_whitespace().next().map(str::to_string),
            files_changed,
            added,
            removed,
        });
    }
    Ok(checkpoints)
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

/// One entry of `git diff --raw`: what happened to a path, and the blobs on either side.
struct RawEntry {
    status: FileChange,
    path: String,
    before: Option<String>,
    after: Option<String>,
}

const NULL_OID: &str = "0000000000000000000000000000000000000000";

/// The changed paths between two trees, or between a tree and the working tree.
///
/// `--raw` carries the blob ids, which is what lets the contents be fetched by object id
/// rather than by path -- no quoting, no ambiguity, and one `cat-file` process for the
/// whole diff however many files it names.
fn raw_diff(repo: &Repo, from: &str, to: Option<&str>, path: Option<&str>) -> Result<Vec<RawEntry>, IpcError> {
    let mut args = vec![
        "diff",
        "--raw",
        "-z",
        "--no-abbrev",
        "--no-renames",
        "--no-ext-diff",
        from,
    ];
    if let Some(to) = to {
        args.push(to);
    }
    if let Some(path) = path {
        args.push("--");
        args.push(path);
    }
    let raw = text(repo.run(&args)?)?;

    let mut entries = Vec::new();
    let mut fields = raw.split('\0');
    while let Some(meta) = fields.next() {
        let Some(meta) = meta.strip_prefix(':') else {
            continue;
        };
        let Some(path) = fields.next() else { break };
        // `<srcmode> <dstmode> <srcsha> <dstsha> <status>`
        let parts: Vec<&str> = meta.split_whitespace().collect();
        if parts.len() < 5 || path.is_empty() {
            continue;
        }
        let status = match parts[4].chars().next() {
            Some('A') => FileChange::Added,
            Some('D') => FileChange::Deleted,
            _ => FileChange::Modified,
        };
        entries.push(RawEntry {
            status,
            path: path.to_string(),
            before: oid(parts[2]),
            after: oid(parts[3]),
        });
    }
    Ok(entries)
}

/// A blob id, or `None` for the all-zero id -- which means either "not on this side" or,
/// for the working tree, "only on disk".
fn oid(raw: &str) -> Option<String> {
    (raw != NULL_OID && raw.len() == NULL_OID.len()).then(|| raw.to_string())
}

/// Per-path line counts. `-\t-` marks a file git considers binary, which is the same
/// NUL-byte heuristic `read_file` uses, applied to both sides at once.
fn numstat(repo: &Repo, from: &str, to: Option<&str>, path: Option<&str>) -> Result<HashMap<String, (u32, u32, bool)>, IpcError> {
    let mut args = vec![
        "diff",
        "--numstat",
        "-z",
        "--no-renames",
        "--no-ext-diff",
        from,
    ];
    if let Some(to) = to {
        args.push(to);
    }
    if let Some(path) = path {
        args.push("--");
        args.push(path);
    }
    let raw = text(repo.run(&args)?)?;

    let mut counts = HashMap::new();
    for entry in raw.split('\0').filter(|entry| !entry.is_empty()) {
        let mut parts = entry.splitn(3, '\t');
        let (Some(plus), Some(minus), Some(path)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let binary = plus == "-" && minus == "-";
        counts.insert(
            path.to_string(),
            (
                plus.parse().unwrap_or(0),
                minus.parse().unwrap_or(0),
                binary,
            ),
        );
    }
    Ok(counts)
}

/// Sizes of the named blobs, in one git process.
fn blob_sizes(repo: &Repo, oids: &[String]) -> Result<HashMap<String, u64>, IpcError> {
    let mut sizes = HashMap::new();
    if oids.is_empty() {
        return Ok(sizes);
    }
    let run = repo.run_raw(&["cat-file", "--batch-check", "-z"], Some(specs(oids)))?;
    if !run.status.success() {
        return Err(failed(&["cat-file"], &run));
    }
    for line in text(run.stdout)?.lines() {
        // `<oid> <type> <size>`, or `<oid> missing` for one we asked for wrongly.
        let mut parts = line.split_whitespace();
        let (Some(id), Some(kind), Some(size)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        if kind == "blob" {
            sizes.insert(id.to_string(), size.parse().unwrap_or(u64::MAX));
        }
    }
    Ok(sizes)
}

/// Contents of the named blobs, in one git process.
fn blob_contents(repo: &Repo, oids: &[String]) -> Result<HashMap<String, Vec<u8>>, IpcError> {
    let mut blobs = HashMap::new();
    if oids.is_empty() {
        return Ok(blobs);
    }
    let run = repo.run_raw(&["cat-file", "--batch", "-z"], Some(specs(oids)))?;
    if !run.status.success() {
        return Err(failed(&["cat-file"], &run));
    }
    // `<oid> <type> <size>\n<size bytes>\n`, one record per id, in the order asked.
    let out = run.stdout;
    let mut at = 0;
    while at < out.len() {
        let Some(end) = out[at..].iter().position(|b| *b == b'\n') else {
            break;
        };
        let header = String::from_utf8_lossy(&out[at..at + end]).to_string();
        at += end + 1;
        let mut parts = header.split_whitespace();
        let (Some(id), Some(_kind), Some(size)) = (parts.next(), parts.next(), parts.next()) else {
            // `<oid> missing`: no body follows, so the cursor is already past it.
            continue;
        };
        let size: usize = size.parse().unwrap_or(0);
        let stop = (at + size).min(out.len());
        blobs.insert(id.to_string(), out[at..stop].to_vec());
        // The body is followed by a newline git added, which is not part of the blob.
        at = stop + 1;
    }
    Ok(blobs)
}

fn specs(oids: &[String]) -> Vec<u8> {
    let mut input = Vec::new();
    for oid in oids {
        input.extend_from_slice(oid.as_bytes());
        input.push(0);
    }
    input
}

/// Assemble the diff the queue renders.
///
/// `to` is `None` for the working tree, which is the case the diff queue lives on: what
/// has changed on disk since the turn began.
fn diff(
    repo: &Repo,
    from: &str,
    to: Option<&str>,
    path: Option<&str>,
    budget: u64,
) -> Result<Vec<DiffFile>, IpcError> {
    if to.is_none() {
        repo.stage()?;
    }
    let entries = raw_diff(repo, from, to, path)?;
    let counts = numstat(repo, from, to, path)?;

    // Decide what to fetch before fetching any of it: two git calls serve the whole
    // diff, so the sizes have to be known first.
    let mut wanted: Vec<String> = Vec::new();
    for entry in &entries {
        let binary = counts.get(&entry.path).is_some_and(|(_, _, bin)| *bin);
        if binary {
            continue;
        }
        for oid in [&entry.before, &entry.after].into_iter().flatten() {
            wanted.push(oid.clone());
        }
    }
    wanted.sort();
    wanted.dedup();
    let sizes = blob_sizes(repo, &wanted)?;

    let mut fetch: Vec<String> = Vec::new();
    let mut plan: Vec<Option<Omitted>> = Vec::new();
    let mut spent: u64 = 0;
    for entry in &entries {
        let binary = counts.get(&entry.path).is_some_and(|(_, _, bin)| *bin);
        let before_size = entry.before.as_ref().and_then(|oid| sizes.get(oid).copied());
        let after_size = match to {
            Some(_) => entry.after.as_ref().and_then(|oid| sizes.get(oid).copied()),
            // The working-tree side is on disk, not in the object database.
            None => match entry.status {
                FileChange::Deleted => None,
                _ => std::fs::metadata(native(repo, &entry.path))
                    .ok()
                    .map(|meta| meta.len()),
            },
        };
        let bytes = before_size.unwrap_or(0) + after_size.unwrap_or(0);

        let omitted = if binary {
            Some(Omitted::Binary)
        } else if [before_size, after_size]
            .into_iter()
            .flatten()
            .any(|size| size > MAX_DIFF_BYTES)
        {
            Some(Omitted::TooLarge)
        } else if spent + bytes > budget {
            Some(Omitted::Budget)
        } else {
            spent += bytes;
            if let Some(before) = &entry.before {
                fetch.push(before.clone());
            }
            if let (Some(_), Some(after)) = (to, &entry.after) {
                fetch.push(after.clone());
            }
            None
        };
        plan.push(omitted);
    }
    fetch.sort();
    fetch.dedup();
    let blobs = blob_contents(repo, &fetch)?;

    let mut files = Vec::with_capacity(entries.len());
    for (entry, mut omitted) in entries.iter().zip(plan) {
        let (added, removed, binary) = counts.get(&entry.path).copied().unwrap_or((0, 0, false));
        let mut before = None;
        let mut after = None;
        if omitted.is_none() {
            let before_bytes = entry.before.as_ref().and_then(|oid| blobs.get(oid).cloned());
            let after_bytes = match to {
                Some(_) => entry.after.as_ref().and_then(|oid| blobs.get(oid).cloned()),
                // Read from disk rather than from the index this diff staged: the file is
                // the thing the editor is about to show.
                None => match entry.status {
                    FileChange::Deleted => None,
                    _ => std::fs::read(native(repo, &entry.path)).ok(),
                },
            };
            match (decode(before_bytes), decode(after_bytes)) {
                (Some(left), Some(right)) => (before, after) = (left, right),
                _ => omitted = Some(Omitted::NotUtf8),
            }
        }
        files.push(DiffFile {
            path: repo.absolute(&entry.path)?,
            relative: entry.path.clone(),
            status: entry.status,
            added,
            removed,
            binary,
            before,
            after,
            omitted,
        });
    }
    Ok(files)
}

/// A work-tree-relative git path as a path `std::fs` will take.
fn native(repo: &Repo, relative: &str) -> PathBuf {
    repo.dir.join(relative.replace('/', MAIN_SEPARATOR_STR))
}

/// `Some(None)` is "this side does not exist", `None` is "these bytes are not text".
fn decode(bytes: Option<Vec<u8>>) -> Option<Option<String>> {
    match bytes {
        None => Some(None),
        Some(bytes) => String::from_utf8(bytes).ok().map(Some),
    }
}

// ---------------------------------------------------------------------------
// Hunks
//
// Per-hunk revert is a round trip through `git apply -R`: the patch is generated fresh
// from the file as it is right now, the caller's selection picks hunks out of it by id,
// and git applies the subset in reverse. Nothing is reconstructed by hand, so a hunk
// that no longer describes the file cannot half-apply -- `git apply` builds the whole
// result before writing anything and fails without touching the file.
// ---------------------------------------------------------------------------

/// A parsed patch for one file: the `diff --git` preamble, then the hunks.
struct Patch {
    header: String,
    hunks: Vec<ParsedHunk>,
    binary: bool,
}

struct ParsedHunk {
    id: String,
    header: String,
    body: String,
    old_start: u32,
    old_lines: u32,
    new_start: u32,
    new_lines: u32,
    added: u32,
    removed: u32,
}

/// `git diff` for one file, against the working tree.
fn file_patch(repo: &Repo, from: &str, relative: &str) -> Result<Patch, IpcError> {
    repo.stage()?;
    let unified = format!("--unified={CONTEXT_LINES}");
    let raw = text(repo.run(&[
        "diff",
        &unified,
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        from,
        "--",
        relative,
    ])?)?;
    Ok(parse_patch(&raw))
}

fn parse_patch(raw: &str) -> Patch {
    let mut header = String::new();
    let mut hunks: Vec<ParsedHunk> = Vec::new();
    let mut binary = false;

    for line in raw.split_inclusive('\n') {
        if line.starts_with("@@") {
            let (old_start, old_lines, new_start, new_lines) = parse_hunk_header(line);
            hunks.push(ParsedHunk {
                id: String::new(),
                header: line.trim_end_matches(['\r', '\n']).to_string(),
                body: String::new(),
                old_start,
                old_lines,
                new_start,
                new_lines,
                added: 0,
                removed: 0,
            });
            continue;
        }
        match hunks.last_mut() {
            None => {
                if line.starts_with("Binary files") || line.starts_with("GIT binary patch") {
                    binary = true;
                }
                header.push_str(line);
            }
            Some(hunk) => {
                match line.as_bytes().first() {
                    Some(b'+') => hunk.added += 1,
                    Some(b'-') => hunk.removed += 1,
                    // ` ` is context and `\` is the no-newline marker; both belong to the
                    // hunk and both have to survive into the patch that gets applied.
                    Some(b' ') | Some(b'\\') => {}
                    _ => continue,
                }
                hunk.body.push_str(line);
            }
        }
    }

    // The id is a hash of the hunk's own lines and nothing else, so a hunk that only
    // moved -- because an earlier hunk was reverted, or because the user typed above it
    // -- keeps the id the frontend is holding. The suffix disambiguates a file that
    // contains the same change twice.
    let mut seen: HashMap<u64, u32> = HashMap::new();
    for hunk in &mut hunks {
        let hash = fnv1a(hunk.body.as_bytes());
        let ordinal = seen.entry(hash).or_default();
        hunk.id = format!("{hash:016x}-{ordinal}");
        *ordinal += 1;
    }
    Patch {
        header,
        hunks,
        binary,
    }
}

/// `@@ -12,7 +12,9 @@ context` -> `(12, 7, 12, 9)`. A missing count means one line.
fn parse_hunk_header(line: &str) -> (u32, u32, u32, u32) {
    let mut old = (0, 1);
    let mut new = (0, 1);
    for field in line.split(['@', ' ']).filter(|f| !f.is_empty()) {
        let (target, digits) = match field.as_bytes()[0] {
            b'-' => (&mut old, &field[1..]),
            b'+' => (&mut new, &field[1..]),
            _ => continue,
        };
        let mut parts = digits.split(',');
        target.0 = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
        target.1 = parts.next().and_then(|n| n.parse().ok()).unwrap_or(1);
    }
    (old.0, old.1, new.0, new.1)
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Take a checkpoint of the whole work tree. Called before a turn begins.
///
/// Always produces a commit, even when nothing changed since the last one, so a turn
/// always has an id of its own to be rewound to.
#[tauri::command]
pub fn checkpoint_create(
    workspace: State<'_, WorkspaceState>,
    label: Option<String>,
) -> Result<Checkpoint, IpcError> {
    let _guard = lock();
    let repo = Repo::open(&workspace)?;
    take(&repo, label.as_deref().unwrap_or(""))
}

/// The timeline, newest first. `limit` defaults to 50.
#[tauri::command]
pub fn checkpoint_list(
    workspace: State<'_, WorkspaceState>,
    limit: Option<u32>,
) -> Result<Vec<Checkpoint>, IpcError> {
    let _guard = lock();
    let repo = Repo::open(&workspace)?;
    log(&repo, limit.unwrap_or(50).clamp(1, 1000))
}

/// What changed between a checkpoint and the working tree, or between two checkpoints.
///
/// Contents are withheld -- with [`DiffFile::omitted`] saying why -- for binary files,
/// for files over 2 MiB a side, and for whatever falls past the payload budget once a
/// diff runs to tens of megabytes. Fetch those one at a time with [`checkpoint_file_diff`].
#[tauri::command]
pub fn checkpoint_diff(
    workspace: State<'_, WorkspaceState>,
    from: String,
    to: Option<String>,
) -> Result<CheckpointDiff, IpcError> {
    let _guard = lock();
    let repo = Repo::open(&workspace)?;
    let from = repo.resolve(&from)?;
    let to = to.map(|to| repo.resolve(&to)).transpose()?;
    let files = diff(&repo, &from, to.as_deref(), None, MAX_DIFF_TOTAL_BYTES)?;
    Ok(CheckpointDiff { from, to, files })
}

/// One file's before and after, for re-reading a row after a revert -- or for one the
/// bulk diff left out because of its budget.
#[tauri::command]
pub fn checkpoint_file_diff(
    workspace: State<'_, WorkspaceState>,
    from: String,
    to: Option<String>,
    path: WirePath,
) -> Result<Option<DiffFile>, IpcError> {
    let _guard = lock();
    let repo = Repo::open(&workspace)?;
    let from = repo.resolve(&from)?;
    let to = to.map(|to| repo.resolve(&to)).transpose()?;
    let relative = repo.relative(&path)?;
    let mut files = diff(&repo, &from, to.as_deref(), Some(&relative), u64::MAX)?;
    Ok(files.pop())
}

/// The hunks of one file's changes since a checkpoint, in the working tree.
///
/// The ids are what [`checkpoint_revert_hunks`] takes. They are a hash of the hunk's own
/// lines, so they survive the file moving underneath them; they do not survive the hunk
/// itself being edited, and that is the point.
#[tauri::command]
pub fn checkpoint_hunks(
    workspace: State<'_, WorkspaceState>,
    checkpoint: String,
    path: WirePath,
) -> Result<FileHunks, IpcError> {
    let _guard = lock();
    let repo = Repo::open(&workspace)?;
    let from = repo.resolve(&checkpoint)?;
    let relative = repo.relative(&path)?;
    let patch = file_patch(&repo, &from, &relative)?;
    Ok(FileHunks {
        path,
        relative,
        binary: patch.binary,
        hunks: patch
            .hunks
            .iter()
            .map(|hunk| Hunk {
                id: hunk.id.clone(),
                header: hunk.header.clone(),
                old_start: hunk.old_start,
                old_lines: hunk.old_lines,
                new_start: hunk.new_start,
                new_lines: hunk.new_lines,
                added: hunk.added,
                removed: hunk.removed,
            })
            .collect(),
    })
}

/// Put one file back the way it was at a checkpoint.
///
/// A file that did not exist at the checkpoint is deleted -- unless the ignore rules
/// mean it was never captured in the first place, in which case this refuses rather than
/// delete something it never had a copy of.
#[tauri::command]
pub fn checkpoint_revert_file(
    workspace: State<'_, WorkspaceState>,
    checkpoint: String,
    path: WirePath,
) -> Result<RevertOutcome, IpcError> {
    let _guard = lock();
    let repo = Repo::open(&workspace)?;
    checkpoint_revert_file_inner(&repo, &checkpoint, path)
}

/// The body of [`checkpoint_revert_file`] without Tauri's `State`, so it can be driven
/// directly against a temp workspace in tests.
fn checkpoint_revert_file_inner(
    repo: &Repo,
    checkpoint: &str,
    path: WirePath,
) -> Result<RevertOutcome, IpcError> {
    let from = repo.resolve(checkpoint)?;
    let relative = repo.relative(&path)?;
    let native = repo.dir.join(relative.replace('/', MAIN_SEPARATOR_STR));
    if native.is_dir() {
        return Err(IpcError::new(
            ErrorCode::IsDirectory,
            format!("{path} is a directory"),
        ));
    }

    let spec = format!("{from}:{relative}");
    let present = repo
        .run_status(&["rev-parse", "--verify", "--quiet", &spec])?
        .status
        .success();
    if present {
        repo.run(&["checkout", &from, "--", &relative])?;
        return Ok(RevertOutcome {
            path,
            action: RevertAction::Restored,
            hunks: 0,
        });
    }

    if !native.exists() {
        return Ok(RevertOutcome {
            path,
            action: RevertAction::Unchanged,
            hunks: 0,
        });
    }
    // Not in the checkpoint and not something checkpoints capture: deleting it would
    // throw away the only copy.
    if repo
        .run_status(&["check-ignore", "--quiet", "--", &relative])?
        .status
        .success()
    {
        return Err(IpcError::new(
            ErrorCode::Checkpoint,
            format!("{path} is excluded from checkpoints, so there is no copy to restore"),
        ));
    }
    std::fs::remove_file(&native)
        .map_err(|err| IpcError::from_io(&err, format!("cannot delete {path}")))?;
    Ok(RevertOutcome {
        path,
        action: RevertAction::Deleted,
        hunks: 0,
    })
}

/// Put selected hunks of one file back the way they were at a checkpoint.
///
/// The patch is regenerated from the file as it is now and the named hunks are picked
/// out of *that*, so a hunk id that no longer matches anything fails with
/// [`ErrorCode::Stale`] and nothing is written. `git apply` is likewise all-or-nothing:
/// if the subset does not apply in reverse, the file is left exactly as it was.
#[tauri::command]
pub fn checkpoint_revert_hunks(
    workspace: State<'_, WorkspaceState>,
    checkpoint: String,
    path: WirePath,
    hunks: Vec<String>,
) -> Result<RevertOutcome, IpcError> {
    let _guard = lock();
    let repo = Repo::open(&workspace)?;
    checkpoint_revert_hunks_inner(&repo, &checkpoint, path, &hunks)
}

/// The body of [`checkpoint_revert_hunks`] without Tauri's `State`.
fn checkpoint_revert_hunks_inner(
    repo: &Repo,
    checkpoint: &str,
    path: WirePath,
    hunks: &[String],
) -> Result<RevertOutcome, IpcError> {
    let from = repo.resolve(checkpoint)?;
    let relative = repo.relative(&path)?;
    if hunks.is_empty() {
        return Ok(RevertOutcome {
            path,
            action: RevertAction::Unchanged,
            hunks: 0,
        });
    }

    let patch = file_patch(repo, &from, &relative)?;
    if patch.binary {
        return Err(IpcError::new(
            ErrorCode::Checkpoint,
            format!("{path} is binary; revert the whole file instead of hunks of it"),
        ));
    }
    if patch.hunks.is_empty() {
        return Err(IpcError::new(
            ErrorCode::Stale,
            format!("{path} no longer differs from that checkpoint"),
        ));
    }

    let mut selected = Vec::new();
    for wanted in hunks {
        let found = patch.hunks.iter().find(|hunk| hunk.id == *wanted);
        let Some(hunk) = found else {
            return Err(IpcError::new(
                ErrorCode::Stale,
                format!(
                    "hunk {wanted} is no longer in {path}: it has been edited or already \
                     reverted, so nothing was changed"
                ),
            ));
        };
        selected.push(hunk);
    }
    // Back into file order: `git apply` reads a patch top to bottom.
    selected.sort_by_key(|hunk| hunk.new_start);

    let mut subset = patch.header.clone();
    for hunk in &selected {
        subset.push_str(&hunk.header);
        subset.push('\n');
        subset.push_str(&hunk.body);
    }
    if !subset.ends_with('\n') {
        subset.push('\n');
    }

    let run = repo.run_raw(
        &["apply", "--reverse", "--whitespace=nowarn", "-"],
        Some(subset.into_bytes()),
    )?;
    if !run.status.success() {
        return Err(IpcError::new(
            ErrorCode::Stale,
            format!(
                "those hunks no longer apply to {path}, so it was left unchanged: {}",
                run.stderr
            ),
        ));
    }

    let native = repo.dir.join(relative.replace('/', MAIN_SEPARATOR_STR));
    Ok(RevertOutcome {
        path,
        action: if native.exists() {
            RevertAction::Restored
        } else {
            // Reverting the only hunk of a newly created file removes the file.
            RevertAction::Deleted
        },
        hunks: selected.len() as u32,
    })
}

/// Put the whole work tree back the way it was at a checkpoint.
///
/// Two checkpoints are taken around this: one *before* anything moves, which is what
/// makes a rewind undoable, and one after, so the timeline records the state the tree is
/// actually in. HEAD only ever moves forward -- rewinding does not erase the checkpoints
/// that came after the one being rewound to.
///
/// What is deleted: files that exist now and did not exist at the checkpoint. Every one
/// of them is in the safety checkpoint this returns, and they are listed in `deleted`.
/// Pass `deleteCreated: false` to keep them instead; they are then listed in `kept`.
///
/// What is never deleted: anything the ignore rules exclude, and anything untracked --
/// a rewind removes files through git's index, and a file that was never captured is not
/// in it. Unsaved editor buffers are not on disk and so are not touched at all.
#[tauri::command]
pub fn checkpoint_rewind(
    workspace: State<'_, WorkspaceState>,
    checkpoint: String,
    delete_created: Option<bool>,
) -> Result<RewindResult, IpcError> {
    let _guard = lock();
    let repo = Repo::open(&workspace)?;
    rewind_inner(&repo, &checkpoint, delete_created.unwrap_or(true))
}

/// The body of [`checkpoint_rewind`] without Tauri's `State`. This is the one operation
/// that can remove work, so it is also the one most worth testing directly.
fn rewind_inner(
    repo: &Repo,
    checkpoint: &str,
    delete_created: bool,
) -> Result<RewindResult, IpcError> {
    let target = repo.resolve(checkpoint)?;
    let short: String = target.chars().take(7).collect();

    // Everything on disk now, including whatever the rewind is about to remove.
    let safety = take(repo, &format!("Before rewind to {short}"))?;

    let mut created = Vec::new();
    let mut restored = Vec::new();
    for entry in raw_diff(repo, &target, Some(&safety.id), None)? {
        match entry.status {
            FileChange::Added => created.push(entry.path),
            // Deleted since the checkpoint: the rewind brings it back.
            _ => restored.push(entry.path),
        }
    }

    // Sets the index and the work tree to the checkpoint's tree without moving HEAD.
    // Untracked files are not in the index, so this cannot reach them.
    repo.run(&["read-tree", "-u", "--reset", &target])?;

    if !delete_created && !created.is_empty() {
        let mut pathspec = Vec::new();
        for path in &created {
            pathspec.extend_from_slice(path.as_bytes());
            pathspec.push(0);
        }
        let run = repo.run_raw(
            &[
                "checkout",
                &safety.id,
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            Some(pathspec),
        )?;
        if !run.status.success() {
            return Err(failed(&["checkout"], &run));
        }
    }

    let after = take(repo, &format!("Rewound to {short}"))?;
    let wire = |paths: Vec<String>| -> Result<Vec<WirePath>, IpcError> {
        paths.iter().map(|path| repo.absolute(path)).collect()
    };
    Ok(RewindResult {
        safety,
        checkpoint: after,
        restored: wire(restored)?,
        deleted: if delete_created {
            wire(created.clone())?
        } else {
            Vec::new()
        },
        kept: if delete_created {
            Vec::new()
        } else {
            wire(created)?
        },
    })
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    // Nothing is held across the lock, so a panic in one command leaves no state for the
    // next one to be confused by.
    GIT.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::UNIX_EPOCH;

    /// A scratch workspace that removes itself when the test ends.
    struct Workspace {
        dir: PathBuf,
        root: WirePath,
    }

    impl Workspace {
        fn new(tag: &str) -> Self {
            let unique = std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock before epoch")
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("agentide-cp-{tag}-{unique}"));
            fs::create_dir_all(&dir).expect("cannot create scratch dir");
            let root = WirePath::canonical(&dir).expect("scratch dir is not normalizable");
            Self {
                dir: root.to_path(),
                root,
            }
        }

        fn repo(&self) -> Repo {
            Repo::at(&self.root).expect("cannot open the shadow repository")
        }

        fn write(&self, relative: &str, contents: &str) {
            self.write_bytes(relative, contents.as_bytes());
        }

        fn write_bytes(&self, relative: &str, contents: &[u8]) {
            let path = self.dir.join(relative.replace('/', MAIN_SEPARATOR_STR));
            fs::create_dir_all(path.parent().expect("a parent")).expect("cannot create dirs");
            fs::write(path, contents).expect("cannot write");
        }

        fn read(&self, relative: &str) -> String {
            fs::read_to_string(self.dir.join(relative.replace('/', MAIN_SEPARATOR_STR)))
                .expect("cannot read")
        }

        fn exists(&self, relative: &str) -> bool {
            self.dir
                .join(relative.replace('/', MAIN_SEPARATOR_STR))
                .exists()
        }

        fn wire(&self, relative: &str) -> WirePath {
            WirePath::parse(&under(&self.root, relative)).expect("not normalizable")
        }

        /// The paths a checkpoint captured.
        fn tracked(&self, repo: &Repo, id: &str) -> Vec<String> {
            let raw = text(
                repo.run(&["ls-tree", "-r", "--name-only", id])
                    .expect("ls-tree failed"),
            )
            .expect("not utf-8");
            raw.lines().map(str::to_string).collect()
        }
    }

    impl Drop for Workspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn only<T>(mut items: Vec<T>) -> T {
        assert_eq!(items.len(), 1, "expected exactly one item");
        items.pop().expect("one item")
    }

    #[test]
    fn a_plain_folder_needs_no_git_repository_of_its_own() {
        let ws = Workspace::new("plain");
        ws.write("src/main.rs", "fn main() {}\n");
        let repo = ws.repo();

        let first = take(&repo, "turn one").expect("checkpoint failed");
        assert_eq!(first.label, "turn one");
        assert_eq!(first.parent, None);
        assert!(first.created_ms > 0);
        assert_eq!(ws.tracked(&repo, &first.id), vec!["src/main.rs"]);

        ws.write("src/main.rs", "fn main() { greet(); }\n");
        let second = take(&repo, "turn two").expect("checkpoint failed");
        assert_eq!(second.parent.as_deref(), Some(first.id.as_str()));
        assert_eq!((second.files_changed, second.added, second.removed), (1, 1, 1));

        let listed = log(&repo, 50).expect("list failed");
        assert_eq!(
            listed.iter().map(|c| c.label.as_str()).collect::<Vec<_>>(),
            vec!["turn two", "turn one"],
            "newest first"
        );
    }

    #[test]
    fn the_shadow_repository_never_swallows_the_users_own_git_directory() {
        let ws = Workspace::new("nested-git");
        // The shapes a real workspace has: a .git directory, and a .gitignore that the
        // checkpoint has to honour.
        ws.write(".git/HEAD", "ref: refs/heads/main\n");
        ws.write(".git/config", "[core]\n\tbare = false\n");
        ws.write(".gitignore", "*.log\n");
        ws.write("app.rs", "fn main() {}\n");
        ws.write("debug.log", "noise\n");
        ws.write("node_modules/left-pad/index.js", "module.exports = 1;\n");
        let repo = ws.repo();

        let before = fs::read(ws.dir.join(".git").join("HEAD")).expect("cannot read HEAD");
        let checkpoint = take(&repo, "first").expect("checkpoint failed");
        let tracked = ws.tracked(&repo, &checkpoint.id);

        assert_eq!(tracked, vec![".gitignore", "app.rs"]);
        assert!(
            !tracked.iter().any(|path| path.starts_with(".git/")),
            "the user's git directory must never be committed: {tracked:?}"
        );
        assert!(!tracked.iter().any(|path| path.contains("node_modules")));
        assert!(!tracked.iter().any(|path| path.ends_with(".log")));
        assert!(!tracked.iter().any(|path| path.contains(".agentide")));
        assert_eq!(
            fs::read(ws.dir.join(".git").join("HEAD")).expect("cannot read HEAD"),
            before,
            "the user's git directory must be left exactly as it was"
        );
    }

    #[test]
    fn a_first_checkpoint_on_an_empty_folder_still_produces_one() {
        let ws = Workspace::new("empty");
        let repo = ws.repo();

        let first = take(&repo, "").expect("checkpoint failed");
        assert_eq!(first.label, "Checkpoint");
        assert!(ws.tracked(&repo, &first.id).is_empty());

        // And rewinding back to an empty tree is not a special case either.
        ws.write("late.txt", "written after\n");
        let rewind = rewind_to(&repo, &first.id, true);
        assert!(!ws.exists("late.txt"));
        assert_eq!(rewind.deleted.len(), 1);
    }

    #[test]
    fn a_diff_names_what_changed_and_carries_both_sides() {
        let ws = Workspace::new("diff");
        ws.write("keep.txt", "unchanged\n");
        ws.write("edit.txt", "one\ntwo\nthree\n");
        ws.write("gone.txt", "delete me\n");
        let repo = ws.repo();
        let base = take(&repo, "base").expect("checkpoint failed");

        ws.write("edit.txt", "one\nTWO\nthree\nfour\n");
        ws.write("new.txt", "fresh\n");
        fs::remove_file(ws.dir.join("gone.txt")).expect("cannot delete");

        let files = diff(&repo, &base.id, None, None, MAX_DIFF_TOTAL_BYTES).expect("diff failed");
        let by_path: HashMap<&str, &DiffFile> = files
            .iter()
            .map(|file| (file.relative.as_str(), file))
            .collect();
        assert_eq!(by_path.len(), 3, "an unchanged file is not in the diff");

        let edited = by_path["edit.txt"];
        assert_eq!(edited.status, FileChange::Modified);
        assert_eq!((edited.added, edited.removed), (2, 1));
        assert_eq!(edited.before.as_deref(), Some("one\ntwo\nthree\n"));
        assert_eq!(edited.after.as_deref(), Some("one\nTWO\nthree\nfour\n"));
        assert_eq!(edited.path, ws.wire("edit.txt"));

        let created = by_path["new.txt"];
        assert_eq!(created.status, FileChange::Added);
        assert_eq!(created.before, None, "a created file has no before");
        assert_eq!(created.after.as_deref(), Some("fresh\n"));
        assert_eq!(created.omitted, None);

        let removed = by_path["gone.txt"];
        assert_eq!(removed.status, FileChange::Deleted);
        assert_eq!(removed.before.as_deref(), Some("delete me\n"));
        assert_eq!(removed.after, None);
    }

    #[test]
    fn binary_and_oversized_files_are_flagged_rather_than_returned() {
        let ws = Workspace::new("binary");
        ws.write_bytes("image.bin", &[0x89, 0x50, 0x00, 0x01]);
        ws.write("big.txt", "small for now\n");
        let repo = ws.repo();
        let base = take(&repo, "base").expect("checkpoint failed");

        ws.write_bytes("image.bin", &[0x89, 0x50, 0x00, 0x02, 0x03]);
        ws.write_bytes("big.txt", &vec![b'x'; (MAX_DIFF_BYTES + 1) as usize]);

        let files = diff(&repo, &base.id, None, None, MAX_DIFF_TOTAL_BYTES).expect("diff failed");
        let by_path: HashMap<&str, &DiffFile> = files
            .iter()
            .map(|file| (file.relative.as_str(), file))
            .collect();

        let image = by_path["image.bin"];
        assert!(image.binary);
        assert_eq!(image.omitted, Some(Omitted::Binary));
        assert_eq!((image.before.as_deref(), image.after.as_deref()), (None, None));

        let big = by_path["big.txt"];
        assert!(!big.binary);
        assert_eq!(big.omitted, Some(Omitted::TooLarge));
        assert_eq!(big.after, None);
    }

    #[test]
    fn reverting_a_file_restores_it_or_removes_what_was_never_there() {
        let ws = Workspace::new("revert-file");
        ws.write("edit.txt", "original\n");
        let repo = ws.repo();
        let base = take(&repo, "base").expect("checkpoint failed");

        ws.write("edit.txt", "agent wrote this\n");
        ws.write("added.txt", "agent made this\n");

        let restored = revert_file(&repo, &base.id, &ws.wire("edit.txt"));
        assert_eq!(restored.action, RevertAction::Restored);
        assert_eq!(ws.read("edit.txt"), "original\n");

        let deleted = revert_file(&repo, &base.id, &ws.wire("added.txt"));
        assert_eq!(deleted.action, RevertAction::Deleted);
        assert!(!ws.exists("added.txt"));

        let nothing = revert_file(&repo, &base.id, &ws.wire("never.txt"));
        assert_eq!(nothing.action, RevertAction::Unchanged);
    }

    #[test]
    fn reverting_a_file_refuses_to_delete_one_checkpoints_never_captured() {
        let ws = Workspace::new("revert-ignored");
        ws.write(".gitignore", "secrets/\n");
        let repo = ws.repo();
        let base = take(&repo, "base").expect("checkpoint failed");
        ws.write("secrets/key.txt", "not in any checkpoint\n");

        let error = checkpoint_revert_file_inner(&repo, &base.id, ws.wire("secrets/key.txt"))
            .expect_err("must refuse");
        assert_eq!(error.code, ErrorCode::Checkpoint);
        assert!(ws.exists("secrets/key.txt"), "the only copy must survive");
    }

    #[test]
    fn reverting_one_hunk_leaves_the_others_alone() {
        let ws = Workspace::new("hunks");
        ws.write("f.txt", "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n");
        let repo = ws.repo();
        let base = take(&repo, "base").expect("checkpoint failed");
        ws.write("f.txt", "a\nB!\nc\nd\ne\nf\ng\nh\ni\nj\nK!\nl\n");

        let hunks = file_patch(&repo, &base.id, "f.txt").expect("patch failed");
        assert_eq!(hunks.hunks.len(), 2, "far enough apart to be two hunks");
        assert!(!hunks.binary);
        let first = hunks.hunks[0].id.clone();
        let second = hunks.hunks[1].id.clone();

        let outcome = revert_hunks(&repo, &base.id, &ws.wire("f.txt"), std::slice::from_ref(&second));
        assert_eq!(outcome.action, RevertAction::Restored);
        assert_eq!(outcome.hunks, 1);
        assert_eq!(
            ws.read("f.txt"),
            "a\nB!\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n",
            "only the second hunk went back"
        );

        // The first hunk did not move, so the id the caller is still holding works.
        let outcome = revert_hunks(&repo, &base.id, &ws.wire("f.txt"), &[first]);
        assert_eq!(outcome.hunks, 1);
        assert_eq!(ws.read("f.txt"), "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n");

        // And the one that has already been reverted is gone, loudly.
        let error = checkpoint_revert_hunks_inner(&repo, &base.id, ws.wire("f.txt"), &[second])
            .expect_err("a reverted hunk must not apply twice");
        assert_eq!(error.code, ErrorCode::Stale);
    }

    #[test]
    fn a_stale_hunk_fails_without_touching_the_file() {
        let ws = Workspace::new("stale");
        ws.write("f.txt", "one\ntwo\nthree\n");
        let repo = ws.repo();
        let base = take(&repo, "base").expect("checkpoint failed");
        ws.write("f.txt", "one\nTWO\nthree\n");

        let hunks = file_patch(&repo, &base.id, "f.txt").expect("patch failed");
        let id = only(hunks.hunks.iter().map(|h| h.id.clone()).collect());

        // The user keeps typing after the queue rendered the hunk.
        ws.write("f.txt", "one\nTWO but edited again\nthree\n");
        let error = checkpoint_revert_hunks_inner(&repo, &base.id, ws.wire("f.txt"), &[id])
            .expect_err("a hunk that no longer exists must fail");
        assert_eq!(error.code, ErrorCode::Stale);
        assert_eq!(
            ws.read("f.txt"),
            "one\nTWO but edited again\nthree\n",
            "a stale hunk must not corrupt the file"
        );
    }

    #[test]
    fn reverting_the_only_hunk_of_a_created_file_removes_it() {
        let ws = Workspace::new("hunk-created");
        ws.write("kept.txt", "here first\n");
        let repo = ws.repo();
        let base = take(&repo, "base").expect("checkpoint failed");
        ws.write("made.txt", "the agent wrote this\n");

        let patch = file_patch(&repo, &base.id, "made.txt").expect("patch failed");
        let id = only(patch.hunks.iter().map(|h| h.id.clone()).collect());
        let outcome = revert_hunks(&repo, &base.id, &ws.wire("made.txt"), &[id]);

        assert_eq!(outcome.action, RevertAction::Deleted);
        assert!(!ws.exists("made.txt"));
        assert!(ws.exists("kept.txt"));
    }

    #[test]
    fn a_rewind_restores_the_tree_and_can_itself_be_rewound() {
        let ws = Workspace::new("rewind");
        ws.write("edit.txt", "original\n");
        ws.write("gone.txt", "deleted by the agent\n");
        ws.write_bytes("crlf.txt", b"windows\r\nline endings\r\n");
        let repo = ws.repo();
        let base = take(&repo, "before the turn").expect("checkpoint failed");

        ws.write("edit.txt", "the agent rewrote this\n");
        ws.write("created.txt", "the agent made this\n");
        ws.write_bytes("crlf.txt", b"mangled\n");
        fs::remove_file(ws.dir.join("gone.txt")).expect("cannot delete");

        let rewind = rewind_to(&repo, &base.id, true);
        assert_eq!(ws.read("edit.txt"), "original\n");
        assert_eq!(ws.read("gone.txt"), "deleted by the agent\n");
        assert!(!ws.exists("created.txt"));
        assert_eq!(
            fs::read(ws.dir.join("crlf.txt")).expect("cannot read"),
            b"windows\r\nline endings\r\n",
            "a restored file must come back byte for byte, CRLF included"
        );
        assert_eq!(
            rewind
                .deleted
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>(),
            vec![ws.wire("created.txt").to_string()]
        );
        assert_eq!(rewind.restored.len(), 3);

        // The safety checkpoint still holds everything the rewind removed.
        rewind_to(&repo, &rewind.safety.id, true);
        assert_eq!(ws.read("created.txt"), "the agent made this\n");
        assert_eq!(ws.read("edit.txt"), "the agent rewrote this\n");
        assert!(!ws.exists("gone.txt"));
    }

    #[test]
    fn a_rewind_leaves_files_it_never_captured_where_they_are() {
        let ws = Workspace::new("rewind-safety");
        ws.write(".gitignore", "*.local\n");
        ws.write("tracked.txt", "before\n");
        ws.write("node_modules/left-pad/index.js", "installed\n");
        ws.write("notes.local", "the user's scratch file\n");
        let repo = ws.repo();
        let base = take(&repo, "before the turn").expect("checkpoint failed");

        ws.write("tracked.txt", "after\n");
        // Written by the user after the checkpoint, in a place checkpoints do not reach.
        ws.write("node_modules/left-pad/extra.js", "added later\n");
        ws.write("later.local", "also after the checkpoint\n");

        let rewind = rewind_to(&repo, &base.id, true);
        assert_eq!(ws.read("tracked.txt"), "before\n");
        assert!(ws.exists("node_modules/left-pad/index.js"));
        assert!(
            ws.exists("node_modules/left-pad/extra.js"),
            "an excluded file created after the checkpoint is not the rewind's business"
        );
        assert!(ws.exists("notes.local"));
        assert!(ws.exists("later.local"));
        assert!(rewind.deleted.is_empty(), "{:?}", rewind.deleted);
    }

    #[test]
    fn a_rewind_can_keep_the_files_that_were_created() {
        let ws = Workspace::new("rewind-keep");
        ws.write("edit.txt", "original\n");
        let repo = ws.repo();
        let base = take(&repo, "base").expect("checkpoint failed");
        ws.write("edit.txt", "changed\n");
        ws.write("created.txt", "keep me\n");

        let rewind = rewind_to(&repo, &base.id, false);
        assert_eq!(ws.read("edit.txt"), "original\n");
        assert_eq!(ws.read("created.txt"), "keep me\n");
        assert!(rewind.deleted.is_empty());
        assert_eq!(rewind.kept.len(), 1);

        // And the checkpoint taken after the rewind describes the tree as it now is.
        let files =
            diff(&repo, &rewind.checkpoint.id, None, None, MAX_DIFF_TOTAL_BYTES).expect("diff");
        assert!(files.is_empty(), "{files:?}");
    }

    #[test]
    fn checkpoint_ids_from_the_frontend_cannot_be_revision_expressions() {
        let ws = Workspace::new("ids");
        ws.write("f.txt", "x\n");
        let repo = ws.repo();
        take(&repo, "one").expect("checkpoint failed");
        take(&repo, "two").expect("checkpoint failed");

        for hostile in ["HEAD~1", "--upload-pack=calc", "refs/heads/checkpoints", ""] {
            let error = repo.resolve(hostile).expect_err("must be refused");
            assert_eq!(error.code, ErrorCode::Checkpoint, "{hostile}");
        }
        let unknown = repo
            .resolve("0123456789abcdef0123456789abcdef01234567")
            .expect_err("must be refused");
        assert_eq!(unknown.code, ErrorCode::Stale);
    }

    #[test]
    fn a_label_becomes_a_single_line_commit_subject() {
        assert_eq!(subject("  turn 3  "), "turn 3");
        assert_eq!(subject(""), "Checkpoint");
        assert_eq!(subject("\n\t"), "Checkpoint");
        assert_eq!(subject("first\nsecond"), "first second");
        assert_eq!(
            subject(&format!("{RECORD}{FIELD}separators")),
            "separators",
            "the log format's own separators cannot come back in a label"
        );
        assert_eq!(subject(&"x".repeat(500)).chars().count(), 200);
    }

    #[test]
    fn hunk_headers_parse_with_and_without_counts() {
        assert_eq!(parse_hunk_header("@@ -12,7 +14,9 @@ fn main() {"), (12, 7, 14, 9));
        assert_eq!(parse_hunk_header("@@ -1 +1 @@"), (1, 1, 1, 1));
        assert_eq!(parse_hunk_header("@@ -0,0 +1,3 @@"), (0, 0, 1, 3));
    }

    // The command bodies without the Tauri `State` wrapper, so the tests can drive them.

    fn revert_file(repo: &Repo, checkpoint: &str, path: &WirePath) -> RevertOutcome {
        checkpoint_revert_file_inner(repo, checkpoint, path.clone()).expect("revert failed")
    }

    fn revert_hunks(
        repo: &Repo,
        checkpoint: &str,
        path: &WirePath,
        hunks: &[String],
    ) -> RevertOutcome {
        checkpoint_revert_hunks_inner(repo, checkpoint, path.clone(), hunks)
            .expect("hunk revert failed")
    }

    fn rewind_to(repo: &Repo, checkpoint: &str, delete_created: bool) -> RewindResult {
        rewind_inner(repo, checkpoint, delete_created).expect("rewind failed")
    }
}
