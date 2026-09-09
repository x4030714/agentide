//! The programs agentide ships rather than assumes: rust-analyzer, and a git.
//!
//! Bundled first, PATH second. A user who has their own newer rust-analyzer keeps it by
//! putting it on PATH; one who has nothing gets a working IDE out of the installer.

use std::path::PathBuf;
use std::sync::OnceLock;

/// Where the packaged app keeps its resources, set once at startup from `lib.rs`.
static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn set_resource_dir(dir: PathBuf) {
    let _ = RESOURCE_DIR.set(dir);
}

/// Where the staged tools live, installed or in the repository.
fn tools_dir() -> Option<PathBuf> {
    if let Some(overridden) = std::env::var_os("AGENTIDE_TOOLS") {
        return Some(PathBuf::from(overridden));
    }
    if let Some(resources) = RESOURCE_DIR.get() {
        let staged = resources.join("tools");
        if staged.is_dir() {
            return Some(staged);
        }
    }
    // `cargo run` and the smoke test, where nothing has been bundled yet.
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tools");
    repo.is_dir().then_some(repo)
}

/// The relative path a tool sits at inside `tools/`, or `None` if we do not ship it.
fn bundled_path(program: &str) -> Option<&'static str> {
    match program {
        "rust-analyzer" => Some("rust-analyzer/rust-analyzer.exe"),
        // MinGit's `cmd/git.exe` is the launcher that finds its own libexec beside it;
        // running `mingw64/bin/git.exe` directly works for plumbing and then fails on the
        // first command that needs a helper.
        "git" => Some("git/cmd/git.exe"),
        _ => None,
    }
}

/// What to actually spawn for `program`.
///
/// A bundled copy only wins when the user has none of their own: someone who installed
/// rust-analyzer deliberately, or who is on a git newer than the one we pinned, should keep
/// it. Falling back to the name lets the OS resolve it exactly as before.
pub fn resolve(program: &str) -> PathBuf {
    if on_path(program) {
        return PathBuf::from(program);
    }
    if let (Some(dir), Some(relative)) = (tools_dir(), bundled_path(program)) {
        let candidate = dir.join(relative);
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from(program)
}

/// Whether the OS would find `program` itself. One stat per PATH entry, which is cheaper
/// than spawning it to ask.
pub fn on_path(program: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    let extensions: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT".into())
            .split(';')
            .map(str::to_ascii_lowercase)
            .collect()
    } else {
        vec![String::new()]
    };
    std::env::split_paths(&path).any(|dir| {
        extensions
            .iter()
            .any(|extension| dir.join(format!("{program}{extension}")).is_file())
    })
}

/// Whether a turn could authenticate right now.
///
/// One fact, asked synchronously so the readiness banner can clear the moment a sign-in
/// finishes rather than waiting for a turn. The full rule -- providers, the environment,
/// every problem worth reporting -- lives in `sidecar/src/doctor.ts`; this is only the
/// half that changes while the window is open.
#[tauri::command]
pub fn tools_signed_in() -> bool {
    if std::env::var_os("ANTHROPIC_API_KEY").is_some()
        || std::env::var_os("ANTHROPIC_AUTH_TOKEN").is_some()
    {
        return true;
    }
    let config = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs_home().map(|home| home.join(".claude")));
    config
        .map(|dir| dir.join(".credentials.json").is_file())
        .unwrap_or(false)
}

/// The user's home, however this platform spells it.
fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_program_on_path_is_used_as_named() {
        // Not rewritten to an absolute path: the OS resolving it is the behaviour every
        // other tool in this app already relies on.
        assert_eq!(resolve("cmd").to_string_lossy(), "cmd");
    }

    #[test]
    fn a_program_we_do_not_ship_falls_through_to_its_name() {
        // The spawn then fails with the OS's own "not found", which names the program --
        // better than this module inventing an error for a tool it knows nothing about.
        assert_eq!(
            resolve("definitely-not-a-real-program").to_string_lossy(),
            "definitely-not-a-real-program"
        );
    }

    #[test]
    fn nonsense_is_not_on_path() {
        assert!(!on_path("definitely-not-a-real-program"));
    }

    #[test]
    fn the_bundled_names_are_the_two_we_stage() {
        // Drift here is silent: a renamed directory means the bundled copy is never found
        // and every machine quietly falls back to PATH.
        assert!(bundled_path("rust-analyzer").is_some());
        assert!(bundled_path("git").is_some());
        assert!(bundled_path("node").is_none());
    }
}
