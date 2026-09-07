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

/// The corner radius, in CSS pixels, matching `--r-window` in `src/styles/world.css`.
///
/// Duplicated rather than read from the frontend because the OS needs it before the
/// webview has painted anything. If one moves, move the other.
const CORNER_RADIUS: f64 = 10.0;

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

    round_corners(&window);

    let app = app.clone();
    window.on_window_event(move |event| {
        // Our own button, a double click on the drag region, a Win+Arrow snap and a drag
        // to the top of the screen all reach us as a resize; nothing else says the
        // maximized state changed.
        if matches!(event, WindowEvent::Resized(_)) {
            publish_maximized(&app);
            // A window region is in physical pixels and does not follow the window, so
            // every resize needs a new one -- including the DPI changes that arrive here
            // as a resize.
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                round_corners(&window);
            }
        }
    });
}

/// Clip the window to a rounded rectangle, because nothing else will.
///
/// The frontend draws the radius in CSS and clips correctly -- the webview's own corner
/// pixels are transparent, measured. What it composites against is the problem: this
/// window has no per-pixel alpha (`WS_EX_LAYERED` is unset, and Windows 10 rounds no
/// window itself), so those transparent pixels come back as the opaque surface underneath
/// and the corner reads as square. A window region removes the pixels from the window
/// instead of asking DWM to blend them, which is the one approach that does not depend on
/// the compositor, the graphics driver, or whether a backdrop effect applied.
///
/// Two things this deliberately does not do. It does not antialias -- a region is a hard
/// clip, and at 10px on a dark window the stair-step is a pixel or two that the CSS radius
/// still softens on the inside edge. And it squares the corners when maximized, the way
/// every editor does: a rounded corner against the screen edge reads as a gap in the
/// window rather than as a shape.
///
/// `SetWindowRgn` is documented as unreliable on layered windows. It is used here *because*
/// this window is not one; if that ever changes, per-pixel alpha would work and this whole
/// function becomes unnecessary rather than merely wrong.
///
/// The cost is the invisible resize border, which the region clips away with the rest of
/// the non-client area: the grab zone for an edge drag becomes the content edge rather
/// than eight pixels outside it. Corners are the noticeable part of that -- a diagonal
/// resize now wants the corner itself.
#[cfg(windows)]
fn round_corners(window: &WebviewWindow) {
    use std::ffi::c_void;

    // All three live in Gdi, SetWindowRgn included -- it is a region call that happens
    // to take a window, not a window call.
    use windows_sys::Win32::Graphics::Gdi::{CreateRoundRectRgn, DeleteObject, SetWindowRgn};

    let Ok(handle) = window.hwnd() else {
        eprintln!("[window] no handle to round the corners of");
        return;
    };
    // Through `isize` so this compiles whether the handle is a pointer or an integer --
    // that type has changed across `windows` releases and tauri picks the version.
    let handle = handle.0 as isize as *mut c_void;

    // `true` on the redraw flag: the region takes effect on the next paint either way, and
    // without it a resize leaves the old corner on screen until something else invalidates.
    if window.is_maximized().unwrap_or(false) {
        unsafe { SetWindowRgn(handle, std::ptr::null_mut(), 1) };
        return;
    }

    // The region is in *window* coordinates but must cover only the client area.
    //
    // This window keeps `WS_CAPTION` and `WS_SIZEBOX` -- tao leaves the styles on and hides
    // the frame through DWM -- so the outer rect is 8px wider on each side and 8px taller
    // at the bottom than what the webview draws. A region built from the outer size stops
    // DWM hiding that border and Windows paints it: a light frame around the content,
    // offset from it, rounded on the outside while the content stays square inside. Which
    // is worse than the square corner it was meant to fix. Clipping to the client rect
    // removes the border from the window instead.
    let (Ok(outer), Ok(inner), Ok(size)) = (
        window.outer_position(),
        window.inner_position(),
        window.inner_size(),
    ) else {
        return;
    };
    let left = inner.x - outer.x;
    let top = inner.y - outer.y;

    let scale = window.scale_factor().unwrap_or(1.0);
    // `CreateRoundRectRgn` takes the ellipse's width and height, which is the diameter.
    let diameter = (CORNER_RADIUS * 2.0 * scale).round() as i32;
    // The rectangle is exclusive on the right and bottom, so both edges get one more pixel
    // or the region falls a pixel short of the client area and shows a seam.
    let region = unsafe {
        CreateRoundRectRgn(
            left,
            top,
            left + size.width as i32 + 1,
            top + size.height as i32 + 1,
            diameter,
            diameter,
        )
    };
    if region.is_null() {
        eprintln!("[window] could not build a rounded region; corners stay square");
        return;
    }
    // The window owns the region once this succeeds, and must not have it freed underneath
    // it. On failure it is still ours, and leaking a GDI object per resize is not an option.
    if unsafe { SetWindowRgn(handle, region, 1) } == 0 {
        unsafe { DeleteObject(region) };
        eprintln!("[window] the rounded region was refused; corners stay square");
    }
}

/// Only Windows needs this: every other platform rounds its own windows.
#[cfg(not(windows))]
fn round_corners(_window: &WebviewWindow) {}

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
