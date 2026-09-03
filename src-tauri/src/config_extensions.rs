use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use tauri::{AppHandle, State};

use crate::capability_lifecycle::{CapabilityKind, capability_name, change_capability_state};
use crate::melody_command::MelodyCommandRunner;
use crate::workspace_access::WorkspaceRegistry;

use super::config_core::*;
use super::config_plugin_details::allowed_skill_path;

pub(crate) fn scan_kind(
    root: &Path,
    scope: &str,
    kind: &str,
    provider: &str,
    disabled: &HashSet<String>,
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
        let enabled = !disabled.contains(&name);
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
    update_melody_config_inner(scope, cwd, patches)
}

#[tauri::command]
pub fn list_melody_extensions(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
) -> Result<Vec<MelodyExtension>, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    let user_root = melody_home()?;
    let project_root = project_melody_root(&cwd)?;
    let mut extensions = Vec::new();
    for (scope, root) in [("user", user_root), ("project", project_root)] {
        for kind in ["skills", "plugins", "hooks"] {
            let disabled = if matches!(kind, "skills" | "plugins") {
                extension_config_names(scope, &cwd, kind, "disabled")?
            } else {
                HashSet::new()
            };
            scan_kind(&root, scope, kind, "melody", &disabled, &mut extensions);
        }
    }
    let user_claude_root = user_home()?.join(".claude");
    let project_claude_root = PathBuf::from(&cwd).join(".claude");
    for (scope, root) in [("user", user_claude_root), ("project", project_claude_root)] {
        let disabled = extension_config_names(scope, &cwd, "plugins", "disabled")?;
        scan_kind(
            &root,
            scope,
            "plugins",
            "claude",
            &disabled,
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

pub(crate) async fn run_melody_inspect(
    app: &AppHandle,
    cwd: &str,
) -> Result<MelodyInspectDocument, String> {
    let mut command =
        MelodyCommandRunner::new(app).command(&["inspect", "--json"], Some(Path::new(cwd)))?;
    let output = command
        .output()
        .await
        .map_err(|error| format!("Failed to inspect Melody skills: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("Melody inspection failed with status {}", output.status)
        } else {
            stderr
        });
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Melody returned an invalid inspection document: {error}"))
}

pub(crate) fn inspect_skill_directory(path: &Path) -> Option<PathBuf> {
    if path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md") {
        path.parent().map(Path::to_path_buf)
    } else if path.join("SKILL.md").is_file() {
        Some(path.to_path_buf())
    } else {
        None
    }
}

fn inspect_skill_provider(skill: &MelodyInspectSkill, directory: &Path) -> String {
    if let Some(vendor) = skill.vendor.as_deref() {
        return vendor.to_string();
    }
    if skill.source.kind == "plugin" {
        return "plugin".to_string();
    }
    let path = directory.to_string_lossy();
    if path.contains("/.agents/") || path.contains("\\.agents\\") {
        "agents".to_string()
    } else if path.contains("/.claude/") || path.contains("\\.claude\\") {
        "claude".to_string()
    } else if path.contains("/.cursor/") || path.contains("\\.cursor\\") {
        "cursor".to_string()
    } else {
        "melody".to_string()
    }
}

pub(crate) fn melody_skill_extensions(
    cwd: &str,
    document: MelodyInspectDocument,
) -> Vec<MelodyExtension> {
    let project = PathBuf::from(cwd).canonicalize().ok();
    document
        .skills
        .into_iter()
        .filter_map(|skill| {
            let source_path = skill.source.path.as_deref()?;
            let directory = inspect_skill_directory(source_path)?;
            let canonical = directory
                .canonicalize()
                .unwrap_or_else(|_| directory.clone());
            let scope = if matches!(skill.source.kind.as_str(), "local" | "repo" | "project")
                || project
                    .as_ref()
                    .is_some_and(|root| canonical.starts_with(root))
            {
                "project"
            } else {
                "user"
            };
            let compatibility_disabled = skill.compatibility_status.as_deref() == Some("disabled");
            let provider = inspect_skill_provider(&skill, &canonical);
            Some(MelodyExtension {
                kind: "skills".to_string(),
                name: skill.name,
                path: canonical.to_string_lossy().into_owned(),
                scope: scope.to_string(),
                provider,
                managed: matches!(skill.source.kind.as_str(), "plugin" | "server" | "bundled"),
                enabled: !skill.disabled && !compatibility_disabled,
                description: skill.description,
                source: Some(skill.source.kind),
                plugin_name: skill.source.plugin_name,
                user_invocable: skill.user_invocable,
                compatibility_status: skill.compatibility_status,
                deletable: allowed_skill_path(cwd, &canonical).is_ok(),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn list_melody_skills(
    app: AppHandle,
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
) -> Result<Vec<MelodyExtension>, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    let document = run_melody_inspect(&app, &cwd).await?;
    Ok(melody_skill_extensions(&cwd, document))
}
