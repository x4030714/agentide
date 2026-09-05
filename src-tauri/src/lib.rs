use tauri::Manager;

mod agent;
mod checkpoints;
mod conversations;
mod fs;
mod git;
mod ipc;
mod lsp;
mod pty;
mod window;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(fs::WorkspaceState::default())
        .manage(agent::AgentState::default())
        .manage(pty::PtyState::default())
        .manage(lsp::LspState::default())
        .manage(window::ChromeState::default())
        .setup(|app| {
            // The window is frameless and transparent; this is what makes it translucent
            // and what keeps the frontend's title bar in step with the maximized state.
            window::setup(app.handle());
            // Where the installed app keeps the agent host bundle. Absent in a `cargo
            // run`, which is why `agent.rs` falls back to the path in the repository.
            if let Ok(dir) = app.path().resource_dir() {
                agent::set_resource_dir(dir);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            conversations::conversations_list,
            conversations::conversation_read,
            git::git_status,
            git::git_file_diff,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_branches,
            git::git_switch,
            fs::open_workspace,
            fs::close_workspace,
            fs::list_dir,
            fs::list_files,
            fs::read_file,
            fs::write_file,
            agent::agent_start,
            agent::agent_stop,
            agent::agent_prompt,
            agent::agent_interrupt,
            agent::agent_permission_reply,
            agent::agent_tool_reply,
            checkpoints::checkpoint_create,
            checkpoints::checkpoint_list,
            checkpoints::checkpoint_diff,
            checkpoints::checkpoint_file_diff,
            checkpoints::checkpoint_hunks,
            checkpoints::checkpoint_revert_file,
            checkpoints::checkpoint_revert_hunks,
            checkpoints::checkpoint_rewind,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            window::window_minimize,
            window::window_toggle_maximize,
            window::window_close,
            window::window_is_maximized,
            window::window_effect_active,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // The sidecar, every pty and every language server are child processes,
            // not threads: nothing else stops them when the window closes, and managed
            // state is not guaranteed to be dropped here.
            if matches!(event, tauri::RunEvent::Exit) {
                agent::shutdown(app);
                pty::shutdown(app);
                lsp::shutdown(app);
            }
        });
}
