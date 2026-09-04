mod agent;
mod fs;
mod ipc;
mod window;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(fs::WorkspaceState::default())
        .manage(agent::AgentState::default())
        .manage(window::ChromeState::default())
        .setup(|app| {
            // The window is frameless and transparent; this is what makes it translucent
            // and what keeps the frontend's title bar in step with the maximized state.
            window::setup(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fs::open_workspace,
            fs::close_workspace,
            fs::list_dir,
            fs::read_file,
            fs::write_file,
            agent::agent_start,
            agent::agent_stop,
            agent::agent_prompt,
            agent::agent_interrupt,
            agent::agent_permission_reply,
            agent::agent_tool_reply,
            window::window_minimize,
            window::window_toggle_maximize,
            window::window_close,
            window::window_is_maximized,
            window::window_effect_active,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // The sidecar is a child process, not a thread: nothing else stops it when
            // the window closes, and managed state is not guaranteed to be dropped here.
            if matches!(event, tauri::RunEvent::Exit) {
                agent::shutdown(app);
            }
        });
}
