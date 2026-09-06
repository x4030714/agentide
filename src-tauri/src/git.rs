//! The user's own git repository: status, diffs, staging, commits and branches.
//!
//! Distinct from `checkpoints.rs`, which owns a private shadow repository and goes to
//! great lengths to be isolated from the user's git setup. This module is the opposite:
//! it runs git *as the user would*, in their working tree, with their config, their
//! identity, their hooks and their signing key. A commit made here has to be
//! indistinguishable from one they made in a terminal, or the panel is a trap.
//!
//! ## Why the CLI rather than `git2`
//!
//! The plan called for `git2` on the read side. Two things argued against it once the
//! checkpoint system was already shelling out to git:
//!
//! - **Two implementations disagree.** libgit2 and git have different ignore handling,
//!   different index edge cases, and different notions of what is "clean". A panel that
//!   disagrees with the user's terminal about whether a file is staged is worse than no
//!   panel.
//! - **Writes lose the user's setup.** `git2` commits do not run hooks, do not sign, and
//!   have to reimplement identity resolution. A pre-commit hook that silently stops
//!   running because you committed from the IDE is exactly the kind of surprise this
//!   codebase is supposed to avoid.
//!
//! The concern `git2` was meant to address -- not parsing human output -- is met by
//! asking git for its machine formats: `--porcelain=v2 -z` and `for-each-ref --format`.
//! Those are documented, stable, and NUL-delimited, so a path with a space, a quote or a
//! newline in it survives.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::fs::WorkspaceState;
use crate::ipc::{ErrorCode, IpcError, WirePath};

/// What a file's presence in the status list means.
///
/// Kept as a named state rather than the raw porcelain letter: the letter is an
/// implementation detail of the format, and the frontend needs to colour and label these,
/// not decode them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GitState {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Untracked,
    /// A merge conflict. Never stageable from the panel -- resolving it is an edit.
    Conflicted,
}

impl GitState {
    fn from_code(code: u8) -> Self {
        match code {
            b'A' => Self::Added,
            b'D' => Self::Deleted,
            b'R' => Self::Renamed,
            b'C' => Self::Copied,
            b'T' => Self::TypeChanged,
            _ => Self::Modified,
        }
    }
}

/// One row in the panel.
///
/// A file can appear twice -- once staged, once not -- because git tracks those
/// separately and a partially staged file is a real, common state. Conflating them would
/// make "stage" and "unstage" ambiguous.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    /// Absolute, so the editor can open it without knowing where the repository root is.
    pub path: WirePath,
    /// Repository-relative, which is what the user reads and what git commands take.
    pub rel: String,
    /// Present in the index, i.e. it would be part of a commit made right now.
    pub staged: bool,
    pub state: GitState,
    /// Where a rename or copy came from, repository-relative.
    pub from: Option<String>,
}

/// The repository as a whole. `is_repo: false` is a normal answer, not an error: plenty
/// of folders worth opening are not repositories.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    /// The repository root, which is not always the open workspace.
    pub root: Option<WirePath>,
    /// `None` on a detached HEAD or an unborn branch.
    pub branch: Option<String>,
    /// Short HEAD sha, or `None` before the first commit.
    pub head: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
    /// `refs/remotes/...` branches, which can be checked out but only as detached.
    pub remote: bool,
    pub upstream: Option<String>,
    /// Subject line of the branch's tip, so the list says what each branch is.
    pub subject: String,
}

/// The two sides of a diff, as text, for Monaco's diff editor.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiff {
    pub path: WirePath,
    pub rel: String,
    /// `None` when the file did not exist on that side.
    pub before: Option<String>,
    pub after: Option<String>,
    /// Set when a side was skipped because it is not text; both sides are then `None`.
    pub binary: bool,
}

// --- Running git ----------------------------------------------------------------

/// A git invocation in the user's working tree, with the user's environment intact.
///
/// The deliberate opposite of `checkpoints.rs`'s builder, which strips the environment to
/// isolate the shadow repository. Here the user's config *is* the point. Only two things
/// are forced: no credential prompt (nothing here is a network operation, and a prompt
/// would block a thread nobody can answer from), and C messages for the few places output
/// is matched against.
fn git_in(dir: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        /// Without this a console window flashes up behind the app on every git call.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

struct Run {
    stdout: Vec<u8>,
    stderr: String,
    ok: bool,
}

fn run(dir: &Path, args: &[&str]) -> Result<Run, IpcError> {
    let output = git_in(dir)
        .args(args)
        .output()
        .map_err(|err| match err.kind() {
            std::io::ErrorKind::NotFound => IpcError::new(
                ErrorCode::NotFound,
                "git is not on PATH. Install git, or add it to PATH.",
            ),
            _ => IpcError::from_io(&err, "cannot run git"),
        })?;
    Ok(Run {
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ok: output.status.success(),
        stdout: output.stdout,
    })
}

/// Run git and fail on a non-zero exit, carrying git's own complaint.
fn checked(dir: &Path, args: &[&str]) -> Result<Vec<u8>, IpcError> {
    let result = run(dir, args)?;
    if !result.ok {
        let detail = if result.stderr.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            result.stderr
        };
        return Err(IpcError::new(ErrorCode::Git, detail));
    }
    Ok(result.stdout)
}

fn text(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).into_owned()
}

fn root_of(workspace: &State<'_, WorkspaceState>) -> Result<PathBuf, IpcError> {
    workspace
        .root()
        .map(|root| root.to_path())
        .ok_or_else(|| IpcError::new(ErrorCode::NotFound, "no workspace is open"))
}

/// The repository root containing `dir`, or `None` when there is not one.
fn repo_root(dir: &Path) -> Result<Option<PathBuf>, IpcError> {
    let result = run(dir, &["rev-parse", "--show-toplevel"])?;
    if !result.ok {
        return Ok(None);
    }
    let path = text(result.stdout).trim().to_string();
    if path.is_empty() {
        return Ok(None);
    }
    Ok(Some(PathBuf::from(path)))
}

// --- Status ---------------------------------------------------------------------

/// Parse `git status --porcelain=v2 --branch -z --untracked-files=all`.
///
/// Split out from the command so it can be tested against the exact bytes git emits,
/// including the shapes that are easy to get wrong: a rename, whose original path is a
/// second NUL-terminated field inside one record, and a file that is staged and modified
/// again afterwards, which must produce two rows.
fn parse_status(bytes: &[u8], root: &Path) -> Result<GitStatus, IpcError> {
    let mut status = GitStatus {
        is_repo: true,
        root: WirePath::from_path(root).ok(),
        branch: None,
        head: None,
        detached: false,
        upstream: None,
        ahead: 0,
        behind: 0,
        files: Vec::new(),
    };

    // `-z` makes every record NUL-terminated. A rename record carries two paths, so the
    // records cannot simply be split -- the parser has to consume the extra field.
    let mut records = bytes.split(|byte| *byte == 0).peekable();
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        let line = String::from_utf8_lossy(record).into_owned();
        let mut parts = line.splitn(2, ' ');
        let tag = parts.next().unwrap_or("");
        let rest = parts.next().unwrap_or("");

        match tag {
            "#" => {
                let mut header = rest.splitn(2, ' ');
                let key = header.next().unwrap_or("");
                let value = header.next().unwrap_or("").trim();
                match key {
                    "branch.oid" => {
                        status.head = (value != "(initial)").then(|| short(value));
                    }
                    "branch.head" => {
                        if value == "(detached)" {
                            status.detached = true;
                        } else {
                            status.branch = Some(value.to_string());
                        }
                    }
                    "branch.upstream" => status.upstream = Some(value.to_string()),
                    "branch.ab" => {
                        for token in value.split_whitespace() {
                            let count = token[1..].parse::<u32>().unwrap_or(0);
                            match token.as_bytes().first() {
                                Some(b'+') => status.ahead = count,
                                Some(b'-') => status.behind = count,
                                _ => {}
                            }
                        }
                    }
                    _ => {}
                }
            }

            // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
            "1" => {
                let mut fields = rest.splitn(8, ' ');
                let xy = fields.next().unwrap_or("").as_bytes().to_vec();
                let path = fields.nth(6).unwrap_or("");
                push_entry(&mut status, root, &xy, path, None);
            }

            // `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>` then `<origPath>`
            "2" => {
                let mut fields = rest.splitn(9, ' ');
                let xy = fields.next().unwrap_or("").as_bytes().to_vec();
                let path = fields.nth(7).unwrap_or("").to_string();
                let from = records
                    .next()
                    .map(|value| String::from_utf8_lossy(value).into_owned());
                push_entry(&mut status, root, &xy, &path, from);
            }

            // `u <XY> ...` -- unmerged. One row, never two: a conflict is not something
            // that can be half-staged, and offering to stage it would be a lie.
            "u" => {
                // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`: ten fields
                // after the tag, one more stage hash than a `1` record carries.
                let path = rest.splitn(10, ' ').nth(9).unwrap_or("");
                if let Some(file) = entry(root, path, false, GitState::Conflicted, None) {
                    status.files.push(file);
                }
            }

            "?" => {
                if let Some(file) = entry(root, rest, false, GitState::Untracked, None) {
                    status.files.push(file);
                }
            }

            _ => {}
        }
    }

    Ok(status)
}

/// Turn one tracked entry's `XY` code into up to two rows.
///
/// `X` is the index against HEAD and `Y` is the working tree against the index, so a file
/// that was staged and then edited again is genuinely in both lists. Showing it once
/// would make "stage" and "unstage" mean something different for that file than for every
/// other one.
fn push_entry(status: &mut GitStatus, root: &Path, xy: &[u8], path: &str, from: Option<String>) {
    let index = xy.first().copied().unwrap_or(b'.');
    let worktree = xy.get(1).copied().unwrap_or(b'.');
    if index != b'.' {
        if let Some(file) = entry(root, path, true, GitState::from_code(index), from.clone()) {
            status.files.push(file);
        }
    }
    if worktree != b'.' {
        if let Some(file) = entry(root, path, false, GitState::from_code(worktree), from) {
            status.files.push(file);
        }
    }
}

fn entry(
    root: &Path,
    rel: &str,
    staged: bool,
    state: GitState,
    from: Option<String>,
) -> Option<GitFile> {
    let rel = rel.trim_end_matches('/');
    if rel.is_empty() {
        return None;
    }
    Some(GitFile {
        path: WirePath::from_path(&root.join(rel)).ok()?,
        rel: rel.to_string(),
        staged,
        state,
        from,
    })
}

fn short(sha: &str) -> String {
    sha.chars().take(8).collect()
}

// --- Commands -------------------------------------------------------------------

#[tauri::command]
pub async fn git_status(workspace: State<'_, WorkspaceState>) -> Result<GitStatus, IpcError> {
    let dir = root_of(&workspace)?;
    let Some(root) = repo_root(&dir)? else {
        return Ok(GitStatus {
            is_repo: false,
            root: None,
            branch: None,
            head: None,
            detached: false,
            upstream: None,
            ahead: 0,
            behind: 0,
            files: Vec::new(),
        });
    };
    let bytes = checked(
        &dir,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
    )?;
    parse_status(&bytes, &root)
}

/// The two sides of one file's diff, for the diff editor.
///
/// `staged` picks which comparison: the index against HEAD, or the working tree against
/// the index. That is the same split the panel shows, so a row and its diff always agree.
#[tauri::command]
pub async fn git_file_diff(
    workspace: State<'_, WorkspaceState>,
    rel: String,
    staged: bool,
) -> Result<GitFileDiff, IpcError> {
    let dir = root_of(&workspace)?;
    let root = repo_root(&dir)?
        .ok_or_else(|| IpcError::new(ErrorCode::Git, "this workspace is not a git repository"))?;
    let path = WirePath::from_path(&root.join(&rel))?;

    let (before_spec, after_from_disk) = if staged {
        (format!("HEAD:{rel}"), false)
    } else {
        (format!(":{rel}"), true)
    };

    let before = show(&dir, &before_spec)?;
    let after = if after_from_disk {
        read_worktree(&root.join(&rel))?
    } else {
        show(&dir, &format!(":{rel}"))?
    };

    // Either side being binary makes the pair meaningless in a text diff editor; saying
    // so is better than rendering mojibake and letting the user think that is the file.
    let binary = before.is_binary || after.is_binary;
    Ok(GitFileDiff {
        path,
        rel,
        before: if binary { None } else { before.text },
        after: if binary { None } else { after.text },
        binary,
    })
}

struct Blob {
    text: Option<String>,
    is_binary: bool,
}

/// `git show <spec>`, treating "does not exist on this side" as content of `None` rather
/// than an error -- that is what an added or deleted file looks like.
fn show(dir: &Path, spec: &str) -> Result<Blob, IpcError> {
    let result = run(dir, &["show", spec])?;
    if !result.ok {
        return Ok(Blob {
            text: None,
            is_binary: false,
        });
    }
    Ok(decode(result.stdout))
}

fn read_worktree(path: &Path) -> Result<Blob, IpcError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(decode(bytes)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Blob {
            text: None,
            is_binary: false,
        }),
        Err(err) => Err(IpcError::from_io(&err, format!("cannot read {}", path.display()))),
    }
}

/// A NUL byte is git's own heuristic for binary, and it is the right one here: it is what
/// decides whether the diff editor can show anything meaningful.
fn decode(bytes: Vec<u8>) -> Blob {
    if bytes.contains(&0) {
        return Blob {
            text: None,
            is_binary: true,
        };
    }
    match String::from_utf8(bytes) {
        Ok(text) => Blob {
            text: Some(text),
            is_binary: false,
        },
        Err(_) => Blob {
            text: None,
            is_binary: true,
        },
    }
}

/// Stage whole files. `--` guards against a path that looks like a revision.
#[tauri::command]
pub async fn git_stage(workspace: State<'_, WorkspaceState>, paths: Vec<String>) -> Result<(), IpcError> {
    if paths.is_empty() {
        return Ok(());
    }
    let dir = root_of(&workspace)?;
    let mut args: Vec<&str> = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    checked(&dir, &args)?;
    Ok(())
}

/// Unstage, keeping the working tree untouched.
///
/// `restore --staged` rather than `reset`: it is the operation that only ever touches the
/// index, so there is no version of this that can eat someone's edits.
#[tauri::command]
pub async fn git_unstage(
    workspace: State<'_, WorkspaceState>,
    paths: Vec<String>,
) -> Result<(), IpcError> {
    if paths.is_empty() {
        return Ok(());
    }
    let dir = root_of(&workspace)?;
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
    args.extend(paths.iter().map(String::as_str));
    checked(&dir, &args)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResult {
    pub sha: String,
    pub subject: String,
}

/// Commit what is staged.
///
/// Runs the user's hooks and signing, because it is their git doing it. A hook that
/// rejects the commit surfaces as the error it wrote, which is the only useful thing to
/// show: the hook already explained itself better than we could.
#[tauri::command]
pub async fn git_commit(
    workspace: State<'_, WorkspaceState>,
    message: String,
    amend: bool,
) -> Result<GitCommitResult, IpcError> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err(IpcError::new(ErrorCode::Git, "a commit needs a message"));
    }
    let dir = root_of(&workspace)?;

    // `--file -` would need stdin; a temp file is avoided by passing the message as one
    // argument, which keeps newlines intact on every platform.
    let mut args: Vec<&str> = vec!["commit", "-m", trimmed];
    if amend {
        args.push("--amend");
    }
    let result = run(&dir, &args)?;
    if !result.ok {
        let detail = if result.stderr.is_empty() {
            text(result.stdout).trim().to_string()
        } else {
            result.stderr
        };
        return Err(IpcError::new(
            ErrorCode::Git,
            if detail.is_empty() {
                "the commit was refused".to_string()
            } else {
                detail
            },
        ));
    }

    let sha = text(checked(&dir, &["rev-parse", "HEAD"])?).trim().to_string();
    let subject = text(checked(&dir, &["log", "-1", "--format=%s"])?)
        .trim()
        .to_string();
    Ok(GitCommitResult {
        sha: short(&sha),
        subject,
    })
}

/// Local and remote branches, newest commit first.
#[tauri::command]
pub async fn git_branches(workspace: State<'_, WorkspaceState>) -> Result<Vec<GitBranch>, IpcError> {
    let dir = root_of(&workspace)?;
    if repo_root(&dir)?.is_none() {
        return Ok(Vec::new());
    }
    // Unit separator between fields and one ref per line: neither can appear in a ref
    // name, so this cannot be confused by a branch called something creative.
    let bytes = checked(
        &dir,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname:short)\x1f%(HEAD)\x1f%(upstream:short)\x1f%(contents:subject)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    let listing = text(bytes);
    Ok(listing
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\x1f');
            let name = fields.next()?.to_string();
            if name.is_empty() || name.ends_with("/HEAD") {
                return None;
            }
            let current = fields.next().unwrap_or("") == "*";
            let upstream = fields.next().unwrap_or("");
            let subject = fields.next().unwrap_or("").to_string();
            Some(GitBranch {
                remote: name.contains('/') && !name.starts_with("refs/heads"),
                current,
                upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
                name,
                subject,
            })
        })
        .collect())
}

/// Switch branches.
///
/// Never forced. A switch that would discard local changes is refused by git, and its
/// refusal names the files -- which is exactly what the user needs to decide what to do,
/// and far better than this app deciding for them.
#[tauri::command]
pub async fn git_switch(workspace: State<'_, WorkspaceState>, name: String) -> Result<(), IpcError> {
    let dir = root_of(&workspace)?;
    let result = run(&dir, &["switch", "--", &name])?;
    if !result.ok {
        return Err(IpcError::new(
            ErrorCode::Git,
            if result.stderr.is_empty() {
                format!("cannot switch to {name}")
            } else {
                result.stderr
            },
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        PathBuf::from(if cfg!(windows) {
            r"C:\repo"
        } else {
            "/repo"
        })
    }

    /// Build the NUL-delimited bytes git emits, so the tests exercise the real framing
    /// rather than a convenient approximation of it.
    fn porcelain(records: &[&str]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for record in records {
            bytes.extend_from_slice(record.as_bytes());
            bytes.push(0);
        }
        bytes
    }

    #[test]
    fn reads_the_branch_header() {
        let bytes = porcelain(&[
            "# branch.oid 1a2b3c4d5e6f7890abcdef",
            "# branch.head main",
            "# branch.upstream origin/main",
            "# branch.ab +3 -2",
        ]);
        let status = parse_status(&bytes, &root()).unwrap();
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.head.as_deref(), Some("1a2b3c4d"));
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!(status.ahead, 3);
        assert_eq!(status.behind, 2);
        assert!(!status.detached);
    }

    #[test]
    fn detached_head_has_no_branch() {
        let bytes = porcelain(&["# branch.oid abc123", "# branch.head (detached)"]);
        let status = parse_status(&bytes, &root()).unwrap();
        assert!(status.detached);
        assert_eq!(status.branch, None);
    }

    #[test]
    fn an_unborn_branch_has_no_head() {
        let bytes = porcelain(&["# branch.oid (initial)", "# branch.head main"]);
        let status = parse_status(&bytes, &root()).unwrap();
        assert_eq!(status.head, None);
        assert_eq!(status.branch.as_deref(), Some("main"));
    }

    #[test]
    fn a_staged_file_is_staged() {
        let bytes = porcelain(&["1 M. N... 100644 100644 100644 aaa bbb src/main.rs"]);
        let status = parse_status(&bytes, &root()).unwrap();
        assert_eq!(status.files.len(), 1);
        assert!(status.files[0].staged);
        assert_eq!(status.files[0].rel, "src/main.rs");
        assert_eq!(status.files[0].state, GitState::Modified);
    }

    #[test]
    fn staged_then_edited_again_appears_on_both_sides() {
        // The case that makes two rows the right model: `MM` means the index differs from
        // HEAD *and* the working tree differs from the index.
        let bytes = porcelain(&["1 MM N... 100644 100644 100644 aaa bbb src/main.rs"]);
        let status = parse_status(&bytes, &root()).unwrap();
        assert_eq!(status.files.len(), 2);
        assert!(status.files.iter().any(|file| file.staged));
        assert!(status.files.iter().any(|file| !file.staged));
    }

    #[test]
    fn a_rename_carries_its_source() {
        // A `2` record is followed by a second NUL-terminated field: the original path.
        let bytes = porcelain(&[
            "2 R. N... 100644 100644 100644 aaa bbb R100 src/new.rs",
            "src/old.rs",
            "? untracked.txt",
        ]);
        let status = parse_status(&bytes, &root()).unwrap();
        let renamed = &status.files[0];
        assert_eq!(renamed.state, GitState::Renamed);
        assert_eq!(renamed.rel, "src/new.rs");
        assert_eq!(renamed.from.as_deref(), Some("src/old.rs"));
        // The record after the rename's extra field must still be read as its own entry.
        assert!(status
            .files
            .iter()
            .any(|file| file.rel == "untracked.txt" && file.state == GitState::Untracked));
    }

    #[test]
    fn a_conflict_is_one_row_and_never_staged() {
        let bytes = porcelain(&[
            "u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.rs",
        ]);
        let status = parse_status(&bytes, &root()).unwrap();
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].state, GitState::Conflicted);
        assert!(!status.files[0].staged);
    }

    #[test]
    fn paths_with_spaces_survive() {
        let bytes = porcelain(&["? some dir/a file.txt"]);
        let status = parse_status(&bytes, &root()).unwrap();
        assert_eq!(status.files[0].rel, "some dir/a file.txt");
    }

    #[test]
    fn deletions_and_additions_get_their_own_states() {
        let bytes = porcelain(&[
            "1 A. N... 000000 100644 100644 000 bbb added.rs",
            "1 .D N... 100644 100644 000000 aaa bbb gone.rs",
        ]);
        let status = parse_status(&bytes, &root()).unwrap();
        assert_eq!(status.files[0].state, GitState::Added);
        assert!(status.files[0].staged);
        assert_eq!(status.files[1].state, GitState::Deleted);
        assert!(!status.files[1].staged);
    }

    #[test]
    fn a_nul_byte_makes_a_blob_binary() {
        assert!(decode(vec![0x89, 0x50, 0x00, 0x4e]).is_binary);
        assert_eq!(decode(b"fn main() {}".to_vec()).text.as_deref(), Some("fn main() {}"));
    }
}
