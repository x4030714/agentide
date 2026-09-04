//! Terminal sessions: a real shell in a pseudo-terminal, streamed to the webview.
//!
//! One [`Session`] is one pty and one child process, keyed by an id the frontend picks
//! so several can exist at once. `portable-pty` is the pty itself -- ConPTY on Windows,
//! `openpty` elsewhere -- and everything above it here is lifetime and transport.
//!
//! ## Output is bytes
//!
//! A pty produces bytes, and a read boundary falls wherever the OS puts it: mid-escape
//! sequence and mid-UTF-8-character are both normal. Decoding a chunk in isolation
//! corrupts the character that straddles it, so nothing here decodes. Output crosses to
//! the frontend as [`InvokeResponseBody::Raw`], which arrives in JavaScript as an
//! `ArrayBuffer`; xterm.js's `write(Uint8Array)` carries the incomplete tail of one
//! chunk into the next, which is exactly the state this module would otherwise have to
//! keep. Nothing is buffered here beyond the current batch -- scrollback belongs to the
//! terminal, which already has it.
//!
//! The same channel carries [`PtyEvent`] as JSON, so a session's output and its
//! lifecycle stay in order relative to each other. The frontend tells them apart by
//! type: an `ArrayBuffer` is output, an object is an event.
//!
//! ## Batching
//!
//! A build emits a lot, fast, and one channel message per pipe read would melt the
//! webview. Reads go to a forwarding thread over an mpsc queue; it coalesces them and
//! sends at most one message per [`DEBOUNCE`], or sooner once [`FLUSH_BYTES`] have piled
//! up. That is a ceiling of ~80 messages a second per session whatever the volume, and
//! 12ms of added latency on an echoed keystroke -- under one frame. Tauri sends a raw
//! payload over 1 KiB through its binary fetch path rather than an `eval`, so the
//! batched case is also the cheap one.
//!
//! ## Lifetime
//!
//! A pty is a child process, and nothing else stops it: it dies when its session is
//! killed, when a new session takes its id, and when the app exits (see [`shutdown`],
//! wired to `RunEvent::Exit` in `lib.rs` beside the agent's). When the child exits on
//! its own the session takes itself out of the state and reports the code, so a dead
//! terminal fails a write instead of silently swallowing it.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};

use crate::fs::WorkspaceState;
use crate::ipc::{ErrorCode, IpcError, PtyEvent, PtyInfo, PtySpawnOptions, WirePath};

/// One pipe read. Larger buys nothing: the forwarder coalesces anyway.
const READ_BUFFER: usize = 8 * 1024;

/// Send early rather than wait out the debounce once this much is pending.
const FLUSH_BYTES: usize = 64 * 1024;

/// How long output waits for more output before being sent. See the module docs.
const DEBOUNCE: Duration = Duration::from_millis(12);

/// How often an idle session checks whether its child is still there. The cost is one
/// non-blocking wait per session per tick; the benefit is that a terminal says its
/// process has exited within this long rather than whenever it next prints something.
const EXIT_POLL: Duration = Duration::from_millis(100);

/// What a terminal is until the frontend measures itself and resizes.
const DEFAULT_ROWS: u16 = 24;
const DEFAULT_COLS: u16 = 80;

/// The terminal type the child is told it is talking to. xterm.js is the terminal, so
/// this is a fact rather than a guess.
const TERM: &str = "xterm-256color";

// ---------------------------------------------------------------------------
// The ConPTY startup handshake
// ---------------------------------------------------------------------------

/// The cursor-position query conhost writes as a session's first output, and the answer
/// it waits for.
///
/// `portable-pty` creates every pseudoconsole with `PSEUDOCONSOLE_INHERIT_CURSOR` and
/// does not expose the flag. That flag makes conhost ask the terminal where the cursor
/// is and *hold the child process* until something answers: measured on Windows 10
/// 19045, an unanswered query stalls the child for around thirty seconds before conhost
/// gives up on it. So the answer is written at spawn, before anything is attached, and
/// the query is taken back out of the stream on the way to the frontend -- xterm.js
/// would answer it too, and conhost, no longer waiting for one, would hand that second
/// answer to the shell as if it had been typed.
#[cfg(windows)]
const CURSOR_QUERY: &[u8] = b"\x1b[6n";
#[cfg(windows)]
const CURSOR_REPLY: &[u8] = b"\x1b[1;1R";

/// Drop the startup query from the first chunk of a session's output.
///
/// Only ever applied to that first chunk: a program running in the pty may legitimately
/// ask for the cursor position later, and that one has to reach the terminal.
#[cfg(windows)]
fn strip_cursor_query(chunk: &[u8]) -> &[u8] {
    chunk.strip_prefix(CURSOR_QUERY).unwrap_or(chunk)
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/// Distinguishes a session from its replacement under the same id, so the thread
/// watching the old one cannot evict the new one when it notices its child has died.
static SERIAL: AtomicU64 = AtomicU64::new(1);

type Sessions = Arc<Mutex<HashMap<String, Session>>>;

struct Session {
    serial: u64,
    info: PtyInfo,
    /// Held for [`MasterPty::resize`], and because dropping it closes the pty.
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    /// Kills the child from here while the forwarding thread is blocked in `wait`.
    killer: Box<dyn ChildKiller + Send + Sync>,
}

impl Session {
    /// End the child, and the tree under it.
    ///
    /// Both halves matter on Windows: `kill` terminates the shell and nothing else,
    /// because there is no process group to signal, while dropping the master closes the
    /// pseudoconsole, which is what makes conhost send a close event to everything still
    /// attached to it. A `cargo build` started from the shell is reached by the second,
    /// not the first.
    fn kill(mut self) {
        let _ = self.killer.kill();
    }
}

/// The sessions Tauri manages. Cloned into each forwarding thread, which is how a
/// session whose child exits on its own takes itself out.
#[derive(Default)]
pub struct PtyState(Sessions);

// ---------------------------------------------------------------------------
// Commands
//
// Each one is a thin wrapper over a function taking the sessions directly: `State` has
// no constructor outside a running app, and these are worth testing.
// ---------------------------------------------------------------------------

/// Start a shell -- or `options.command` -- in a pty and stream it to `on_event`.
///
/// Spawning onto an id that is already running replaces it, killing the old one first.
/// `cwd` defaults to the open workspace and then to the home directory: a terminal is
/// useful before a folder is open, so this does not insist on one.
#[tauri::command]
pub fn pty_spawn(
    state: State<'_, PtyState>,
    workspace: State<'_, WorkspaceState>,
    options: PtySpawnOptions,
    on_event: Channel<InvokeResponseBody>,
) -> Result<PtyInfo, IpcError> {
    spawn(&state.0, workspace.root(), options, on_event)
}

/// Send keystrokes -- or anything else -- to the child's input.
///
/// Fails once the session is gone, which is the point: a terminal whose process has
/// exited must say so rather than absorb what is typed into it.
#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), IpcError> {
    write_input(&state.0, &id, &data)
}

/// Tell the child the terminal changed shape.
///
/// Not optional: a pty that is never resized keeps wrapping at the size it was opened
/// with, and the first time the pane changes width its output turns to garbage.
#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyState>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), IpcError> {
    resize(&state.0, &id, rows, cols)
}

/// End a session. Safe to call twice, and safe to call on one that already exited:
/// closing a tab should not depend on what the process did a moment earlier.
#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: String) {
    kill(&state.0, &id);
}

/// Kill every session on the way out of the app.
///
/// Tauri does not guarantee that managed state is dropped on exit, and a pty left
/// running keeps a shell -- and whatever it was building -- alive with no window
/// attached. Wired to `RunEvent::Exit` beside the agent sidecar's shutdown.
pub fn shutdown(app: &AppHandle) {
    let state = app.state::<PtyState>();
    let open: Vec<Session> = state
        .0
        .lock()
        .expect("pty sessions poisoned")
        .drain()
        .map(|(_, session)| session)
        .collect();
    for session in open {
        session.kill();
    }
}

// ---------------------------------------------------------------------------
// The work
// ---------------------------------------------------------------------------

fn spawn(
    sessions: &Sessions,
    root: Option<WirePath>,
    options: PtySpawnOptions,
    channel: Channel<InvokeResponseBody>,
) -> Result<PtyInfo, IpcError> {
    let cwd = working_directory(options.cwd, root)?;
    let argv = match (options.shell_command, options.command) {
        (Some(line), _) if !line.trim().is_empty() => shell_running(&line),
        // An empty `command` is a frontend bug, not a request to run `""`.
        (_, Some(command)) if !command.is_empty() => command,
        _ => resolve_shell(),
    };
    let size = size_of(options.rows, options.cols);

    let pair = native_pty_system()
        .openpty(size)
        .map_err(|err| IpcError::new(ErrorCode::Pty, format!("cannot open a pty: {err:#}")))?;

    let mut command = CommandBuilder::new(&argv[0]);
    for arg in &argv[1..] {
        command.arg(arg);
    }
    command.cwd(cwd.to_path());
    command.env("TERM", TERM);

    let child = pair.slave.spawn_command(command).map_err(|err| {
        IpcError::new(
            ErrorCode::Pty,
            format!("cannot start {} in a terminal: {err:#}", argv[0]),
        )
    })?;
    // Nothing else spawns into this pty, and on Unix a slave left open is a pty that
    // never reports EOF.
    drop(pair.slave);

    let mut writer = pair
        .master
        .take_writer()
        .map_err(|err| IpcError::new(ErrorCode::Pty, format!("cannot reach the pty: {err:#}")))?;
    let reader = pair.master.try_clone_reader().map_err(|err| {
        IpcError::new(ErrorCode::Pty, format!("cannot read from the pty: {err:#}"))
    })?;

    // See CURSOR_QUERY: on Windows the child does not run until this is answered.
    #[cfg(windows)]
    writer
        .write_all(CURSOR_REPLY)
        .and_then(|()| writer.flush())
        .map_err(|err| IpcError::from_io(&err, "cannot answer the terminal's startup query"))?;

    let serial = SERIAL.fetch_add(1, Ordering::Relaxed);
    let info = PtyInfo {
        id: options.id.clone(),
        program: argv[0].clone(),
        cwd,
        pid: child.process_id(),
        rows: size.rows,
        cols: size.cols,
    };
    let killer = child.clone_killer();
    let mut orphan = child.clone_killer();

    let (tx, rx) = mpsc::channel();
    let reading = format!("agentide-pty-read-{}", info.id);
    let forwarding = format!("agentide-pty-out-{}", info.id);
    let started = spawn_thread(&reading, move || read_output(reader, &tx)).and_then(|()| {
        let sessions = Arc::clone(sessions);
        let id = info.id.clone();
        spawn_thread(&forwarding, move || {
            forward_output(&rx, child, &channel, &sessions, &id, serial)
        })
    });
    if let Err(err) = started {
        // Nothing is watching this child, so it cannot be left running.
        let _ = orphan.kill();
        return Err(err);
    }

    let replaced = sessions.lock().expect("pty sessions poisoned").insert(
        options.id,
        Session {
            serial,
            info: info.clone(),
            master: pair.master,
            writer,
            killer,
        },
    );
    // Killed outside the lock: its forwarding thread takes the lock to clean up.
    if let Some(replaced) = replaced {
        replaced.kill();
    }
    Ok(info)
}

fn write_input(sessions: &Sessions, id: &str, data: &str) -> Result<(), IpcError> {
    let mut sessions = sessions.lock().expect("pty sessions poisoned");
    let session = sessions.get_mut(id).ok_or_else(|| gone(id))?;
    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|()| session.writer.flush())
        .map_err(|err| IpcError::from_io(&err, format!("cannot write to terminal {id}")))
}

fn resize(sessions: &Sessions, id: &str, rows: u16, cols: u16) -> Result<(), IpcError> {
    let mut sessions = sessions.lock().expect("pty sessions poisoned");
    let session = sessions.get_mut(id).ok_or_else(|| gone(id))?;
    let size = size_of(Some(rows), Some(cols));
    session.master.resize(size).map_err(|err| {
        IpcError::new(
            ErrorCode::Pty,
            format!("cannot resize terminal {id} to {rows}x{cols}: {err:#}"),
        )
    })?;
    session.info.rows = size.rows;
    session.info.cols = size.cols;
    Ok(())
}

fn kill(sessions: &Sessions, id: &str) {
    let session = sessions.lock().expect("pty sessions poisoned").remove(id);
    if let Some(session) = session {
        session.kill();
    }
}

fn gone(id: &str) -> IpcError {
    IpcError::new(
        ErrorCode::Pty,
        format!("terminal {id} is not running: its process has exited, or it never started"),
    )
}

fn size_of(rows: Option<u16>, cols: Option<u16>) -> PtySize {
    PtySize {
        // A zero-sized pty is a division by zero waiting to happen in whatever runs in
        // it, and the frontend measures zero while its pane is still hidden.
        rows: rows.filter(|rows| *rows > 0).unwrap_or(DEFAULT_ROWS),
        cols: cols.filter(|cols| *cols > 0).unwrap_or(DEFAULT_COLS),
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Where the shell starts: what the caller asked for, else the open workspace, else the
/// home directory.
fn working_directory(
    asked: Option<WirePath>,
    root: Option<WirePath>,
) -> Result<WirePath, IpcError> {
    let cwd = match asked.or(root) {
        Some(cwd) => cwd,
        None => {
            let home = home_directory().ok_or_else(|| {
                IpcError::new(
                    ErrorCode::Pty,
                    "no working directory for the terminal: open a folder, or pass one",
                )
            })?;
            WirePath::from_path(&home)?
        }
    };
    if !cwd.to_path().is_dir() {
        return Err(IpcError::new(
            ErrorCode::NotFound,
            format!("cannot start a terminal in {cwd}: not a directory"),
        ));
    }
    Ok(cwd)
}

fn home_directory() -> Option<PathBuf> {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(key).map(PathBuf::from)
}

/// The shell to run, as argv.
///
/// `AGENTIDE_SHELL` overrides everything -- one path, no arguments -- so this choice is
/// not baked in for good. Otherwise Windows prefers PowerShell 7, falls back to the
/// Windows PowerShell every install has, and lastly to `cmd.exe`; elsewhere it is
/// `$SHELL`.
fn resolve_shell() -> Vec<String> {
    if let Some(overridden) = std::env::var_os("AGENTIDE_SHELL") {
        return vec![overridden.to_string_lossy().into_owned()];
    }

    #[cfg(windows)]
    {
        if let Some(pwsh) = find_on_path("pwsh.exe") {
            return vec![pwsh.to_string_lossy().into_owned(), "-NoLogo".to_string()];
        }
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        let powershell =
            PathBuf::from(system_root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
        if powershell.is_file() {
            return vec![
                powershell.to_string_lossy().into_owned(),
                "-NoLogo".to_string(),
            ];
        }
        vec![std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string())]
    }
    #[cfg(not(windows))]
    {
        vec![std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())]
    }
}

/// The same shell as [`resolve_shell`], told to run one command line and then exit.
///
/// The flag differs by shell and getting it wrong is not a compile error -- PowerShell
/// takes `-Command`, `cmd.exe` takes `/C`, and a POSIX shell takes `-c` -- so the choice
/// is made here, once, from the argv that function already resolved rather than from a
/// second guess about which shell is in use.
///
/// `-NoLogo` is dropped and `-NoProfile` added for PowerShell: a profile can print a
/// banner, change the prompt, or take a second to load, and every byte of that would
/// arrive as if it were the command's own output.
fn shell_running(line: &str) -> Vec<String> {
    let shell = resolve_shell();
    let program = shell.first().cloned().unwrap_or_default();
    let lower = program.to_lowercase();

    if lower.ends_with("pwsh.exe") || lower.ends_with("powershell.exe") || lower.ends_with("pwsh") {
        return vec![
            program,
            "-NoLogo".to_string(),
            "-NoProfile".to_string(),
            "-Command".to_string(),
            line.to_string(),
        ];
    }
    if lower.ends_with("cmd.exe") {
        return vec![program, "/C".to_string(), line.to_string()];
    }
    vec![program, "-c".to_string(), line.to_string()]
}

/// First match for `name` in `PATH`. Only ever asked for `pwsh.exe`, which is why it
/// does not bother with `PATHEXT`: the name it is given already carries the extension.
#[cfg(windows)]
fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

fn spawn_thread(name: &str, body: impl FnOnce() + Send + 'static) -> Result<(), IpcError> {
    std::thread::Builder::new()
        .name(name.to_string())
        .spawn(body)
        .map(drop)
        .map_err(|err| {
            IpcError::new(
                ErrorCode::Pty,
                format!("cannot start the {name} thread: {err}"),
            )
        })
}

/// Read the pty until it ends, handing every chunk to the forwarder.
///
/// Deliberately does no batching of its own: it has to be back in `read` as soon as it
/// can, because the pipe it is draining is what the child blocks on when it fills.
fn read_output(mut reader: Box<dyn Read + Send>, tx: &Sender<Vec<u8>>) {
    let mut buffer = vec![0u8; READ_BUFFER];
    #[cfg(windows)]
    let mut first = true;

    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => return,
            Ok(read) => read,
            // A pty that has been closed reads as an error rather than as EOF on
            // Windows. Either way there is nothing more to read, and the exit path
            // explains what happened.
            Err(_) => return,
        };
        let chunk = &buffer[..read];
        #[cfg(windows)]
        let chunk = if first {
            first = false;
            strip_cursor_query(chunk)
        } else {
            chunk
        };
        if chunk.is_empty() {
            continue;
        }
        if tx.send(chunk.to_vec()).is_err() {
            // The forwarder is gone, so nobody is listening any more.
            return;
        }
    }
}

/// Coalesce output onto the frontend channel, watch for the child to end, and report
/// how it did.
///
/// Owns the child so that the exit code is read on the thread that already knows the
/// output has finished -- which is what makes `exited` the last thing a session sends.
///
/// It has to *watch*: on Windows the write end of the output pipe belongs to conhost,
/// not to the child, so the reader sees no EOF when the child exits and would sit there
/// forever. Closing the pty is what ends the read, and closing it is this thread's job
/// once it has seen the child go.
fn forward_output(
    rx: &Receiver<Vec<u8>>,
    mut child: Box<dyn Child + Send + Sync>,
    channel: &Channel<InvokeResponseBody>,
    sessions: &Sessions,
    id: &str,
    serial: u64,
) {
    let mut pending: Vec<u8> = Vec::new();
    let mut deadline: Option<Instant> = None;
    let mut status = None;

    loop {
        let wait = match deadline {
            Some(at) => at.saturating_duration_since(Instant::now()),
            None => EXIT_POLL,
        };
        match rx.recv_timeout(wait) {
            Ok(chunk) => {
                pending.extend_from_slice(&chunk);
                if deadline.is_none() {
                    deadline = Some(Instant::now() + DEBOUNCE);
                }
                if pending.len() < FLUSH_BYTES {
                    continue;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                let _ = flush(&mut pending, channel);
                break;
            }
        }

        deadline = None;
        if flush(&mut pending, channel).is_err() {
            // The webview is gone. Nobody can see this terminal or type into it, and the
            // queue behind us would grow without limit, so end the session -- by killing
            // rather than only closing, because the wait below has to come back.
            let _ = child.kill();
            break;
        }
        if status.is_none() {
            status = child.try_wait().ok().flatten();
            if status.is_some() {
                // Closing the pty here rather than after the loop: the reader drains
                // whatever conhost still had buffered, then sees EOF, and its last chunk
                // arrives on the next turn of this loop instead of being dropped.
                close(sessions, id, serial);
            }
        }
    }

    // Whichever way the loop ended, the session is over: close the pty so the reader
    // stops, and so the child is reached by the close event if it is somehow still up.
    close(sessions, id, serial);
    let exited = match status.map(Ok).unwrap_or_else(|| child.wait()) {
        Ok(status) => PtyEvent::Exited {
            id: id.to_string(),
            code: Some(status.exit_code()),
            signal: status.signal().map(str::to_string),
            message: describe(&status),
        },
        Err(err) => PtyEvent::Exited {
            id: id.to_string(),
            code: None,
            signal: None,
            message: format!("the terminal's process is gone: {err}"),
        },
    };
    let _ = channel.send(encode(&exited));
}

/// Take a session out of the state, unless its id has already been given to a new one.
///
/// Dropping what comes back closes the pty, which is the point: a terminal that is over
/// must not keep a pseudoconsole open, and the read side does not end until it does.
fn close(sessions: &Sessions, id: &str, serial: u64) {
    let mut sessions = sessions.lock().expect("pty sessions poisoned");
    if sessions.get(id).is_some_and(|open| open.serial == serial) {
        sessions.remove(id);
    }
}

fn describe(status: &portable_pty::ExitStatus) -> String {
    match (status.success(), status.signal()) {
        (true, _) => "the terminal's process exited".to_string(),
        (false, Some(signal)) => format!("the terminal's process was killed by {signal}"),
        (false, None) => format!(
            "the terminal's process exited with code {}",
            status.exit_code()
        ),
    }
}

fn flush(pending: &mut Vec<u8>, channel: &Channel<InvokeResponseBody>) -> Result<(), tauri::Error> {
    if pending.is_empty() {
        return Ok(());
    }
    channel.send(InvokeResponseBody::Raw(std::mem::take(pending)))
}

/// A [`PtyEvent`] as the channel's other shape. Serializing a fixed enum of owned
/// strings cannot fail; the fallback keeps that promise out of the caller's way.
fn encode(event: &PtyEvent) -> InvokeResponseBody {
    InvokeResponseBody::Json(
        serde_json::to_string(event).unwrap_or_else(|_| r#"{"t":"exited"}"#.to_string()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Long enough for a process to start and exit on a loaded machine, short enough
    /// that a hang fails the test rather than outliving the suite's patience.
    const DEADLINE: Duration = Duration::from_secs(20);

    #[derive(Default)]
    struct Seen {
        output: Vec<u8>,
        events: Vec<serde_json::Value>,
    }

    /// A channel that keeps what it was sent, standing in for the webview.
    fn collector() -> (Channel<InvokeResponseBody>, Arc<Mutex<Seen>>) {
        let seen = Arc::new(Mutex::new(Seen::default()));
        let sink = Arc::clone(&seen);
        let channel: Channel<InvokeResponseBody> = Channel::new(move |body| {
            let mut sink = sink.lock().expect("collector poisoned");
            match body {
                InvokeResponseBody::Raw(bytes) => sink.output.extend_from_slice(&bytes),
                InvokeResponseBody::Json(text) => {
                    sink.events
                        .push(serde_json::from_str(&text).expect("event is not json"));
                }
            }
            Ok(())
        });
        (channel, seen)
    }

    fn options(id: &str, command: Option<Vec<String>>) -> PtySpawnOptions {
        PtySpawnOptions {
            id: id.to_string(),
            // The scratch directory always exists, and no test writes into it.
            cwd: Some(WirePath::from_path(&std::env::temp_dir()).expect("temp dir")),
            command,
            shell_command: None,
            rows: Some(24),
            cols: Some(80),
        }
    }

    fn argv(parts: &[&str]) -> Option<Vec<String>> {
        Some(parts.iter().map(|part| (*part).to_string()).collect())
    }

    /// Prints `marker` and exits 0.
    fn echo(marker: &str) -> Option<Vec<String>> {
        if cfg!(windows) {
            argv(&["cmd.exe", "/c", "echo", marker])
        } else {
            argv(&["/bin/sh", "-c", &format!("echo {marker}")])
        }
    }

    /// Runs for a few seconds, so a test has time to resize and kill it.
    fn sleeper() -> Option<Vec<String>> {
        if cfg!(windows) {
            argv(&["cmd.exe", "/c", "ping", "-n", "5", "127.0.0.1"])
        } else {
            argv(&["/bin/sh", "-c", "sleep 5"])
        }
    }

    /// Wait for the session to report that it ended, or fail the test.
    fn await_exit(seen: &Arc<Mutex<Seen>>) -> serde_json::Value {
        let until = Instant::now() + DEADLINE;
        while Instant::now() < until {
            if let Some(event) = seen
                .lock()
                .expect("collector poisoned")
                .events
                .first()
                .cloned()
            {
                return event;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!(
            "no exit event within {DEADLINE:?}; output so far: {:?}",
            text(seen)
        );
    }

    fn text(seen: &Arc<Mutex<Seen>>) -> String {
        String::from_utf8_lossy(&seen.lock().expect("collector poisoned").output).into_owned()
    }

    #[test]
    fn runs_a_command_and_reports_how_it_ended() {
        let sessions = Sessions::default();
        let (channel, seen) = collector();
        let info = spawn(
            &sessions,
            None,
            options("run", echo("agentide-pty-marker")),
            channel,
        )
        .expect("spawn failed");
        assert_eq!(info.id, "run");
        assert!(info.pid.is_some(), "the child has no pid");

        let event = await_exit(&seen);
        assert_eq!(event["t"], "exited", "{event}");
        assert_eq!(event["id"], "run", "{event}");
        assert_eq!(event["code"], 0, "{event}");
        let output = text(&seen);
        assert!(
            output.contains("agentide-pty-marker"),
            "the command's output never arrived: {output:?}"
        );
        // The startup handshake is answered here and must not reach the frontend.
        assert!(!output.contains("\x1b[6n"), "the cursor query leaked: {output:?}");
        // A session that ended takes itself out of the state.
        assert!(
            sessions.lock().expect("poisoned").is_empty(),
            "the finished session was left behind"
        );
    }

    #[test]
    fn a_failing_command_reports_its_code() {
        let sessions = Sessions::default();
        let (channel, seen) = collector();
        let command = if cfg!(windows) {
            argv(&["cmd.exe", "/c", "exit", "3"])
        } else {
            argv(&["/bin/sh", "-c", "exit 3"])
        };
        spawn(&sessions, None, options("fail", command), channel).expect("spawn failed");

        let event = await_exit(&seen);
        assert_eq!(event["code"], 3, "{event}");
        assert!(
            event["message"].as_str().is_some_and(|say| say.contains('3')),
            "{event}"
        );
    }

    #[test]
    fn writes_resizes_and_kills_a_live_session() {
        let sessions = Sessions::default();
        let (channel, _seen) = collector();
        spawn(&sessions, None, options("live", sleeper()), channel).expect("spawn failed");

        write_input(&sessions, "live", "\r").expect("write failed");
        resize(&sessions, "live", 40, 120).expect("resize failed");
        {
            let open = sessions.lock().expect("poisoned");
            let info = &open["live"].info;
            assert_eq!((info.rows, info.cols), (40, 120));
        }

        // Twice is what closing a tab does when the process already exited.
        kill(&sessions, "live");
        kill(&sessions, "live");
        assert!(sessions.lock().expect("poisoned").is_empty());
    }

    #[test]
    fn spawning_onto_a_live_id_replaces_it() {
        let sessions = Sessions::default();
        let (first_channel, first_seen) = collector();
        let first =
            spawn(&sessions, None, options("tab", sleeper()), first_channel).expect("first spawn");
        let (second_channel, _second_seen) = collector();
        let second = spawn(&sessions, None, options("tab", sleeper()), second_channel)
            .expect("second spawn");
        assert_ne!(first.pid, second.pid, "the same process twice");

        // The replaced session says it ended -- and the reporting comes after it has
        // cleaned up, so what is in the state afterwards is settled, not a race.
        let event = await_exit(&first_seen);
        assert_eq!(event["id"], "tab", "{event}");
        assert!(
            sessions.lock().expect("poisoned").contains_key("tab"),
            "the replaced session took its replacement with it"
        );
        kill(&sessions, "tab");
    }

    #[test]
    fn a_session_that_is_not_open_fails_loudly() {
        let sessions = Sessions::default();
        for err in [
            write_input(&sessions, "nope", "ls").unwrap_err(),
            resize(&sessions, "nope", 10, 10).unwrap_err(),
        ] {
            assert_eq!(err.code, ErrorCode::Pty);
            assert!(err.message.contains("nope"), "{}", err.message);
        }
        // Killing one is not an error: the frontend closes tabs it may have already lost.
        kill(&sessions, "nope");
    }

    #[test]
    fn a_missing_program_fails_the_spawn_rather_than_the_session() {
        let sessions = Sessions::default();
        let (channel, _seen) = collector();
        let command = argv(&["agentide-no-such-program-8f2a"]);
        let err = spawn(&sessions, None, options("missing", command), channel)
            .expect_err("a program that does not exist must not spawn");
        assert_eq!(err.code, ErrorCode::Pty);
        assert!(sessions.lock().expect("poisoned").is_empty());
    }

    #[test]
    fn the_working_directory_falls_back_before_it_fails() {
        let root = WirePath::from_path(&std::env::temp_dir()).expect("temp dir");
        let asked = WirePath::from_path(&std::env::current_dir().expect("cwd")).expect("cwd");
        assert_eq!(
            working_directory(Some(asked.clone()), Some(root.clone())).expect("asked"),
            asked
        );
        assert_eq!(
            working_directory(None, Some(root.clone())).expect("root"),
            root
        );
        // No workspace open: the home directory, which every platform this runs on has.
        assert!(working_directory(None, None).is_ok());

        let missing = WirePath::from_path(&std::env::temp_dir().join("agentide-no-such-dir-8f2a"))
            .expect("path");
        assert_eq!(
            working_directory(Some(missing), None)
                .expect_err("a directory that is not there")
                .code,
            ErrorCode::NotFound
        );
    }

    #[test]
    fn the_shell_resolves_to_something_runnable() {
        let argv = resolve_shell();
        assert!(!argv.is_empty() && !argv[0].is_empty());
        #[cfg(windows)]
        {
            // Every branch but `cmd.exe` from `ComSpec` yields a full path.
            assert!(
                std::path::Path::new(&argv[0]).is_file() || argv[0] == "cmd.exe",
                "the shell resolved to {argv:?}, which is not there"
            );
        }
    }

    /// The startup query is answered by this module, so the frontend must never see it;
    /// anything after it in the same chunk has to survive.
    #[cfg(windows)]
    #[test]
    fn the_startup_cursor_query_is_taken_out_of_the_first_chunk() {
        assert_eq!(strip_cursor_query(b"\x1b[6n"), b"");
        assert_eq!(strip_cursor_query(b"\x1b[6nhello"), b"hello");
        // Anywhere but the front it is a program's own query, and has to reach the terminal.
        assert_eq!(strip_cursor_query(b"hi\x1b[6n"), b"hi\x1b[6n");
        assert_eq!(strip_cursor_query(b""), b"");
    }
}
