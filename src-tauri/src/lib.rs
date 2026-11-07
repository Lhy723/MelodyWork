mod agent_runtime;
mod agent_session_lifecycle;
mod background_task_runtime;
mod capability_lifecycle;
mod config_core;
mod config_io;
mod config_runtime;
mod cron_schedule;
mod database;
mod environment_runtime;
mod git_runtime;
mod menu_bar;
mod pi_browser_runtime;
mod pi_codebase_runtime;
mod pi_hook_runtime;
mod pi_lsp_runtime;
mod pi_mcp_runtime;
mod pi_memory_runtime;
mod pi_model_config;
mod pi_monitor_runtime;
mod pi_storage;
mod pi_tool_gateway;
mod pi_tool_output_archive;
mod pi_web_runtime;
mod pi_worker_runtime;
mod power_runtime;
mod research_runtime;
mod schedule_dispatch;
mod update_runtime;
mod workspace_access;
mod workspace_runtime;
mod workspace_sandbox;

use database::AppDatabase;
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
            // Host-owned schedules are durable across restarts, so the
            // dispatcher starts with the app rather than with a session. It
            // only ever starts an ordinary turn in a Pi-bound session and
            // records the worker's real acknowledgement.
            schedule_dispatch::spawn_dispatch_loop(app.handle().clone());
            Ok(())
        })
        .manage(pi_worker_runtime::PiWorkerRuntime::default())
        .manage(pi_browser_runtime::PiBrowserRuntime::default())
        .manage(pi_mcp_runtime::PiMcpRuntime::default())
        .manage(schedule_dispatch::DispatchRegistry::default())
        .manage(WorkspaceRegistry::default())
        .manage(TerminalRuntime::default())
        .manage(menu_bar::MenuBarState::default())
        .manage(power_runtime::SystemSleepState::default())
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            if window.label() == "main"
                && let tauri::WindowEvent::CloseRequested { api, .. } = event
            {
                let state = window.app_handle().state::<menu_bar::MenuBarState>();
                if state.is_enabled() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(state) = window
                    .app_handle()
                    .try_state::<pi_browser_runtime::PiBrowserRuntime>()
                {
                    pi_browser_runtime::close_main_window(&state);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            pi_worker_runtime::pi_worker_status,
            pi_worker_runtime::start_pi_worker,
            pi_worker_runtime::send_pi_agent_command,
            pi_worker_runtime::stop_pi_worker,
            pi_browser_runtime::pi_browser_open,
            pi_browser_runtime::pi_browser_navigate,
            pi_browser_runtime::pi_browser_snapshot,
            pi_browser_runtime::pi_browser_screenshot,
            pi_browser_runtime::pi_browser_close,
            pi_browser_runtime::pi_browser_tab_open,
            pi_browser_runtime::pi_browser_tab_select,
            pi_browser_runtime::pi_browser_tab_close,
            pi_browser_runtime::pi_browser_set_bounds,
            pi_browser_runtime::pi_browser_set_popup_policy,
            pi_browser_runtime::pi_browser_navigate_local_preview,
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
            database::list_projects,
            database::upsert_project,
            database::archive_project,
            database::restore_project,
            agent_session_lifecycle::delete_project,
            database::list_sessions,
            database::create_session,
            database::update_session,
            database::read_session_timeline,
            agent_session_lifecycle::delete_session,
            database::get_agent_session_binding,
            database::get_pi_session_fork,
            database::list_pi_session_forks,
            database::read_pi_session_fork_reference,
            database::prepare_pi_session_fork,
            database::upsert_agent_session_binding,
            database::delete_agent_session_binding,
            database::begin_pi_migration,
            database::list_pi_migration_journal,
            database::fail_pi_migration,
            database::read_agent_event_log,
            database::inspect_pi_session_recovery,
            database::create_agent_schedule,
            database::list_agent_schedules,
            database::set_agent_schedule_status,
            database::list_agent_schedule_runs,
            database::delete_agent_schedule,
            database::get_usage_statistics,
            workspace_sandbox::read_workspace_sandbox_plan,
            background_task_runtime::list_background_terminal_tasks,
            background_task_runtime::cancel_background_terminal_task,
            pi_monitor_runtime::start_agent_monitor,
            pi_monitor_runtime::list_agent_monitors,
            pi_monitor_runtime::cancel_agent_monitor,
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
            config_runtime::read_melody_config,
            config_runtime::read_melody_runtime_environment,
            config_runtime::list_melody_agent_definitions,
            config_runtime::list_melody_lsp_servers,
            config_runtime::list_melody_mcp_servers,
            config_runtime::list_melody_hooks,
            config_runtime::list_melody_plugin_capabilities,
            config_runtime::rebuild_melody_memory_index,
            config_runtime::update_melody_config,
            config_runtime::list_melody_extensions,
            config_runtime::list_melody_skills,
            config_runtime::set_melody_extension_enabled,
            config_runtime::list_marketplace_sources,
            config_runtime::add_marketplace_source,
            config_runtime::save_marketplace_source,
            config_runtime::delete_marketplace_source,
            config_runtime::install_melody_plugin,
            config_runtime::scan_marketplace_plugins,
            config_runtime::update_melody_plugin,
            config_runtime::list_installed_melody_plugins,
            config_runtime::get_melody_plugin_details,
            config_runtime::get_melody_skill_details,
            config_runtime::uninstall_melody_plugin,
            config_runtime::delete_melody_skill,
            database::list_permission_rules,
            database::find_permission_rule,
            database::upsert_permission_rule,
            database::delete_permission_rule,
            fetch_research_resource,
            check_app_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
