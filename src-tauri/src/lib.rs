mod acp_policy;
mod agent_runtime;
mod capability_lifecycle;
mod config_io;
mod config_runtime;
mod database;
mod environment_runtime;
mod git_runtime;
mod melody_command;
mod menu_bar;
mod power_runtime;
mod research_runtime;
mod update_runtime;
mod workspace_access;
mod workspace_runtime;

use agent_runtime::{AgentRuntime, agent_status, send_acp, start_agent, stop_agent};
use config_runtime::{
    add_marketplace_source, delete_marketplace_source, delete_melody_skill,
    get_melody_plugin_details, get_melody_skill_details, install_melody_plugin,
    list_installed_melody_plugins, list_marketplace_sources, list_melody_extensions,
    list_melody_skills, read_melody_config, save_marketplace_source, scan_marketplace_plugins,
    set_melody_extension_enabled, uninstall_melody_plugin, update_melody_config,
    update_melody_plugin,
};
use database::{
    AppDatabase, archive_project, create_session, delete_permission_rule, delete_project,
    delete_session, find_permission_rule, get_usage_statistics, list_permission_rules,
    list_projects, list_sessions, read_session_timeline, restore_project, update_session,
    upsert_permission_rule, upsert_project,
};
use environment_runtime::{get_environment_capabilities, get_file_opener_availability};
use git_runtime::{
    git_branches, git_changes, git_checkout_branch, git_commit, git_create_branch,
    git_create_worktree, git_diff, git_remove_worktree, git_stage, git_unstage, git_worktrees,
};
use research_runtime::fetch_research_resource;
use tauri::Manager;
use update_runtime::check_app_update;
use workspace_access::WorkspaceRegistry;
use workspace_runtime::{
    TerminalRuntime, close_terminal_session, create_terminal_session, pick_workspace_directory,
    read_workspace_binary_file, read_workspace_file, resize_terminal_session, workspace_tree,
    write_terminal_input, write_workspace_file,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let database = AppDatabase::open(app.handle())?;
            app.manage(database);
            #[cfg(desktop)]
            menu_bar::initialize(app)?;
            Ok(())
        })
        .manage(AgentRuntime::default())
        .manage(WorkspaceRegistry::default())
        .manage(TerminalRuntime::default())
        .manage(menu_bar::MenuBarState::default())
        .manage(power_runtime::SystemSleepState::default())
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.app_handle().state::<menu_bar::MenuBarState>();
                if state.is_enabled() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            agent_status,
            start_agent,
            send_acp,
            stop_agent,
            git_changes,
            git_diff,
            git_branches,
            git_stage,
            git_unstage,
            git_commit,
            git_checkout_branch,
            git_create_branch,
            git_worktrees,
            git_create_worktree,
            git_remove_worktree,
            list_projects,
            upsert_project,
            archive_project,
            restore_project,
            delete_project,
            list_sessions,
            create_session,
            update_session,
            read_session_timeline,
            delete_session,
            get_usage_statistics,
            get_environment_capabilities,
            get_file_opener_availability,
            menu_bar::set_menu_bar_visibility,
            power_runtime::set_system_sleep_prevention,
            workspace_tree,
            pick_workspace_directory,
            read_workspace_binary_file,
            read_workspace_file,
            write_workspace_file,
            create_terminal_session,
            write_terminal_input,
            resize_terminal_session,
            close_terminal_session,
            read_melody_config,
            update_melody_config,
            list_melody_extensions,
            list_melody_skills,
            set_melody_extension_enabled,
            list_marketplace_sources,
            add_marketplace_source,
            save_marketplace_source,
            delete_marketplace_source,
            install_melody_plugin,
            scan_marketplace_plugins,
            update_melody_plugin,
            list_installed_melody_plugins,
            get_melody_plugin_details,
            get_melody_skill_details,
            uninstall_melody_plugin,
            delete_melody_skill,
            list_permission_rules,
            find_permission_rule,
            upsert_permission_rule,
            delete_permission_rule,
            fetch_research_resource,
            check_app_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
