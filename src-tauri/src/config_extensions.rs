use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use serde_json::Value;
use tauri::State;

use crate::capability_lifecycle::{CapabilityKind, capability_name, change_capability_state};
use crate::config_io::remove_directory;
use crate::pi_worker_runtime::PiWorkerRuntime;
use crate::workspace_access::WorkspaceRegistry;

use super::config_skill_details::{allowed_skill_path, skill_details_from_directory};
use crate::config_core::*;
#[path = "config_pi_resources.rs"]
mod pi_resources;
#[path = "config_pi_policy.rs"]
mod pi_runtime_policy;
#[path = "config_plugin_catalog.rs"]
mod plugin_catalog;
#[path = "config_prompt_resources.rs"]
mod prompt_resources;
pub(crate) use self::pi_resources::{
    pi_plugin_agent_roots, pi_resource_manifest_parts, pi_skill_catalog_paths, pi_skill_extensions,
    pi_skill_paths,
};
pub(crate) use self::pi_runtime_policy::{
    pi_goal_policy, pi_load_envrc, pi_model_network_policy, pi_question_timeout_policy,
    pi_respect_gitignore, pi_sandbox_profile, pi_terminal_policy,
};
pub(crate) use self::plugin_catalog::{PluginEnablement, pi_plugin_resources};
pub(crate) use self::prompt_resources::pi_prompt_paths;

/// Enablement rule for one extension kind.
///
/// Skills and hooks are only ever opted out of, while plugins additionally
/// require an explicit opt-in. Keeping the two rules in one type prevents a
/// plugin scan from accidentally falling back to opt-out semantics.
pub(crate) enum ExtensionEnablement<'a> {
    DisabledOnly(&'a HashSet<String>),
    Plugins(&'a PluginEnablement),
}

impl ExtensionEnablement<'_> {
    fn is_enabled(&self, scope: &str, path: &Path, name: &str) -> bool {
        match self {
            Self::DisabledOnly(disabled) => !disabled.contains(name),
            Self::Plugins(plugins) => plugins.is_enabled(scope, path, name),
        }
    }
}

pub(crate) fn scan_kind(
    root: &Path,
    scope: &str,
    kind: &str,
    provider: &str,
    enablement: &ExtensionEnablement<'_>,
    extensions: &mut Vec<MelodyExtension>,
) {
    let directory = root.join(kind);
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let valid = if kind == "hooks" {
            file_type.is_file() || file_type.is_dir()
        } else if kind == "skills" {
            file_type.is_dir() && path.join("SKILL.md").is_file()
        } else {
            file_type.is_dir()
        };
        if !valid {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let enabled = enablement.is_enabled(scope, &path, &name);
        extensions.push(MelodyExtension {
            kind: kind.to_string(),
            name,
            path: path.to_string_lossy().into_owned(),
            scope: scope.to_string(),
            provider: provider.to_string(),
            managed: false,
            enabled,
            description: None,
            source: None,
            plugin_name: None,
            user_invocable: None,
            compatibility_status: None,
            deletable: false,
        });
    }
}

/// Bounds for `[skills].ignore`; must match the worker's parsed limits.
pub(crate) const MAX_PI_SKILL_IGNORE_BYTES: usize = 4096;
/// Resolve a string-array config key across scopes, lowest precedence first.
/// A later document replaces the value for the whole key, matching Melody's
/// `deep_merge_toml` array semantics.
pub(crate) fn merged_config_array(
    cwd: &str,
    section: &str,
    key: &str,
) -> Result<Vec<String>, String> {
    let mut resolved: Vec<String> = Vec::new();
    for scope in ["user", "project"] {
        let document = read_melody_config_inner(scope.to_string(), cwd.to_string())?;
        let Some(entries) = document
            .values
            .get(section)
            .and_then(|section| section.get(key))
            .and_then(Value::as_array)
        else {
            continue;
        };
        resolved = entries
            .iter()
            .filter_map(Value::as_str)
            .map(|entry| entry.trim().to_string())
            .filter(|entry| !entry.is_empty())
            .collect();
    }
    Ok(resolved)
}

/// Resolve a scalar string config key across scopes, project last (wins).
pub(crate) fn merged_config_string(cwd: &str, section: &str, key: &str) -> Option<String> {
    let mut resolved = None;
    for scope in ["user", "project"] {
        let Ok(document) = read_melody_config_inner(scope.to_string(), cwd.to_string()) else {
            continue;
        };
        if let Some(value) = document
            .values
            .get(section)
            .and_then(|section| section.get(key))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            resolved = Some(value.to_string());
        }
    }
    resolved
}

pub(crate) fn extension_config_names(
    scope: &str,
    cwd: &str,
    kind: &str,
    field: &str,
) -> Result<HashSet<String>, String> {
    let document = read_melody_config_inner(scope.to_string(), cwd.to_string())?;
    Ok(document
        .values
        .get(kind)
        .and_then(serde_json::Value::as_object)
        .and_then(|section| section.get(field))
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_string)
        .collect())
}

#[tauri::command]
pub async fn set_melody_extension_enabled(
    registry: State<'_, WorkspaceRegistry>,
    runtime: State<'_, PiWorkerRuntime>,
    scope: String,
    cwd: String,
    kind: String,
    name: String,
    enabled: bool,
) -> Result<MelodyConfigDocument, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    let kind = CapabilityKind::parse(&kind)?;
    let name = capability_name(&name)?;
    let config_key = kind.config_key();
    let disabled = extension_config_names(&scope, &cwd, config_key, "disabled")?;
    let explicitly_enabled = if kind == CapabilityKind::Plugin {
        extension_config_names(&scope, &cwd, config_key, "enabled")?
    } else {
        HashSet::new()
    };
    let update = change_capability_state(kind, name, enabled, disabled, explicitly_enabled);
    let mut patches = Vec::with_capacity(if kind == CapabilityKind::Plugin { 2 } else { 1 });
    patches.push(MelodyConfigPatch {
        path: vec![config_key.to_string(), "disabled".to_string()],
        value: serde_json::json!(update.disabled),
    });
    if let Some(explicitly_enabled) = update.explicitly_enabled {
        patches.push(MelodyConfigPatch {
            path: vec![config_key.to_string(), "enabled".to_string()],
            value: serde_json::json!(explicitly_enabled),
        });
    }
    let document = update_melody_config_inner(scope, cwd.clone(), patches)?;
    // A running Pi worker keeps its startup root manifest in process memory.
    // Push the newly-read disabled snapshot over the Host pipe immediately;
    // if no Pi worker is active the next worker start will read it normally.
    let _ = runtime
        .refresh_resources_if_workspace(Path::new(&cwd))
        .await;
    Ok(document)
}

#[tauri::command]
pub fn list_melody_extensions(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
) -> Result<Vec<MelodyExtension>, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    let user_root = melody_home()?;
    let project_root = project_melody_root(&cwd)?;
    let plugin_enablement = PluginEnablement::for_workspace(&cwd)?;
    let mut extensions = Vec::new();
    for (scope, root) in [("user", user_root), ("project", project_root)] {
        for kind in ["skills", "plugins", "hooks"] {
            let disabled = if matches!(kind, "skills" | "plugins") {
                extension_config_names(scope, &cwd, kind, "disabled")?
            } else {
                HashSet::new()
            };
            let enablement = if kind == "plugins" {
                ExtensionEnablement::Plugins(&plugin_enablement)
            } else {
                ExtensionEnablement::DisabledOnly(&disabled)
            };
            scan_kind(&root, scope, kind, "melody", &enablement, &mut extensions);
        }
    }
    let user_claude_root = user_home()?.join(".claude");
    let project_claude_root = PathBuf::from(&cwd).join(".claude");
    for (scope, root) in [("user", user_claude_root), ("project", project_claude_root)] {
        scan_kind(
            &root,
            scope,
            "plugins",
            "claude",
            &ExtensionEnablement::Plugins(&plugin_enablement),
            &mut extensions,
        );
    }
    extensions.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then(left.name.cmp(&right.name))
            .then(left.scope.cmp(&right.scope))
            .then(left.provider.cmp(&right.provider))
    });
    Ok(extensions)
}

#[tauri::command]
pub fn list_melody_skills(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
) -> Result<Vec<MelodyExtension>, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    pi_skill_extensions(&cwd)
}

// Catalog membership and workspace authorization stay at this command seam;
// config_skill_details owns the bounded Markdown projection.
#[tauri::command]
pub fn get_melody_skill_details(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    name: String,
    path: String,
) -> Result<SkillDetails, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    let root = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("Skill path is unavailable: {error}"))?;
    let (active, disabled) = pi_skill_catalog_paths(&cwd)?;
    let discovered = active
        .iter()
        .chain(disabled.iter())
        .any(|directory| directory == &root);
    if !discovered {
        return Err("Skill is no longer present in Pi's skill catalog".to_string());
    }
    skill_details_from_directory(&root, &name)
}

#[tauri::command]
pub async fn delete_melody_skill(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    name: String,
    path: String,
) -> Result<String, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    let root = allowed_skill_path(&cwd, Path::new(&path))?;
    remove_directory(&root, "skill")?;
    Ok(format!("Skill {} was deleted", name.trim()))
}
