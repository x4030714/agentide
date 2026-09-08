//! Chrome for the frameless window: the translucent backdrop, plus the verbs and state the
//! frontend's title bar needs. Corners stay square -- a GDI region also clips the resize border.

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
/// Atomics: written from setup, the main-thread event handler, and `window_set_backdrop`.
#[derive(Default)]
pub struct ChromeState {
    /// Whether the translucent backdrop is on. False means the frontend supplies its own
    /// opaque ground.
    effect_active: AtomicBool,
    /// Last value published on [`MAXIMIZED_EVENT`], so a resize storm emits one event per
    /// actual change.
    maximized: AtomicBool,
}

/// Apply the backdrop and start publishing maximized changes. Call once, from `setup`.
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
        // Our button, a double click on the drag region, a Win+Arrow snap and a drag to the
        // top all arrive as a resize; nothing else reports the maximized state changing.
        if matches!(event, WindowEvent::Resized(_)) {
            publish_maximized(&app);
        }
    });
}

/// Emit [`MAXIMIZED_EVENT`] only when the state differs from the one already published.
/// Main thread: the window getters are serviced inline there, so this cannot deadlock.
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
/// Blur below Windows 11, mica from 11: mica fails on 10, and acrylic lags on 10 v1903+.
#[cfg(windows)]
fn apply_effect(window: &WebviewWindow) -> bool {
    /// The build Windows 11 starts at, which is also the one `apply_mica` needs.
    const WINDOWS_11: u32 = 22000;

    // Escape hatch: the effect depends on the compositor and driver, not on anything here.
    // `AGENTIDE_NO_BACKDROP=1` runs the window opaque, which the frontend already handles.
    if std::env::var_os("AGENTIDE_NO_BACKDROP").is_some() {
        eprintln!("[window] backdrop disabled by AGENTIDE_NO_BACKDROP");
        return false;
    }

    let build = windows_version::OsVersion::current().build;
    // `None` leaves the tint to CSS: the effect only blurs what is behind the window.
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

/// Take the backdrop away again, for Transparency off. Both are cleared because which one
/// applied depends on the Windows build; "no mica to clear" is expected on Windows 10.
#[cfg(windows)]
fn clear_effect(window: &WebviewWindow) {
    let _ = window_vibrancy::clear_mica(window);
    let _ = window_vibrancy::clear_blur(window);
}

/// No backdrop off Windows; the frontend paints its own background.
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
/// A double click on the drag region takes Tauri's own route; both emit [`MAXIMIZED_EVENT`].
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

/// What the OS close button did -- the normal close path, so `lib.rs`'s exit handler still
/// shuts the sidecar down.
#[tauri::command]
pub fn window_close(app: AppHandle) -> Result<(), IpcError> {
    main_window(&app)?
        .close()
        .map_err(|err| failed("close the window", err))
}

/// The current state, for the title bar's first paint. Changes arrive on [`MAXIMIZED_EVENT`].
#[tauri::command]
pub fn window_is_maximized(app: AppHandle) -> Result<bool, IpcError> {
    main_window(&app)?
        .is_maximized()
        .map_err(|err| failed("read the maximized state", err))
}

/// Whether the translucent backdrop is on right now: what setup managed, then whatever the
/// Transparency setting made of it.
#[tauri::command]
pub fn window_effect_active(state: State<'_, ChromeState>) -> bool {
    state.effect_active.load(Ordering::Relaxed)
}

/// Put the backdrop back, or take it away, and answer with what is true afterwards: asking
/// for it is not getting it. Async because a slow DWM call would freeze the webview.

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
