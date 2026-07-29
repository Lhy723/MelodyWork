mod agent_runtime;
mod config_runtime;
mod database;
mod git_runtime;
mod update_runtime;
mod workspace_runtime;

use agent_runtime::{AgentRuntime, agent_status, send_acp, start_agent, stop_agent};
use config_runtime::{
    add_marketplace_source, delete_marketplace_source, delete_melody_skill,
    get_melody_plugin_details, get_melody_skill_details, install_melody_plugin,
    list_installed_melody_plugins, list_marketplace_sources, list_melody_extensions,
    read_melody_config, save_marketplace_source, set_melody_extension_enabled,
    uninstall_melody_plugin, update_melody_config,
};
use database::{
    AppDatabase, create_session, delete_permission_rule, delete_session, find_permission_rule,
    get_usage_statistics, list_permission_rules, list_projects, list_sessions, update_session,
    upsert_permission_rule, upsert_project,
};
use git_runtime::{
    git_branches, git_changes, git_checkout_branch, git_commit, git_create_branch,
    git_create_worktree, git_diff, git_remove_worktree, git_stage, git_unstage, git_worktrees,
};
use tauri::Manager;
use update_runtime::check_app_update;
use workspace_runtime::{
    TerminalRuntime, close_terminal_session, create_terminal_session, read_workspace_file,
    run_terminal_command, workspace_tree, write_terminal_input, write_workspace_file,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let database = AppDatabase::open(app.handle())?;
            app.manage(database);
            Ok(())
        })
        .manage(AgentRuntime::default())
        .manage(TerminalRuntime::default())
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
            list_sessions,
            create_session,
            update_session,
            delete_session,
            get_usage_statistics,
            workspace_tree,
            read_workspace_file,
            write_workspace_file,
            create_terminal_session,
            write_terminal_input,
            close_terminal_session,
            run_terminal_command,
            read_melody_config,
            update_melody_config,
            list_melody_extensions,
            set_melody_extension_enabled,
            list_marketplace_sources,
            add_marketplace_source,
            save_marketplace_source,
            delete_marketplace_source,
            install_melody_plugin,
            list_installed_melody_plugins,
            get_melody_plugin_details,
            get_melody_skill_details,
            uninstall_melody_plugin,
            delete_melody_skill,
            list_permission_rules,
            find_permission_rule,
            upsert_permission_rule,
            delete_permission_rule,
            check_app_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
