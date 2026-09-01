#[path = "config_marketplace_sources.rs"]
mod config_marketplace_sources;

pub use config_marketplace_sources::*;

use std::path::PathBuf;

use tauri::{AppHandle, State};

use crate::melody_command::MelodyCommandRunner;
use crate::workspace_access::{WorkspaceRegistry, confirm_action};

use super::config_core::*;
use super::config_extensions::extension_config_names;

#[tauri::command]
pub async fn install_melody_plugin(
    app: AppHandle,
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    source: String,
) -> Result<PluginInstallResult, String> {
    let source = source.trim();
    if source.is_empty() {
        return Err("Plugin source cannot be empty".to_string());
    }
    if source.len() > 4096 {
        return Err("Plugin source is too long".to_string());
    }
    let workspace = registry.authorize(&cwd)?;
    confirm_action(
        &app,
        "确认安装 Melody 插件",
        format!(
            "允许在 {} 以信任模式安装以下插件来源吗？\n{}",
            workspace.display(),
            source
        ),
    )
    .await?;
    let mut command = MelodyCommandRunner::new(&app)
        .command(&["plugin", "install", source, "--trust"], Some(&workspace))?;
    let output = command
        .output()
        .await
        .map_err(|error| format!("Failed to start Melody plugin installer: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(if stderr.is_empty() {
            if stdout.is_empty() {
                format!("Plugin installation failed with status {}", output.status)
            } else {
                stdout
            }
        } else {
            stderr
        });
    }
    let message = if stdout.is_empty() {
        format!("Plugin installed from {source}")
    } else {
        stdout
    };
    Ok(PluginInstallResult {
        source: source.to_string(),
        message,
    })
}

async fn run_plugin_command(app: &AppHandle, cwd: &str, args: &[&str]) -> Result<String, String> {
    let workspace = PathBuf::from(cwd);
    if !workspace.is_dir() {
        return Err(format!("Workspace does not exist: {}", workspace.display()));
    }
    let mut command = MelodyCommandRunner::new(app).command(args, Some(&workspace))?;
    let output = command
        .output()
        .await
        .map_err(|error| format!("Failed to run Melody plugin command: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(if stderr.is_empty() {
            if stdout.is_empty() {
                format!("Plugin command failed with status {}", output.status)
            } else {
                stdout
            }
        } else {
            stderr
        });
    }
    Ok(stdout)
}

#[tauri::command]
pub async fn scan_marketplace_plugins(
    app: AppHandle,
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    refresh: bool,
) -> Result<Vec<MarketplacePlugin>, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    if refresh {
        // Refreshing the catalog only reads the configured sources and
        // updates their local index; it is a routine settings action.
        run_plugin_command(&app, &cwd, &["plugin", "marketplace", "update"]).await?;
    }
    let output =
        run_plugin_command(&app, &cwd, &["plugin", "list", "--json", "--available"]).await?;
    marketplace_plugins_from_json(&output)
}

pub(crate) fn marketplace_plugins_from_json(
    output: &str,
) -> Result<Vec<MarketplacePlugin>, String> {
    let entries = serde_json::from_str::<Vec<serde_json::Value>>(output)
        .map_err(|error| format!("Melody returned an invalid Marketplace catalog: {error}"))?;
    Ok(entries
        .into_iter()
        .filter_map(|entry| {
            let status = entry.get("status")?.as_str()?;
            let marketplace = entry.get("marketplace")?.as_str()?.to_string();
            let name = entry.get("name")?.as_str()?.to_string();
            let version = entry
                .get("version")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            match status {
                "installed" => Some(MarketplacePlugin {
                    name,
                    marketplace,
                    status: "installed".to_string(),
                    version: None,
                    installed_version: version,
                    description: None,
                    skill_count: 0,
                    has_hooks: false,
                    has_agents: false,
                    has_mcp: false,
                }),
                "available" => Some(MarketplacePlugin {
                    name,
                    marketplace,
                    status: "available".to_string(),
                    version,
                    installed_version: None,
                    description: entry
                        .get("description")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string),
                    skill_count: entry
                        .get("skill_count")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0) as usize,
                    has_hooks: entry
                        .get("has_hooks")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                    has_agents: entry
                        .get("has_agents")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                    has_mcp: entry
                        .get("has_mcp")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                }),
                _ => None,
            }
        })
        .collect())
}

#[tauri::command]
pub async fn update_melody_plugin(
    app: AppHandle,
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    name: String,
) -> Result<PluginInstallResult, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Plugin name cannot be empty".to_string());
    }
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    confirm_action(
        &app,
        "确认更新 Melody 插件",
        format!("允许在 {} 更新插件 {} 吗？", cwd, name),
    )
    .await?;
    let message = run_plugin_command(&app, &cwd, &["plugin", "update", name]).await?;
    Ok(PluginInstallResult {
        source: name.to_string(),
        message: if message.is_empty() {
            format!("Plugin {name} is already up to date")
        } else {
            message
        },
    })
}

#[tauri::command]
pub async fn list_installed_melody_plugins(
    app: AppHandle,
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
) -> Result<Vec<MelodyExtension>, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    let mut command =
        MelodyCommandRunner::new(&app).command(&["plugin", "list", "--json"], None)?;
    let output = command
        .output()
        .await
        .map_err(|error| format!("Failed to list installed Melody plugins: {error}"))?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if error.is_empty() {
            format!("Plugin listing failed with status {}", output.status)
        } else {
            error
        });
    }
    let entries: Vec<InstalledPluginEntry> = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Melody returned an invalid plugin list: {error}"))?;
    let disabled = extension_config_names("user", &cwd, "plugins", "disabled")?;
    Ok(entries
        .into_iter()
        .filter(|entry| entry.status == "installed")
        .map(|entry| {
            let enabled = !disabled.contains(&entry.name);
            MelodyExtension {
                kind: "plugins".to_string(),
                name: entry.name,
                path: entry.path.to_string_lossy().into_owned(),
                scope: "user".to_string(),
                provider: "melody".to_string(),
                managed: true,
                enabled,
                description: None,
                source: Some("plugin".to_string()),
                plugin_name: None,
                user_invocable: None,
                compatibility_status: None,
                deletable: false,
            }
        })
        .collect())
}

#[tauri::command]
pub async fn uninstall_melody_plugin(
    app: AppHandle,
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    name: String,
    keep_data: bool,
) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Plugin name cannot be empty".to_string());
    }
    let workspace = registry.authorize(&cwd)?;
    confirm_action(
        &app,
        "确认卸载 Melody 插件",
        format!(
            "允许从 {} 卸载插件 {} 吗？{}",
            workspace.display(),
            name,
            if keep_data {
                "（保留插件数据）"
            } else {
                ""
            }
        ),
    )
    .await?;
    let mut command = MelodyCommandRunner::new(&app).command(
        &["plugin", "uninstall", name, "--confirm"],
        Some(&workspace),
    )?;
    if keep_data {
        command.arg("--keep-data");
    }
    let output = command
        .output()
        .await
        .map_err(|error| format!("Failed to start Melody plugin uninstaller: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(if stderr.is_empty() {
            if stdout.is_empty() {
                format!("Plugin removal failed with status {}", output.status)
            } else {
                stdout
            }
        } else {
            stderr
        });
    }
    Ok(if stdout.is_empty() {
        format!("Plugin {name} was removed")
    } else {
        stdout
    })
}
