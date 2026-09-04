//! The chrome of a frameless window: the translucent backdrop and the three verbs the
//! frontend's own title bar needs.
//!
//! `tauri.conf.json` declares the main window `decorations: false, transparent: true`,
//! so everything the OS used to draw is ours to supply. The frontend draws the bar; this
//! module gives it the buttons' behaviour, the maximized state it needs to pick an icon,
//! and the answer to "is the desktop showing through behind me, or must I paint my own
//! background?".
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
/// Both flags are written once at setup and after that only by the window-event handler
/// on the main thread, so plain atomics are enough and no command blocks on a lock.
#[derive(Default)]
pub struct ChromeState {
    /// Whether the translucent backdrop actually applied. False means the window is an
    /// ordinary opaque one and the frontend has to supply its own ground.
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

/// Only Windows has an effect worth applying here; elsewhere the window stays opaque and
/// the frontend paints its own background.
#[cfg(not(windows))]
fn apply_effect(_window: &WebviewWindow) -> bool {
    false
}

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

/// Whether the translucent backdrop applied. Fixed for the life of the window.
#[tauri::command]
pub fn window_effect_active(state: State<'_, ChromeState>) -> bool {
    state.effect_active.load(Ordering::Relaxed)
}
