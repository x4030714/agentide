use tauri::Manager;

mod agent;
mod checkpoints;
mod conversations;
mod fs;
mod git;
mod hardware;
mod ipc;
mod lsp;
mod memory;
mod pty;
mod reaper;
mod tools;
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
            // Before anything is spawned: a child started first cannot join the job later
            // without a race.
            reaper::init();
            // Frameless and transparent: this is what makes the window translucent and keeps
            // the frontend's title bar in step with the maximized state.
            window::setup(app.handle());
            // Where the installed app keeps the agent host bundle. Absent under `cargo run`,
            // which is why `agent.rs` falls back to the repository path.
            if let Ok(dir) = app.path().resource_dir() {
                agent::set_resource_dir(dir.clone());
                tools::set_resource_dir(dir);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            conversations::conversations_list,
            conversations::conversation_read,
            conversations::conversation_import,
            conversations::claude_projects_list,
            conversations::claude_conversations_list,
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
            tools::tools_signed_in,
            memory::memory_vault,
            memory::memory_seed,
            memory::memory_stats,
            memory::memory_reveal,
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
            hardware::gpu_vram_gb,
            window::window_is_maximized,
            window::window_effect_active,
            window::window_set_backdrop,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Sidecar, ptys and language servers are child processes, not threads: nothing
            // else stops them on close, and managed state is not guaranteed to be dropped.
            if matches!(event, tauri::RunEvent::Exit) {
                agent::shutdown(app);
                pty::shutdown(app);
                lsp::shutdown(app);
            }
        });
}
