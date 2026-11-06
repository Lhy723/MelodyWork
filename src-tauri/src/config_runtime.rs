#[path = "config_extensions.rs"]
mod config_extensions;
#[path = "config_marketplace.rs"]
mod config_marketplace;
#[path = "config_plugin_details.rs"]
mod config_plugin_details;
#[path = "config_skill_details.rs"]
mod config_skill_details;
#[path = "config_subagents.rs"]
mod config_subagents;

use std::path::Path;

use serde_json::Value;

pub use crate::config_core::*;
pub use config_extensions::*;
pub use config_marketplace::*;
pub use config_plugin_details::*;

/// Update config through its storage owner, then refresh the running Pi worker.
/// Runtime refresh remains best-effort: the persisted config is the source of
/// truth and the next worker generation will project it again if needed.
#[tauri::command]
pub async fn update_melody_config(
    registry: tauri::State<'_, crate::workspace_access::WorkspaceRegistry>,
    runtime: tauri::State<'_, crate::pi_worker_runtime::PiWorkerRuntime>,
    scope: String,
    cwd: String,
    patches: Vec<MelodyConfigPatch>,
) -> Result<MelodyConfigDocument, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    let model_config_changed = patches.iter().any(|patch| {
        patch.path.first().is_some_and(|key| {
            matches!(key.as_str(), "model" | "models" | "endpoints" | "features")
        })
    });
    let user_scope = scope == "user";
    let mut document = crate::config_core::update_melody_config_inner(scope, cwd.clone(), patches)?;
    let generation = runtime.active_generation();
    if generation == 0 {
        return Ok(document);
    }
    let refresh_cwd = match runtime.worker_cwd(generation).await {
        Ok(worker_cwd) if user_scope || worker_cwd == Path::new(&cwd) => worker_cwd,
        // A project-only edit does not affect a worker in another project.
        Ok(_) => return Ok(document),
        Err(_) => {
            document.runtime_refresh_error =
                Some("设置已保存，当前会话尚未应用这些变更，请重新连接。".to_string());
            return Ok(document);
        }
    };
    // User settings apply to the active worker's workspace even when Settings
    // was opened from another project. Rebuild from that workspace so its
    // project overrides remain authoritative.
    let model_refresh_failed = model_config_changed
        && runtime
            .refresh_models_if_workspace(&refresh_cwd)
            .await
            .is_err();
    let resource_refresh_failed = runtime
        .refresh_resources_if_workspace(&refresh_cwd)
        .await
        .is_err();
    if model_refresh_failed || resource_refresh_failed {
        document.runtime_refresh_error =
            Some("设置已保存，当前会话尚未应用这些变更，请重新连接。".to_string());
    }
    Ok(document)
}

/// Compose the single Host-owned worker resource manifest from focused config
/// owners. Keep subagent policy evaluation between resource discovery and the
/// optional policy projections, matching the previous error and evaluation
/// order without creating a sibling-module dependency cycle.
pub(crate) fn pi_resource_manifest(cwd: &str) -> Result<Value, String> {
    let mut manifest = config_extensions::pi_resource_manifest_parts(cwd)?;
    manifest["subagentPolicies"] = config_subagents::pi_subagent_policy_manifest(cwd)?;
    if let Some(policy) = config_extensions::pi_question_timeout_policy(cwd) {
        manifest["questionTimeoutPolicy"] = serde_json::to_value(policy)
            .map_err(|error| format!("Failed to serialize Pi question timeout policy: {error}"))?;
    }
    if let Some(policy) = config_extensions::pi_goal_policy(cwd) {
        manifest["goalPolicy"] = policy;
    }
    Ok(manifest)
}

#[tauri::command]
pub fn list_melody_agent_definitions(
    registry: tauri::State<'_, crate::workspace_access::WorkspaceRegistry>,
    cwd: String,
) -> Result<Vec<config_subagents::MelodyAgentDefinition>, String> {
    config_subagents::list_melody_agent_definitions(registry, cwd)
}

#[tauri::command]
pub fn list_melody_lsp_servers(
    registry: tauri::State<'_, crate::workspace_access::WorkspaceRegistry>,
    cwd: String,
) -> Result<Vec<crate::pi_lsp_runtime::MelodyLspServer>, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    crate::pi_lsp_runtime::list_melody_lsp_servers(&cwd)
}

/// Return the Host-validated MCP transport inventory used by Pi preflight.
#[tauri::command]
pub fn list_melody_mcp_servers(
    registry: tauri::State<'_, crate::workspace_access::WorkspaceRegistry>,
    cwd: String,
) -> Result<Vec<crate::pi_mcp_runtime::McpServerStatus>, String> {
    let cwd = registry.authorize(&cwd)?;
    crate::pi_mcp_runtime::inspect_mcp_config(&cwd)
}

/// Return the Host-validated command-hook inventory used by Pi capability
/// preflight. Unsupported/dynamic hook definitions are surfaced explicitly so
/// the caller can keep the complete ACP path instead of silently dropping a
/// lifecycle policy.
#[tauri::command]
pub fn list_melody_hooks(
    registry: tauri::State<'_, crate::workspace_access::WorkspaceRegistry>,
    cwd: String,
) -> Result<Vec<crate::pi_hook_runtime::MelodyHookSnapshot>, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    crate::pi_hook_runtime::list_melody_hooks(&cwd)
}

/// Return the Host-validated static/dynamic plugin inventory used by Pi
/// preflight. The command never executes plugin code.
#[tauri::command]
pub fn list_melody_plugin_capabilities(
    registry: tauri::State<'_, crate::workspace_access::WorkspaceRegistry>,
    cwd: String,
) -> Result<Vec<MelodyPluginCapability>, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    config_extensions::pi_plugin_resources(&cwd)
}

/// Rebuild the Host-owned persistent memory index for a workspace.
///
/// This command is intentionally explicit so settings/diagnostics can repair
/// an index without making the model-facing memory tools depend on SQLite
/// availability. Normal searches still use the bounded in-memory scorer.
#[tauri::command]
pub fn rebuild_melody_memory_index(
    registry: tauri::State<'_, crate::workspace_access::WorkspaceRegistry>,
    cwd: String,
) -> Result<crate::pi_memory_runtime::MemoryIndexSummary, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    crate::pi_memory_runtime::rebuild_memory_index(Path::new(&cwd))
}
