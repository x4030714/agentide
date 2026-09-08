//! The chrome of a frameless window: the translucent backdrop and the three verbs the
//! frontend's own title bar needs.
//!
//! `tauri.conf.json` declares the main window `decorations: false, transparent: true`,
//! so everything the OS used to draw is ours to supply. The frontend draws the bar; this
//! module gives it the buttons' behaviour, the maximized state it needs to pick an icon,
//! and the answer to "is the desktop showing through behind me, or must I paint my own
//! background?".
//!
//! The window is square. It was clipped to a rounded rectangle for a while, with a GDI
//! region, because this window has no per-pixel alpha and the webview's own rounded corner
//! composited against the opaque surface underneath and came back square anyway. That cost
//! the invisible resize border -- the region clips the non-client area away with the rest,
//! so an edge drag wants the content edge rather than eight pixels outside it -- and it had
//! to be rebuilt on every resize and every DPI change. Square corners cost none of that.
//!
//! Resizing is deliberately absent. tao keeps `WS_SIZEBOX` on an undecorated window and
//! hit-tests the edges itself, so the OS resize borders still work with nothing from us.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent};

use crate::ipc::{ErrorCode, IpcError};

/// The window `tauri.conf.json` declares, and the one `capabilities/default.json` grants
/// permissions to. Everything here acts on it and nothing else.
const MAIN_WINDOW: &str = "main";

/// Carries the new value whenever the window is maximized or restored, by any route.
/// Mirrored in `src/lib/protocol.ts`.
const MAXIMIZED_EVENT: &str = "window://maximized";

/// What setup learned about the window, for the frontend to ask about later.
///
/// Written from setup, from the window-event handler on the main thread, and -- since the
/// Transparency setting -- from `window_set_backdrop` on a task thread. Plain atomics
/// cover all three, so no command blocks on a lock to read a bool.
#[derive(Default)]
pub struct ChromeState {
    /// Whether the translucent backdrop is on. False means the window is an ordinary
    /// opaque one and the frontend has to supply its own ground.
    effect_active: AtomicBool,
    /// The last value published on [`MAXIMIZED_EVENT`], so a resize storm emits one
    /// event per actual change rather than one per pixel.
    maximized: AtomicBool,
}

/// Apply the backdrop and start publishing maximized changes. Call once, from `setup`.
///
/// Nothing here is fatal: a window with no effect is opaque, not broken.
pub fn setup(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        eprintln!("[window] no `{MAIN_WINDOW}` window to set up");
        return;
    };

    let state = app.state::<ChromeState>();
    state
        .effect_active
        .store(apply_effect(&window), Ordering::Relaxed);
    state
        .maximized
        .store(window.is_maximized().unwrap_or(false), Ordering::Relaxed);

    let app = app.clone();
    window.on_window_event(move |event| {
        // Our own button, a double click on the drag region, a Win+Arrow snap and a drag
        // to the top of the screen all reach us as a resize; nothing else says the
        // maximized state changed.
        if matches!(event, WindowEvent::Resized(_)) {
            publish_maximized(&app);
        }
    });
}

/// Emit [`MAXIMIZED_EVENT`] if, and only if, the state is not the one already published.
///
/// Runs on the main thread, from inside the event loop: the window getters are serviced
/// inline there rather than round-tripping through it, so this cannot deadlock.
fn publish_maximized(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let maximized = match window.is_maximized() {
        Ok(maximized) => maximized,
        Err(err) => {
            eprintln!("[window] cannot read the maximized state: {err}");
            return;
        }
    };
    let state = app.state::<ChromeState>();
    if state.maximized.swap(maximized, Ordering::Relaxed) == maximized {
        return;
    }
    if let Err(err) = app.emit(MAXIMIZED_EVENT, maximized) {
        eprintln!("[window] cannot publish the maximized state: {err}");
    }
}

/// Put the blurred desktop behind the window, and report whether it took.
///
/// Which effect is a runtime choice rather than a build-time one, and the choice is not
/// free-form:
///
/// * `apply_mica` is Windows 11 only -- it fails outright on Windows 10.
/// * `apply_acrylic` works from Windows 10 v1809, but its own docs warn of "poor
///   performance on Windows 10 v1903+ ... the window will lag when resizing or
///   dragging". Every Windows 10 still receiving updates is far past 1903, so acrylic is
///   not an option there however much better it looks. Do not "upgrade" this to it.
/// * `apply_blur` works from Windows 10 v1809 and only carries a performance warning on
///   Windows 11 build 22621.
///
/// So: blur below Windows 11, mica from Windows 11 -- which is where blur is the one
/// that lags, and where mica is the native look anyway.
#[cfg(windows)]
fn apply_effect(window: &WebviewWindow) -> bool {
    /// The build Windows 11 starts at, which is also the one `apply_mica` needs.
    const WINDOWS_11: u32 = 22000;

    // An escape hatch, because the effect depends on the compositor and the graphics
    // driver rather than on anything this code can inspect. Set `AGENTIDE_NO_BACKDROP=1`
    // to run the window opaque; the frontend already paints its own ground when the
    // effect does not take, so nothing else has to change. It is also the way to tell a
    // backdrop problem from a rendering one in a single run.
    if std::env::var_os("AGENTIDE_NO_BACKDROP").is_some() {
        eprintln!("[window] backdrop disabled by AGENTIDE_NO_BACKDROP");
        return false;
    }

    let build = windows_version::OsVersion::current().build;
    // `None` leaves the tint to the frontend: the effect only blurs what is behind the
    // window, and the colour laid over it is CSS.
    let applied = if build >= WINDOWS_11 {
        window_vibrancy::apply_mica(window, None)
    } else {
        window_vibrancy::apply_blur(window, None)
    };

    match applied {
        Ok(()) => true,
        Err(err) => {
            eprintln!("[window] no translucency on build {build}: {err}");
            false
        }
    }
}

/// Take the backdrop away again, for Transparency off.
///
/// Both are cleared rather than the one `apply_effect` would have chosen: which effect is
/// on depends on the Windows build, and clearing the one that was never applied costs a
/// no-op call. Errors are dropped for the same reason -- "there was no mica to clear" is
/// the expected answer on Windows 10, not a failure to report.
#[cfg(windows)]
fn clear_effect(window: &WebviewWindow) {
    let _ = window_vibrancy::clear_mica(window);
    let _ = window_vibrancy::clear_blur(window);
}

/// Only Windows has an effect worth applying here; elsewhere the window stays opaque and
/// the frontend paints its own background.
#[cfg(not(windows))]
fn apply_effect(_window: &WebviewWindow) -> bool {
    false
}

#[cfg(not(windows))]
fn clear_effect(_window: &WebviewWindow) {}

fn main_window(app: &AppHandle) -> Result<WebviewWindow, IpcError> {
    app.get_webview_window(MAIN_WINDOW).ok_or_else(|| {
        IpcError::new(
            ErrorCode::Window,
            format!("there is no `{MAIN_WINDOW}` window"),
        )
    })
}

fn failed(action: &str, err: tauri::Error) -> IpcError {
    IpcError::new(ErrorCode::Window, format!("cannot {action}: {err}"))
}

/// What the OS minimize button did.
#[tauri::command]
pub fn window_minimize(app: AppHandle) -> Result<(), IpcError> {
    main_window(&app)?
        .minimize()
        .map_err(|err| failed("minimize the window", err))
}

/// What the OS maximize button did: maximize when restored, restore when maximized.
///
/// A double click on the drag region does the same thing by a different route -- Tauri's
/// own `internal_toggle_maximize` -- and both come back as [`MAXIMIZED_EVENT`].
#[tauri::command]
pub fn window_toggle_maximize(app: AppHandle) -> Result<(), IpcError> {
    let window = main_window(&app)?;
    let maximized = window
        .is_maximized()
        .map_err(|err| failed("read the maximized state", err))?;
    if maximized {
        window.unmaximize()
    } else {
        window.maximize()
    }
    .map_err(|err| failed("toggle the maximized state", err))
}

/// What the OS close button did -- the normal close path, so the sidecar is still shut
/// down by the exit handler in `lib.rs`.
#[tauri::command]
pub fn window_close(app: AppHandle) -> Result<(), IpcError> {
    main_window(&app)?
        .close()
        .map_err(|err| failed("close the window", err))
}

/// The current state, for the title bar's first paint. Every change after that arrives
/// on [`MAXIMIZED_EVENT`].
#[tauri::command]
pub fn window_is_maximized(app: AppHandle) -> Result<bool, IpcError> {
    main_window(&app)?
        .is_maximized()
        .map_err(|err| failed("read the maximized state", err))
}

/// Whether the translucent backdrop is on right now. It starts as whatever setup managed
/// and moves when the Transparency setting does.
#[tauri::command]
pub fn window_effect_active(state: State<'_, ChromeState>) -> bool {
    state.effect_active.load(Ordering::Relaxed)
}

/// Put the backdrop back, or take it away, and answer with what is true afterwards.
///
/// The answer is the point: asking for the backdrop is not getting it. `apply_effect`
/// fails on an old build, with the wrong driver, or when `AGENTIDE_NO_BACKDROP` is set,
/// and none of those is fatal -- the window is then opaque and the frontend paints its
/// own ground, which is the same thing it does when the effect never applied at launch.
///
/// Async because a synchronous command runs on the caller's thread and this one talks to
/// DWM: a slow answer there would be a frozen webview, which is a bug this core has
/// already paid for once.
#[tauri::command]
pub async fn window_set_backdrop(
    app: AppHandle,
    state: State<'_, ChromeState>,
    enabled: bool,
) -> Result<bool, IpcError> {
    let window = main_window(&app)?;
    let active = if enabled {
        apply_effect(&window)
    } else {
        clear_effect(&window);
        false
    };
    state.effect_active.store(active, Ordering::Relaxed);
    Ok(active)
}
