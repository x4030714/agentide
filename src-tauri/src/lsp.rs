//! Language servers: spawn one, frame its stdio, stream what it says to the webview.
//!
//! One [`Session`] is one language server process, keyed by an id the frontend picks --
//! in practice one per language per workspace -- so several can exist at once. The shape
//! is `pty.rs`'s: a child process, reader threads, a coalescing forwarder onto a
//! [`Channel`], and an exit that is reported rather than inferred.
//!
//! ## This module is a pipe, not a client
//!
//! It does not model LSP. There is no request table, no id correlation, no capability
//! handling, no `initialize`, no notion of which server serves which language. All of
//! that lives in TypeScript beside the Monaco providers, which is the point: the protocol
//! is understood in exactly one place, and that place is the one that also has to turn it
//! into completions and diagnostics. What this module owns is the parts TypeScript cannot
//! do -- a child process, its two pipes, its framing, and its death.
//!
//! Concretely, that means a request this module forwards is a request it has no opinion
//! about. It never times one out, never retries one, and never synthesizes a reply.
//!
//! ## Framing
//!
//! LSP on stdio is `Content-Length: N\r\n\r\n` followed by exactly N *bytes* of UTF-8
//! JSON, in both directions. [`FrameDecoder`] reassembles that from arbitrary chunks: a
//! pipe read boundary falls wherever the OS puts it, so a header split mid-`Content-`, a
//! payload split across four reads and six whole messages in one read are all the normal
//! case rather than the edge case. Getting this wrong does not look like a crash -- it
//! looks like a language server that starts and then does nothing -- so the decoder is
//! tested on its own, byte by byte.
//!
//! N counts bytes, never characters. The decoder works in bytes throughout and only
//! decodes UTF-8 once a whole payload is in hand, which is what makes a multibyte
//! character straddling a chunk boundary a non-event.
//!
//! ## Messages cross without being read
//!
//! A message goes up as [`RawJson`]: `serde_json` writes the server's own bytes straight
//! into the channel payload. No `Value` tree is built here, so key order, number spelling
//! and precision survive untouched, and the webview's single `JSON.parse` of the payload
//! is the only parse anyone performs -- the messages arrive already-objects, nested in
//! the event. The one thing checked on the way through is that the payload really is
//! well-formed UTF-8 JSON; a scan, not a parse tree. A payload that fails that check is
//! not dropped, it is reported on [`LspEvent::Stderr`], because a message the frontend
//! never sees is indistinguishable from a server doing nothing.
//!
//! ## Batching
//!
//! rust-analyzer is *loud*. Indexing a large crate emits `$/progress` notifications by
//! the hundred per second, and one channel message each would melt the webview the same
//! way unbatched pty output would. So messages are coalesced into
//! [`LspEvent::Messages`] -- an array, not a concatenation, which is why batching is safe
//! here at all: boundaries and order are preserved exactly, so the frontend's correlation
//! by id is untouched. It loops over the array instead of handling one message.
//!
//! The limiter is a rate cap rather than the pty's debounce, because the workloads
//! differ. Terminal output is always a stream and 12ms of latency on it is invisible; an
//! LSP response is a reply to something the user just did, and a flat 12ms added to every
//! hover is not free. So the first message after a quiet period goes out immediately, and
//! only then does a [`SEND_INTERVAL`] window open during which further messages
//! accumulate. Idle server: zero added latency. Indexing server: at most ~80 channel
//! messages a second whatever it does. [`FLUSH_BYTES`] cuts the window short when a batch
//! grows large enough that holding it costs more than sending it.
//!
//! ## Slow is not dead
//!
//! rust-analyzer can take minutes to become useful on a large workspace, and for most of
//! that time the correct behaviour is to wait. Nothing here interprets silence: there is
//! no timeout, so nothing can decide a busy server is a broken one. Death is instead
//! reported positively -- the forwarder watches the process, and the moment it goes the
//! session is taken out of the state and [`LspEvent::Exited`] is sent carrying the code
//! and the tail of stderr. The frontend's rule follows from that: keep waiting until
//! `exited` arrives, then fail everything outstanding at once. Sending to an id that has
//! exited fails immediately rather than being swallowed, so a request cannot hang on a
//! server that is already gone.
//!
//! ## Lifetime
//!
//! Same discipline as the pty. A server dies when its session is stopped, when a new
//! session takes its id, and when the app exits (see [`shutdown`], wired to
//! `RunEvent::Exit` in `lib.rs` beside the pty's and the agent's). Stopping closes stdin
//! first and only kills after a grace period: stdin EOF is how a language server is told
//! to go, and rust-analyzer has `cargo` children of its own that a bare kill would orphan
//! on Windows, where there is no process group to signal.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::fs::WorkspaceState;
use crate::ipc::{ErrorCode, IpcError, LspEvent, LspInfo, LspStartOptions, RawJson, WirePath};

/// One pipe read. Larger buys nothing: the forwarder coalesces anyway.
const READ_BUFFER: usize = 32 * 1024;

/// The largest `Content-Length` that is treated as a message rather than as evidence the
/// stream has desynchronized. Generous on purpose -- a `textDocument/semanticTokens/full`
/// response for a large file runs to megabytes -- but not unbounded, because length
/// framing has no resynchronization point: past this the only honest move is to stop
/// reading and report it.
const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

/// The largest header block accepted before the stream is called desynchronized. A real
/// header block is two short lines; anything approaching this is not one.
const MAX_HEADER_BYTES: usize = 8 * 1024;

/// The shortest gap between channel messages for one server. See the batching notes.
const SEND_INTERVAL: Duration = Duration::from_millis(12);

/// Cut the batching window short once this much is pending.
const FLUSH_BYTES: usize = 512 * 1024;

/// How often an idle forwarder checks whether its server is still there.
const EXIT_POLL: Duration = Duration::from_millis(100);

/// How long a server gets to exit after its stdin closes, before it is killed.
const SHUTDOWN_GRACE: Duration = Duration::from_millis(1500);

/// How often to check whether it has.
const SHUTDOWN_POLL: Duration = Duration::from_millis(20);

/// How many stderr lines to keep so a server that dies can explain itself in its exit
/// message. The startup complaint is what matters, but it is the tail that is affordable.
const STDERR_TAIL: usize = 40;

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/// Reassembles `Content-Length`-framed messages from arbitrary byte chunks.
///
/// Header state is kept rather than rediscovered: with `expect` set, a payload arriving
/// over hundreds of reads costs one append each, where re-scanning the buffer for the
/// header terminator every time would be quadratic in the size of the message.
struct FrameDecoder {
    /// Bytes not yet turned into a message: a partial header, or a partial payload.
    carry: Vec<u8>,
    /// Payload bytes still owed, once a header has been read. `None` while reading one.
    expect: Option<usize>,
    max_message_bytes: usize,
}

impl FrameDecoder {
    fn new(max_message_bytes: usize) -> Self {
        Self {
            carry: Vec::new(),
            expect: None,
            max_message_bytes,
        }
    }

    /// Append `chunk` and push every complete payload it finishes onto `out`.
    ///
    /// The error case is terminal for the stream: a bad header or an impossible length
    /// means the byte positions are no longer trustworthy, and unlike newline framing
    /// there is no next delimiter to resynchronize on.
    fn push(&mut self, chunk: &[u8], out: &mut Vec<Vec<u8>>) -> Result<(), IpcError> {
        self.carry.extend_from_slice(chunk);
        loop {
            let expect = match self.expect {
                Some(expect) => expect,
                None => match self.take_header()? {
                    Some(expect) => expect,
                    None => return Ok(()),
                },
            };
            if self.carry.len() < expect {
                return Ok(());
            }
            let rest = self.carry.split_off(expect);
            out.push(std::mem::replace(&mut self.carry, rest));
            self.expect = None;
        }
    }

    /// Read one header block off the front of the carry, returning the payload length.
    /// `None` means the block is not all here yet.
    fn take_header(&mut self) -> Result<Option<usize>, IpcError> {
        let Some(at) = find(&self.carry, b"\r\n\r\n") else {
            if self.carry.len() > MAX_HEADER_BYTES {
                return Err(desynchronized(format!(
                    "a header ran past {MAX_HEADER_BYTES} bytes with no end"
                )));
            }
            return Ok(None);
        };
        let block = std::str::from_utf8(&self.carry[..at])
            .map_err(|err| desynchronized(format!("a header is not valid UTF-8: {err}")))?
            .to_string();
        self.carry.drain(..at + 4);

        let mut length = None;
        for line in block.split("\r\n") {
            let Some((name, value)) = line.split_once(':') else {
                return Err(desynchronized(format!("a header has no colon: {line:?}")));
            };
            // Case-insensitively, because a header name always is, and a server that
            // spells it `content-length` should not look like a server that hung.
            if !name.trim().eq_ignore_ascii_case("Content-Length") {
                // Content-Type is the only other one anyone sends, and it says nothing
                // this needs: LSP payloads are UTF-8 by definition.
                continue;
            }
            length = Some(value.trim().parse::<usize>().map_err(|err| {
                desynchronized(format!("Content-Length {:?} is not a number: {err}", value.trim()))
            })?);
        }

        let length = length.ok_or_else(|| {
            desynchronized(format!("a header block has no Content-Length: {block:?}"))
        })?;
        if length > self.max_message_bytes {
            return Err(desynchronized(format!(
                "Content-Length is {length} bytes, past the {} byte ceiling",
                self.max_message_bytes
            )));
        }
        self.carry.reserve(length.saturating_sub(self.carry.len()));
        self.expect = Some(length);
        Ok(Some(length))
    }

    /// How much is buffered at end of stream. A server that stopped cleanly leaves none.
    fn pending(&self) -> usize {
        self.carry.len()
    }
}

/// First index of `needle` in `haystack`.
fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Frame one message for the server's stdin. The length is bytes, which is what
/// `str::len` already is.
fn encode(message: &str) -> Vec<u8> {
    let mut framed = Vec::with_capacity(message.len() + 32);
    framed.extend_from_slice(format!("Content-Length: {}\r\n\r\n", message.len()).as_bytes());
    framed.extend_from_slice(message.as_bytes());
    framed
}

fn desynchronized(detail: String) -> IpcError {
    IpcError::new(
        ErrorCode::Lsp,
        format!("the language server's output cannot be framed: {detail}"),
    )
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/// Distinguishes a session from its replacement under the same id, so the thread watching
/// the old one cannot evict the new one when it notices its process has died.
static SERIAL: AtomicU64 = AtomicU64::new(1);

type Sessions = Arc<Mutex<HashMap<String, Session>>>;

struct Session {
    serial: u64,
    /// `None` once closed: closing it is how a language server is told to exit.
    stdin: Option<ChildStdin>,
    /// Shared with the forwarder, which waits on it. See [`await_exit`].
    process: Arc<Mutex<Child>>,
}

impl Session {
    /// End the server: ask first, insist after [`SHUTDOWN_GRACE`].
    ///
    /// Closing stdin rather than killing outright is not politeness. rust-analyzer runs
    /// `cargo` as a child of its own, and on Windows there is no process group to signal,
    /// so a server that is killed where it stands leaves that build running.
    fn stop(mut self) {
        drop(self.stdin.take());
        if await_exit(&self.process, Instant::now() + SHUTDOWN_GRACE).is_none() {
            let mut child = self.process.lock().expect("lsp process poisoned");
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Poll until the child exits or `deadline` passes. `None` means it is still running.
///
/// The lock is released around each sleep so the forwarder and a stop can wait on the
/// same child at once without either blocking the other.
fn await_exit(process: &Mutex<Child>, deadline: Instant) -> Option<Option<i32>> {
    loop {
        {
            let mut child = process.lock().expect("lsp process poisoned");
            match child.try_wait() {
                Ok(Some(status)) => return Some(status.code()),
                // Already reaped by the other waiter; the code went with it.
                Err(_) => return Some(None),
                Ok(None) => {}
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(SHUTDOWN_POLL);
    }
}

/// The servers Tauri manages. Cloned into each forwarding thread, which is how a session
/// whose process exits on its own takes itself out.
#[derive(Default)]
pub struct LspState(Sessions);

// ---------------------------------------------------------------------------
// Commands
//
// Each one is a thin wrapper over a function taking the sessions directly: `State` has no
// constructor outside a running app, and these are worth testing.
// ---------------------------------------------------------------------------

/// Start a language server and stream it to `on_event`.
///
/// Starting onto an id that is already running replaces it, stopping the old one first.
/// This resolves `options.command[0]` against `PATH` and nothing more -- there is no
/// table of known servers here, because which server serves which language is the
/// frontend's decision. A server that is not installed fails here with `notFound`, at
/// once, rather than becoming a session that never answers.
#[tauri::command]
pub async fn lsp_start(
    state: State<'_, LspState>,
    workspace: State<'_, WorkspaceState>,
    options: LspStartOptions,
    on_event: Channel<LspEvent>,
) -> Result<LspInfo, IpcError> {
    start(&state.0, workspace.root(), options, on_event)
}

/// Send one JSON-RPC message. Framing is added here; the message itself is the
/// frontend's, unread.
///
/// Fails once the session is gone, which is the point: a request written into a server
/// that has exited would otherwise wait for a reply that cannot come.
// Boxed because `RawValue` is unsized. Borrowing it is not an option either: Tauri
// deserializes a command argument out of an owned `serde_json::Value`, so there is nothing
// with the right lifetime to borrow from.
#[allow(clippy::boxed_local)]
#[tauri::command]
pub fn lsp_send(state: State<'_, LspState>, id: String, message: RawJson) -> Result<(), IpcError> {
    send(&state.0, &id, message.get())
}

/// Stop a server. Safe to call twice, and safe to call on one that already exited.
///
/// Returns as soon as the process is gone, which is usually immediate: closing stdin is
/// what a language server waits for. The session reports `exited` on its channel either
/// way, so the frontend needs only that one path to fail outstanding requests.
#[tauri::command]
pub fn lsp_stop(state: State<'_, LspState>, id: String) {
    stop(&state.0, &id);
}

/// Stop every server on the way out of the app.
///
/// Tauri does not guarantee that managed state is dropped on exit, and rust-analyzer left
/// running is a process holding a whole crate graph in memory with no window attached.
/// Wired to `RunEvent::Exit` beside the pty's and the agent's.
pub fn shutdown(app: &AppHandle) {
    let state = app.state::<LspState>();
    let open: Vec<Session> = state
        .0
        .lock()
        .expect("lsp sessions poisoned")
        .drain()
        .map(|(_, session)| session)
        .collect();
    for session in open {
        session.stop();
    }
}

// ---------------------------------------------------------------------------
// The work
// ---------------------------------------------------------------------------

fn start(
    sessions: &Sessions,
    workspace: Option<WirePath>,
    options: LspStartOptions,
    channel: Channel<LspEvent>,
) -> Result<LspInfo, IpcError> {
    let argv = options.command;
    // An empty command is a frontend bug, not a request to run `""`.
    let program = argv.first().filter(|first| !first.is_empty()).ok_or_else(|| {
        IpcError::new(
            ErrorCode::Lsp,
            format!("language server {} was started with no command", options.id),
        )
    })?;
    let root = root_directory(options.root, workspace)?;

    let mut command = Command::new(program);
    command
        .args(&argv[1..])
        .current_dir(root.to_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // The server inherits this process's environment deliberately: rust-analyzer finds
    // its toolchain through PATH, and clangd its resource directory the same way.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        /// Without this a console window flashes up behind the app on every start.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn().map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            IpcError::new(
                ErrorCode::NotFound,
                format!("{program} is not installed, or not on PATH"),
            )
        } else {
            IpcError::new(ErrorCode::Lsp, format!("cannot start {program}: {err}"))
        }
    })?;

    // `spawn` succeeded, so all three pipes exist.
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let serial = SERIAL.fetch_add(1, Ordering::Relaxed);
    let info = LspInfo {
        id: options.id.clone(),
        program: program.clone(),
        root,
        pid: Some(child.id()),
    };
    let process = Arc::new(Mutex::new(child));

    // Registered before the threads exist rather than after, unlike `pty.rs`: a server
    // that exits the instant it starts -- a wrong argument, a toolchain that is not
    // there -- can otherwise have its forwarder clean up before there is anything to
    // clean up, leaving a dead session in the map. `close` is guarded by `serial`, so
    // taking it back out below if a thread will not start removes only ours.
    let replaced = sessions.lock().expect("lsp sessions poisoned").insert(
        options.id,
        Session {
            serial,
            stdin: Some(stdin),
            process: Arc::clone(&process),
        },
    );

    let (tx, rx) = mpsc::channel();
    let tail = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL)));
    let started = spawn_thread(&format!("agentide-lsp-out-{}", info.id), {
        let tx = tx.clone();
        move || read_stdout(stdout, &tx)
    })
    .and_then(|()| {
        spawn_thread(&format!("agentide-lsp-err-{}", info.id), {
            let id = info.id.clone();
            let tail = Arc::clone(&tail);
            move || read_stderr(stderr, &id, &tail, &tx)
        })
    })
    .and_then(|()| {
        spawn_thread(&format!("agentide-lsp-fwd-{}", info.id), {
            let sessions = Arc::clone(sessions);
            let process = Arc::clone(&process);
            let id = info.id.clone();
            move || forward(&rx, &channel, &sessions, &process, &id, serial, &tail)
        })
    });
    // Stopped outside the lock: its forwarding thread takes the lock to clean up, and
    // stopping waits for the process to go.
    if let Some(replaced) = replaced {
        replaced.stop();
    }
    if let Err(err) = started {
        // Nothing is watching this server, so it cannot be left running.
        close(sessions, &info.id, serial);
        let mut child = process.lock().expect("lsp process poisoned");
        let _ = child.kill();
        let _ = child.wait();
        return Err(err);
    }
    Ok(info)
}

fn send(sessions: &Sessions, id: &str, message: &str) -> Result<(), IpcError> {
    let framed = encode(message);
    let mut sessions = sessions.lock().expect("lsp sessions poisoned");
    let session = sessions.get_mut(id).ok_or_else(|| gone(id))?;
    let stdin = session.stdin.as_mut().ok_or_else(|| gone(id))?;
    let written = stdin.write_all(&framed).and_then(|()| stdin.flush());
    if let Err(err) = written {
        // A broken pipe means the server is gone. Drop the handle so the next caller gets
        // the clear error above rather than a second io failure.
        session.stdin = None;
        return Err(IpcError::from_io(
            &err,
            format!("cannot write to language server {id}"),
        ));
    }
    Ok(())
}

fn stop(sessions: &Sessions, id: &str) {
    let session = sessions.lock().expect("lsp sessions poisoned").remove(id);
    if let Some(session) = session {
        session.stop();
    }
}

fn gone(id: &str) -> IpcError {
    IpcError::new(
        ErrorCode::Lsp,
        format!("language server {id} is not running: its process has exited, or it never started"),
    )
}

/// Where the server is started, and what the frontend will call the workspace folder.
fn root_directory(
    asked: Option<WirePath>,
    workspace: Option<WirePath>,
) -> Result<WirePath, IpcError> {
    let root = asked.or(workspace).ok_or_else(|| {
        IpcError::new(
            ErrorCode::Lsp,
            "no root for the language server: open a folder, or pass one",
        )
    })?;
    if !root.to_path().is_dir() {
        return Err(IpcError::new(
            ErrorCode::NotFound,
            format!("cannot start a language server in {root}: not a directory"),
        ));
    }
    Ok(root)
}

fn spawn_thread(name: &str, body: impl FnOnce() + Send + 'static) -> Result<(), IpcError> {
    std::thread::Builder::new()
        .name(name.to_string())
        .spawn(body)
        .map(drop)
        .map_err(|err| {
            IpcError::new(
                ErrorCode::Lsp,
                format!("cannot start the {name} thread: {err}"),
            )
        })
}

// ---------------------------------------------------------------------------
// The pipes
// ---------------------------------------------------------------------------

/// One thing a reader thread found, on its way to the forwarder.
enum Line {
    /// A framed payload, still unparsed.
    Message(Vec<u8>),
    /// The server talking about itself.
    Stderr(String),
}

/// Read stdout until it ends, framing it into messages.
///
/// Deliberately does no batching of its own: it has to be back in `read` as soon as it
/// can, because the pipe it is draining is what the server blocks on when it fills.
fn read_stdout(mut stdout: ChildStdout, tx: &Sender<Line>) {
    let mut decoder = FrameDecoder::new(MAX_MESSAGE_BYTES);
    let mut buffer = vec![0u8; READ_BUFFER];
    let mut messages = Vec::new();

    loop {
        let read = match stdout.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(err) => {
                let _ = tx.send(Line::Stderr(format!(
                    "cannot read from the language server: {err}"
                )));
                return;
            }
        };
        messages.clear();
        if let Err(err) = decoder.push(&buffer[..read], &mut messages) {
            // Terminal: the byte positions are no longer trustworthy. Say so and stop,
            // which closes the pipe and brings the session down through the usual path.
            for message in messages.drain(..) {
                if tx.send(Line::Message(message)).is_err() {
                    return;
                }
            }
            let _ = tx.send(Line::Stderr(err.message));
            return;
        }
        for message in messages.drain(..) {
            if tx.send(Line::Message(message)).is_err() {
                // The forwarder is gone, so nobody is listening any more.
                return;
            }
        }
    }

    if decoder.pending() > 0 {
        let _ = tx.send(Line::Stderr(format!(
            "the language server stopped mid-message, {} bytes in",
            decoder.pending()
        )));
    }
}

/// Read stderr until it ends, keeping the tail for the exit message.
///
/// This pipe has to be drained whether or not anyone is reading the events: a server
/// whose stderr fills blocks writing to it, and rust-analyzer logs enough during indexing
/// to fill one.
fn read_stderr(
    stderr: ChildStderr,
    id: &str,
    tail: &Mutex<VecDeque<String>>,
    tx: &Sender<Line>,
) {
    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
        eprintln!("[lsp {id}] {line}");
        {
            let mut tail = tail.lock().expect("lsp stderr tail poisoned");
            if tail.len() == STDERR_TAIL {
                tail.pop_front();
            }
            tail.push_back(line.clone());
        }
        if tx.send(Line::Stderr(line)).is_err() {
            return;
        }
    }
}

/// Coalesce onto the frontend channel, watch for the server to end, and report how it
/// did.
///
/// Both reader threads hold a sender, so `Disconnected` means both pipes have reached EOF
/// -- normally the whole exit signal, and it needs no separate bookkeeping. The process
/// itself is polled as well because EOF is not guaranteed: a pipe handle inherited by a
/// grandchild outlives the process that was given it, and a server that died behind a
/// pipe nobody closes would otherwise never be reported, which is the one shape of "the
/// request never came back" this must not have.
fn forward(
    rx: &Receiver<Line>,
    channel: &Channel<LspEvent>,
    sessions: &Sessions,
    process: &Arc<Mutex<Child>>,
    id: &str,
    serial: u64,
    tail: &Mutex<VecDeque<String>>,
) {
    let mut batch = Batch::default();
    // The first message after a quiet period goes out at once; see the batching notes.
    let mut window_ends = Instant::now();

    loop {
        let wait = if batch.is_empty() {
            EXIT_POLL
        } else {
            window_ends.saturating_duration_since(Instant::now())
        };
        match rx.recv_timeout(wait) {
            Ok(line) => {
                batch.push(line);
                if Instant::now() < window_ends && batch.bytes < FLUSH_BYTES {
                    continue;
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                /*
                 * What `EXIT_POLL` is actually for.
                 *
                 * A clean exit closes stdout, the reader ends, and the arm below sees
                 * the disconnect -- that is the normal path. But stdout is only closed
                 * once every handle to it is gone, so a server that leaves a helper
                 * process holding the pipe never disconnects. Without this check the
                 * forwarder would idle here forever, the session would stay in the map,
                 * and every request against it would hang with no error.
                 */
                let gone = {
                    let mut child = process.lock().expect("lsp process poisoned");
                    // `Err` means another waiter already reaped it, which is still gone.
                    !matches!(child.try_wait(), Ok(None))
                };
                if gone {
                    // Take whatever the reader parsed before we stopped listening: the
                    // last thing a dying server said is usually the useful part.
                    while let Ok(line) = rx.try_recv() {
                        batch.push(line);
                    }
                    let _ = batch.flush(channel, id);
                    break;
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                // The last of it, on the way out; the channel being gone changes nothing.
                let _ = batch.flush(channel, id);
                break;
            }
        }

        if !batch.is_empty() {
            if batch.flush(channel, id).is_err() {
                // The webview is gone. Nobody can see this server or ask it anything, and
                // the queue behind us would grow without limit, so end the session.
                break;
            }
            window_ends = Instant::now() + SEND_INTERVAL;
        }
    }

    // Whichever way the loop ended, this server is over: take the session out so the next
    // send fails loudly, and make sure the process is actually gone.
    close(sessions, id, serial);
    let code = await_exit(process, Instant::now() + SHUTDOWN_GRACE).unwrap_or_else(|| {
        // Both pipes closed and it is still up: it is not going to say anything more.
        let mut child = process.lock().expect("lsp process poisoned");
        let _ = child.kill();
        child.wait().ok().and_then(|status| status.code())
    });

    let mut message = match code {
        Some(0) | None => format!("language server {id} exited"),
        Some(code) => format!("language server {id} exited with code {code}"),
    };
    if let Some(last) = tail.lock().expect("lsp stderr tail poisoned").iter().next_back() {
        message.push_str(&format!(" -- last output: {last}"));
    }
    let _ = channel.send(LspEvent::Exited {
        id: id.to_string(),
        code,
        message,
    });
}

/// Take a session out of the state, unless its id has already been given to a new one.
fn close(sessions: &Sessions, id: &str, serial: u64) {
    let mut sessions = sessions.lock().expect("lsp sessions poisoned");
    if sessions.get(id).is_some_and(|open| open.serial == serial) {
        sessions.remove(id);
    }
}

/// What has piled up since the last send.
///
/// Two lists rather than one interleaved one: messages and stderr come from separate
/// pipes with separate OS buffers, so their relative order was never something this could
/// preserve, and pretending otherwise would be a promise it cannot keep. Order *within*
/// each is exact.
#[derive(Default)]
struct Batch {
    messages: Vec<RawJson>,
    stderr: Vec<String>,
    bytes: usize,
}

impl Batch {
    fn push(&mut self, line: Line) {
        match line {
            Line::Message(payload) => {
                self.bytes += payload.len();
                match parse(payload) {
                    Ok(message) => self.messages.push(message),
                    // Not dropped: a message the frontend never sees is indistinguishable
                    // from a server doing nothing, which is the failure this guards.
                    Err(complaint) => self.stderr.push(complaint),
                }
            }
            Line::Stderr(text) => {
                self.bytes += text.len();
                self.stderr.push(text);
            }
        }
    }

    fn is_empty(&self) -> bool {
        self.messages.is_empty() && self.stderr.is_empty()
    }

    /// Send what is pending, messages first. Errors once the channel is closed.
    fn flush(&mut self, channel: &Channel<LspEvent>, id: &str) -> Result<(), tauri::Error> {
        self.bytes = 0;
        if !self.messages.is_empty() {
            channel.send(LspEvent::Messages {
                id: id.to_string(),
                messages: std::mem::take(&mut self.messages),
            })?;
        }
        if !self.stderr.is_empty() {
            channel.send(LspEvent::Stderr {
                id: id.to_string(),
                lines: std::mem::take(&mut self.stderr),
            })?;
        }
        Ok(())
    }
}

/// Take ownership of a payload as JSON without building a tree from it.
///
/// The two checks are the two things `RawJson` promises the frontend: valid UTF-8, and
/// well-formed JSON. Both are scans. Failing either is reported rather than hidden.
fn parse(payload: Vec<u8>) -> Result<RawJson, String> {
    let text = String::from_utf8(payload).map_err(|err| {
        format!(
            "the language server sent a message that is not valid UTF-8: {err}; \
             ignoring {} bytes",
            err.as_bytes().len()
        )
    })?;
    serde_json::value::RawValue::from_string(text).map_err(|err| {
        format!("the language server sent a message that is not valid JSON: {err}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Long enough for rust-analyzer to start and answer `initialize` on a loaded
    /// machine, short enough that a hang fails the test rather than outliving the suite's
    /// patience. Generous because a cold start also pays for loading the sysroot.
    const DEADLINE: Duration = Duration::from_secs(90);

    // -----------------------------------------------------------------------
    // Framing
    //
    // The part most worth testing: a framing bug does not crash, it looks like a
    // language server that started and then did nothing.
    // -----------------------------------------------------------------------

    fn frame(body: &str) -> Vec<u8> {
        encode(body)
    }

    /// Everything `chunks` decodes to, as text.
    fn decode(chunks: &[&[u8]]) -> Result<Vec<String>, IpcError> {
        let mut decoder = FrameDecoder::new(MAX_MESSAGE_BYTES);
        let mut out = Vec::new();
        for chunk in chunks {
            decoder.push(chunk, &mut out)?;
        }
        Ok(out
            .into_iter()
            .map(|bytes| String::from_utf8(bytes).expect("payload is not UTF-8"))
            .collect())
    }

    #[test]
    fn what_is_encoded_decodes_back() {
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#;
        let framed = frame(body);
        assert!(framed.starts_with(b"Content-Length: 46\r\n\r\n"), "{framed:?}");
        assert_eq!(decode(&[&framed]).expect("decode"), vec![body.to_string()]);
    }

    /// The normal case, not the edge case: a pipe read boundary lands wherever the OS
    /// puts it, including in the middle of a payload.
    #[test]
    fn a_message_split_across_chunks_arrives_whole() {
        let body = r#"{"jsonrpc":"2.0","id":7,"result":{"capabilities":{}}}"#;
        let framed = frame(body);
        for split in 1..framed.len() {
            let (head, tail) = framed.split_at(split);
            assert_eq!(
                decode(&[head, tail]).expect("decode"),
                vec![body.to_string()],
                "split at {split}"
            );
        }
    }

    /// One byte at a time is the same problem taken to its limit, and it exercises every
    /// header boundary at once -- including mid-`Content-Length`.
    #[test]
    fn a_message_split_one_byte_at_a_time_arrives_whole() {
        let body = r#"{"id":1,"result":null}"#;
        let framed = frame(body);
        let mut decoder = FrameDecoder::new(MAX_MESSAGE_BYTES);
        let mut out = Vec::new();
        for byte in &framed {
            decoder.push(&[*byte], &mut out).expect("decode");
        }
        assert_eq!(out.len(), 1, "expected exactly one message");
        assert_eq!(String::from_utf8(out.remove(0)).expect("utf8"), body);
    }

    /// Named separately from the byte-at-a-time case because it is the specific split
    /// that a naive decoder gets wrong: the length is half-read and looks like a number.
    #[test]
    fn a_header_split_mid_content_length_is_not_read_early() {
        let body = r#"{"n":123456}"#;
        let framed = frame(body);
        // `Content-Length: 1` | `2\r\n\r\n{"n":123456}` -- a decoder that parsed what it
        // had would expect one byte and desynchronize on the rest.
        let at = find(&framed, b"\r\n\r\n").expect("a header end") - 1;
        let (head, tail) = framed.split_at(at);
        assert!(head.ends_with(b"1"), "the split is not mid-number: {head:?}");
        assert_eq!(decode(&[head, tail]).expect("decode"), vec![body.to_string()]);
    }

    #[test]
    fn several_messages_in_one_chunk_all_arrive_in_order() {
        let bodies = [r#"{"id":1}"#, r#"{"id":2}"#, r#"{"method":"$/progress"}"#];
        let mut chunk = Vec::new();
        for body in &bodies {
            chunk.extend_from_slice(&frame(body));
        }
        assert_eq!(decode(&[&chunk]).expect("decode"), bodies);
        // And the same bytes cut anywhere still produce the same three, in the same order.
        for split in 1..chunk.len() {
            let (head, tail) = chunk.split_at(split);
            assert_eq!(decode(&[head, tail]).expect("decode"), bodies, "split at {split}");
        }
    }

    /// Content-Length counts bytes. A decoder that counted characters would take the tail
    /// of this payload for the start of the next header.
    #[test]
    fn a_multibyte_payload_is_measured_in_bytes() {
        let body = r#"{"message":"ここは日本語です — ok? ✓"}"#;
        assert_ne!(body.len(), body.chars().count(), "the test body is all ASCII");
        let framed = frame(body);
        assert!(
            framed.starts_with(format!("Content-Length: {}\r\n", body.len()).as_bytes()),
            "the header does not carry the byte length"
        );
        // Followed by another message, so a length read wrong shows up as mis-framing
        // rather than merely as a short read.
        let mut chunk = framed;
        chunk.extend_from_slice(&frame(r#"{"id":2}"#));
        assert_eq!(
            decode(&[&chunk]).expect("decode"),
            vec![body.to_string(), r#"{"id":2}"#.to_string()]
        );
        // And split through the middle of a multibyte character.
        let at = chunk.iter().position(|byte| *byte == 0xE3).expect("a lead byte") + 1;
        let (head, tail) = chunk.split_at(at);
        assert_eq!(
            decode(&[head, tail]).expect("decode"),
            vec![body.to_string(), r#"{"id":2}"#.to_string()]
        );
    }

    #[test]
    fn extra_headers_are_ignored_and_the_name_is_case_insensitive() {
        let body = r#"{"id":1}"#;
        let framed = format!(
            "content-length: {}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{body}",
            body.len()
        );
        assert_eq!(
            decode(&[framed.as_bytes()]).expect("decode"),
            vec![body.to_string()]
        );
    }

    #[test]
    fn an_oversized_message_is_refused_rather_than_buffered() {
        let mut decoder = FrameDecoder::new(1024);
        let mut out = Vec::new();
        let err = decoder
            .push(b"Content-Length: 4096\r\n\r\n", &mut out)
            .expect_err("a message past the ceiling must not be accepted");
        assert_eq!(err.code, ErrorCode::Lsp);
        assert!(err.message.contains("4096"), "{}", err.message);
        assert!(out.is_empty());
    }

    #[test]
    fn a_header_that_never_ends_is_refused_rather_than_buffered() {
        let mut decoder = FrameDecoder::new(MAX_MESSAGE_BYTES);
        let mut out = Vec::new();
        let filler = vec![b'x'; MAX_HEADER_BYTES + 1];
        let err = decoder
            .push(&filler, &mut out)
            .expect_err("an endless header must not be buffered");
        assert_eq!(err.code, ErrorCode::Lsp);
    }

    #[test]
    fn a_header_block_without_a_length_is_refused() {
        let mut decoder = FrameDecoder::new(MAX_MESSAGE_BYTES);
        let mut out = Vec::new();
        let err = decoder
            .push(b"Content-Type: application/json\r\n\r\n{}", &mut out)
            .expect_err("no Content-Length must not be framed");
        assert!(err.message.contains("Content-Length"), "{}", err.message);
    }

    #[test]
    fn a_length_that_is_not_a_number_is_refused() {
        let mut decoder = FrameDecoder::new(MAX_MESSAGE_BYTES);
        let mut out = Vec::new();
        let err = decoder
            .push(b"Content-Length: lots\r\n\r\n{}", &mut out)
            .expect_err("a non-numeric length must not be framed");
        assert!(err.message.contains("lots"), "{}", err.message);
    }

    /// An empty payload is legal framing and has to be handed on rather than swallowed by
    /// the "did we get enough bytes" check.
    #[test]
    fn a_zero_length_message_still_arrives() {
        let mut chunk = b"Content-Length: 0\r\n\r\n".to_vec();
        chunk.extend_from_slice(&frame(r#"{"id":1}"#));
        assert_eq!(
            decode(&[&chunk]).expect("decode"),
            vec![String::new(), r#"{"id":1}"#.to_string()]
        );
    }

    // -----------------------------------------------------------------------
    // Carrying JSON
    // -----------------------------------------------------------------------

    /// The promise `RawJson` makes: the server's bytes, not a re-rendering of them.
    #[test]
    fn a_message_crosses_byte_for_byte() {
        // Key order and number spelling both survive only if nothing parses this into a
        // tree on the way through: a `Value` would sort the keys and renormalize `1e2`.
        let body = r#"{"zzz":1,"aaa":[1e2,1.500],"id":9007199254740993}"#;
        let mut batch = Batch::default();
        batch.push(Line::Message(body.as_bytes().to_vec()));
        let event = LspEvent::Messages {
            id: "rust".to_string(),
            messages: std::mem::take(&mut batch.messages),
        };
        let json = serde_json::to_string(&event).expect("serialize");
        assert_eq!(
            json,
            format!(r#"{{"t":"messages","id":"rust","messages":[{body}]}}"#)
        );
    }

    /// The send side of the same promise, and the path `lsp_send` actually takes: Tauri
    /// hands a command its arguments out of an owned `serde_json::Value`, so `RawJson`
    /// has to survive being deserialized from one -- and come out spelled the way the
    /// frontend wrote it, not the way a `Value` would render it.
    #[test]
    fn a_message_deserializes_out_of_a_value_the_way_tauri_hands_it_over() {
        let sent = serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": "initialize"});
        let message: RawJson = serde_json::from_value(sent).expect("RawJson from a Value");
        let framed = encode(message.get());
        assert_eq!(
            decode(&[&framed]).expect("decode"),
            vec![message.get().to_string()]
        );
    }

    #[test]
    fn a_payload_that_is_not_json_is_reported_not_dropped() {
        let mut batch = Batch::default();
        batch.push(Line::Message(b"not json at all".to_vec()));
        assert!(batch.messages.is_empty());
        assert_eq!(batch.stderr.len(), 1, "{:?}", batch.stderr);
        assert!(batch.stderr[0].contains("not valid JSON"), "{:?}", batch.stderr);
    }

    #[test]
    fn a_payload_that_is_not_utf8_is_reported_not_dropped() {
        let mut batch = Batch::default();
        batch.push(Line::Message(vec![b'{', 0xFF, b'}']));
        assert!(batch.messages.is_empty());
        assert!(batch.stderr[0].contains("not valid UTF-8"), "{:?}", batch.stderr);
    }

    // -----------------------------------------------------------------------
    // Sessions
    // -----------------------------------------------------------------------

    #[derive(Default)]
    struct Seen {
        messages: Vec<serde_json::Value>,
        stderr: Vec<String>,
        exited: Option<serde_json::Value>,
    }

    /// A channel that keeps what it was sent, standing in for the webview.
    fn collector() -> (Channel<LspEvent>, Arc<Mutex<Seen>>) {
        let seen = Arc::new(Mutex::new(Seen::default()));
        let sink = Arc::clone(&seen);
        let channel: Channel<LspEvent> = Channel::new(move |body| {
            let text = match &body {
                tauri::ipc::InvokeResponseBody::Json(text) => text.clone(),
                tauri::ipc::InvokeResponseBody::Raw(_) => panic!("an lsp event is never raw"),
            };
            let value: serde_json::Value = serde_json::from_str(&text).expect("event is not json");
            let mut sink = sink.lock().expect("collector poisoned");
            match value["t"].as_str() {
                Some("messages") => sink
                    .messages
                    .extend(value["messages"].as_array().expect("an array").iter().cloned()),
                Some("stderr") => sink.stderr.extend(
                    value["lines"]
                        .as_array()
                        .expect("an array")
                        .iter()
                        .map(|line| line.as_str().unwrap_or_default().to_string()),
                ),
                _ => sink.exited = Some(value),
            }
            Ok(())
        });
        (channel, seen)
    }

    fn options(id: &str, command: &[&str], root: Option<WirePath>) -> LspStartOptions {
        LspStartOptions {
            id: id.to_string(),
            command: command.iter().map(|part| (*part).to_string()).collect(),
            root,
        }
    }

    fn temp_root() -> WirePath {
        WirePath::from_path(&std::env::temp_dir()).expect("temp dir")
    }

    /// Wait until `ready` is happy with what has arrived, or fail the test.
    fn until(seen: &Arc<Mutex<Seen>>, what: &str, ready: impl Fn(&Seen) -> bool) {
        let deadline = Instant::now() + DEADLINE;
        while Instant::now() < deadline {
            {
                let sink = seen.lock().expect("collector poisoned");
                if ready(&sink) {
                    return;
                }
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let sink = seen.lock().expect("collector poisoned");
        panic!(
            "no {what} within {DEADLINE:?}; messages: {:?}, stderr: {:?}, exited: {:?}",
            sink.messages, sink.stderr, sink.exited
        );
    }

    #[test]
    fn a_server_that_is_not_installed_fails_the_start_rather_than_the_session() {
        let sessions = Sessions::default();
        let (channel, _seen) = collector();
        let err = start(
            &sessions,
            None,
            options("missing", &["agentide-no-such-lsp-8f2a"], Some(temp_root())),
            channel,
        )
        .expect_err("a server that does not exist must not start");
        // `notFound` rather than `lsp`, so the frontend can say "install it" instead of
        // "it crashed". This is the `typescript-language-server` case on this machine.
        assert_eq!(err.code, ErrorCode::NotFound);
        assert!(err.message.contains("PATH"), "{}", err.message);
        assert!(sessions.lock().expect("poisoned").is_empty());
    }

    #[test]
    fn a_server_that_is_not_running_fails_loudly() {
        let sessions = Sessions::default();
        let err = send(&sessions, "nope", r#"{"id":1}"#).expect_err("no such server");
        assert_eq!(err.code, ErrorCode::Lsp);
        assert!(err.message.contains("nope"), "{}", err.message);
        // Stopping one is not an error: the frontend closes servers it may have lost.
        stop(&sessions, "nope");
    }

    #[test]
    fn a_root_that_is_not_a_directory_is_refused() {
        let missing = WirePath::from_path(&std::env::temp_dir().join("agentide-no-such-dir-8f2a"))
            .expect("path");
        assert_eq!(
            root_directory(Some(missing), None)
                .expect_err("a directory that is not there")
                .code,
            ErrorCode::NotFound
        );
        // The workspace is the fallback, and with neither there is nothing to start in.
        let root = temp_root();
        assert_eq!(root_directory(None, Some(root.clone())).expect("workspace"), root);
        assert_eq!(
            root_directory(None, None).expect_err("no root at all").code,
            ErrorCode::Lsp
        );
    }

    #[test]
    fn an_empty_command_is_refused() {
        let sessions = Sessions::default();
        let (channel, _seen) = collector();
        let err = start(&sessions, None, options("empty", &[], Some(temp_root())), channel)
            .expect_err("no command");
        assert_eq!(err.code, ErrorCode::Lsp);
    }

    /// A process that exits on its own takes its session with it and says so, rather than
    /// leaving requests to wait on something that is gone.
    #[test]
    fn a_server_that_exits_reports_it_and_takes_itself_out() {
        let sessions = Sessions::default();
        let (channel, seen) = collector();
        let command: &[&str] = if cfg!(windows) {
            &["cmd.exe", "/c", "exit", "3"]
        } else {
            &["/bin/sh", "-c", "exit 3"]
        };
        start(
            &sessions,
            None,
            options("quitter", command, Some(temp_root())),
            channel,
        )
        .expect("start failed");

        until(&seen, "an exit event", |sink| sink.exited.is_some());
        let event = seen.lock().expect("poisoned").exited.clone().expect("exited");
        assert_eq!(event["id"], "quitter", "{event}");
        assert_eq!(event["code"], 3, "{event}");
        assert!(
            sessions.lock().expect("poisoned").is_empty(),
            "the finished session was left behind"
        );
        // And a send afterwards fails at once rather than waiting for a reply.
        assert!(send(&sessions, "quitter", r#"{"id":1}"#).is_err());
    }

    /// stderr is where a language server explains why it is doing nothing, so it has to
    /// reach the frontend rather than the void.
    #[test]
    fn what_a_server_writes_to_stderr_is_surfaced() {
        let sessions = Sessions::default();
        let (channel, seen) = collector();
        let marker = "agentide-lsp-stderr-marker";
        let command: Vec<String> = if cfg!(windows) {
            vec![
                "cmd.exe".into(),
                "/c".into(),
                format!("echo {marker} 1>&2"),
            ]
        } else {
            vec!["/bin/sh".into(), "-c".into(), format!("echo {marker} >&2")]
        };
        start(
            &sessions,
            None,
            LspStartOptions {
                id: "noisy".to_string(),
                command,
                root: Some(temp_root()),
            },
            channel,
        )
        .expect("start failed");

        until(&seen, "the stderr line", |sink| {
            sink.stderr.iter().any(|line| line.contains(marker))
        });
        // And the exit message carries the tail, so a server that dies during startup
        // explains itself in the one event the frontend certainly reads.
        until(&seen, "an exit event", |sink| sink.exited.is_some());
        let event = seen.lock().expect("poisoned").exited.clone().expect("exited");
        assert!(
            event["message"].as_str().is_some_and(|say| say.contains(marker)),
            "{event}"
        );
    }

    #[test]
    fn starting_onto_a_live_id_replaces_it() {
        let Some(root) = rust_analyzer_crate("replace") else {
            eprintln!("skipping: rust-analyzer is not on PATH");
            return;
        };
        let sessions = Sessions::default();
        let (first_channel, first_seen) = collector();
        let first = start(
            &sessions,
            None,
            options("rust", &["rust-analyzer"], Some(root.clone())),
            first_channel,
        )
        .expect("first start");
        let (second_channel, _second_seen) = collector();
        let second = start(
            &sessions,
            None,
            options("rust", &["rust-analyzer"], Some(root)),
            second_channel,
        )
        .expect("second start");
        assert_ne!(first.pid, second.pid, "the same process twice");

        // The replaced server says it ended -- the frontend needs no second path to know
        // its outstanding requests are dead.
        until(&first_seen, "an exit event", |sink| sink.exited.is_some());
        assert!(
            sessions.lock().expect("poisoned").contains_key("rust"),
            "the replaced session took its replacement with it"
        );
        stop(&sessions, "rust");
        assert!(sessions.lock().expect("poisoned").is_empty());
    }

    // -----------------------------------------------------------------------
    // End to end
    // -----------------------------------------------------------------------

    /// A scratch crate for rust-analyzer to open, or `None` if it is not installed.
    ///
    /// Left on disk rather than cleaned up: the test's own process is still holding the
    /// server when it ends, and removing a directory out from under it on Windows fails
    /// noisily for no benefit. The scratch directory is the OS's to sweep.
    fn rust_analyzer_crate(tag: &str) -> Option<WirePath> {
        if !on_path("rust-analyzer") {
            return None;
        }
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock before epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("agentide-lsp-{tag}-{unique}"));
        std::fs::create_dir_all(dir.join("src")).expect("cannot create scratch crate");
        std::fs::write(
            dir.join("Cargo.toml"),
            "[package]\nname = \"scratch\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .expect("cannot write Cargo.toml");
        std::fs::write(dir.join("src/main.rs"), "fn main() { let x = 1; }\n")
            .expect("cannot write main.rs");
        Some(WirePath::canonical(&dir).expect("scratch crate is not normalizable"))
    }

    fn on_path(name: &str) -> bool {
        let Some(path) = std::env::var_os("PATH") else {
            return false;
        };
        let names: Vec<String> = if cfg!(windows) {
            vec![format!("{name}.exe"), name.to_string()]
        } else {
            vec![name.to_string()]
        };
        std::env::split_paths(&path).any(|dir| names.iter().any(|name| dir.join(name).is_file()))
    }

    /// The one test that proves the pipe: a real server, a real `initialize`, a real
    /// response framed the way the spec says.
    ///
    /// Skipped with a message rather than failed when rust-analyzer is absent, the way
    /// `pty.rs` handles its own optional cases.
    #[test]
    fn rust_analyzer_answers_initialize() {
        let Some(root) = rust_analyzer_crate("init") else {
            eprintln!("skipping rust_analyzer_answers_initialize: rust-analyzer is not on PATH");
            return;
        };
        let sessions = Sessions::default();
        let (channel, seen) = collector();
        let info = start(
            &sessions,
            None,
            options("rust", &["rust-analyzer"], Some(root.clone())),
            channel,
        )
        .expect("rust-analyzer did not start");
        assert!(info.pid.is_some(), "the server has no pid");

        // The frontend is the LSP client, so the test has to be one too: this is the
        // shape it will send, and nothing in `lsp.rs` knows what any of it means.
        let uri = format!("file:///{}", root.to_string().trim_start_matches('/'));
        let initialize = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "processId": std::process::id(),
                "rootUri": uri,
                "capabilities": {},
                "workspaceFolders": [{ "uri": uri, "name": "scratch" }],
            },
        })
        .to_string();
        send(&sessions, "rust", &initialize).expect("cannot send initialize");

        until(&seen, "a response to initialize", |sink| {
            sink.messages.iter().any(|message| message["id"] == 1)
        });
        let reply = seen
            .lock()
            .expect("poisoned")
            .messages
            .iter()
            .find(|message| message["id"] == 1)
            .cloned()
            .expect("the reply");
        assert_eq!(reply["jsonrpc"], "2.0", "{reply}");
        assert!(reply.get("error").is_none(), "initialize failed: {reply}");
        assert!(
            reply["result"]["capabilities"].is_object(),
            "no capabilities in the reply: {reply}"
        );

        stop(&sessions, "rust");
        assert!(sessions.lock().expect("poisoned").is_empty());
    }

    /// The other primary language, and the one whose stderr matters most: clangd is the
    /// server that starts fine and then does nothing because it cannot find a
    /// `compile_commands.json`, and it says so only there.
    #[test]
    fn clangd_answers_initialize_and_says_what_it_is_doing() {
        if !on_path("clangd") {
            eprintln!("skipping clangd_answers_initialize: clangd is not on PATH");
            return;
        }
        let sessions = Sessions::default();
        let (channel, seen) = collector();
        let root = temp_root();
        start(
            &sessions,
            None,
            options("c", &["clangd"], Some(root.clone())),
            channel,
        )
        .expect("clangd did not start");

        let uri = format!("file:///{}", root.to_string().trim_start_matches('/'));
        let initialize = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "processId": std::process::id(), "rootUri": uri, "capabilities": {} },
        })
        .to_string();
        send(&sessions, "c", &initialize).expect("cannot send initialize");

        until(&seen, "a response to initialize", |sink| {
            sink.messages.iter().any(|message| message["id"] == 1)
        });
        until(&seen, "clangd's startup log", |sink| {
            sink.stderr.iter().any(|line| line.contains("clangd version"))
        });
        stop(&sessions, "c");
    }
}
