//! Desktop control surfaces that steer playback from outside the window: a
//! menu-bar tray mini-controller and a global Play/Pause hotkey. Both just
//! emit a `media-command` event ("playpause" | "next" | "prev"); the frontend
//! owns the actual transport (it knows whether the engine or a YouTube embed is
//! playing). Window show/hide and quit are handled here directly.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{App, Emitter, Manager};

/// Bring the main window to the front (used by the tray "Show" item).
fn show_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Build the tray icon + its menu.
fn setup_tray(app: &App) -> tauri::Result<()> {
    let playpause = MenuItem::with_id(app, "playpause", "Play / Pause", true, None::<&str>)?;
    let prev = MenuItem::with_id(app, "prev", "Previous", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "Next", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show MUSICPAX", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit MUSICPAX", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[&playpause, &prev, &next, &sep1, &show, &sep2, &quit],
    )?;

    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("MUSICPAX")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "playpause" => {
                let _ = app.emit("media-command", "playpause");
            }
            "next" => {
                let _ = app.emit("media-command", "next");
            }
            "prev" => {
                let _ = app.emit("media-command", "prev");
            }
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Wire up the tray. Failures are logged, never fatal — the app still runs
/// fine without it.
///
/// NOTE: a global Play/Pause hotkey was intentionally removed. On macOS the
/// global-shortcut plugin installs a CGEventTap that sits in the system input
/// path, and a killed/crashed instance can leave a dangling tap that lags the
/// whole machine's mouse/keyboard. The menu-bar tray + Now Playing media keys
/// cover transport without touching the input event stream.
pub fn init(app: &App) {
    if let Err(e) = setup_tray(app) {
        eprintln!("tray setup failed: {e}");
    }
}
