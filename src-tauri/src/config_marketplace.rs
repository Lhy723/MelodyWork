#[path = "config_marketplace_sources.rs"]
mod config_marketplace_sources;

pub use config_marketplace_sources::*;

use std::path::PathBuf;

use semver::Version;
use tauri::{AppHandle, State};

use crate::melody_command::MelodyCommandRunner;
use crate::workspace_access::WorkspaceRegistry;

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

struct PluginCommandOutput {
    stdout: String,
    stderr: String,
}

async fn run_plugin_command_output(
    app: &AppHandle,
    cwd: &str,
    args: &[&str],
) -> Result<PluginCommandOutput, String> {
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
    Ok(PluginCommandOutput { stdout, stderr })
}

async fn run_plugin_command(app: &AppHandle, cwd: &str, args: &[&str]) -> Result<String, String> {
    Ok(run_plugin_command_output(app, cwd, args).await?.stdout)
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
    let mut plugins = Vec::new();

    for entry in entries {
        let Some(status) = entry.get("status").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Some(marketplace) = entry.get("marketplace").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Some(name) = entry.get("name").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let marketplace = marketplace.to_string();
        let name = name.to_string();
        let version = entry
            .get("version")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let existing = plugins.iter().position(|plugin: &MarketplacePlugin| {
            plugin.name == name && plugin.marketplace == marketplace
        });

        match status {
            "installed" => {
                if let Some(index) = existing {
                    let plugin = &mut plugins[index];
                    plugin.status = "installed".to_string();
                    if version.is_some() {
                        plugin.installed_version = version;
                    }
                    plugin.update_available = is_newer_version(
                        plugin.version.as_deref(),
                        plugin.installed_version.as_deref(),
                    );
                } else {
                    plugins.push(MarketplacePlugin {
                        name,
                        marketplace,
                        status: "installed".to_string(),
                        version: None,
                        installed_version: version,
                        description: None,
                        update_available: false,
                        skill_count: 0,
                        has_hooks: false,
                        has_agents: false,
                        has_mcp: false,
                    });
                }
            }
            "available" => {
                let description = entry
                    .get("description")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string);
                let skill_count = entry
                    .get("skill_count")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0) as usize;
                let has_hooks = entry
                    .get("has_hooks")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                let has_agents = entry
                    .get("has_agents")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                let has_mcp = entry
                    .get("has_mcp")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);

                if let Some(index) = existing {
                    let plugin = &mut plugins[index];
                    if version.is_some() {
                        plugin.version = version;
                    }
                    if description.is_some() {
                        plugin.description = description;
                    }
                    plugin.skill_count = skill_count;
                    plugin.has_hooks = has_hooks;
                    plugin.has_agents = has_agents;
                    plugin.has_mcp = has_mcp;
                    plugin.update_available = plugin.status == "installed"
                        && is_newer_version(
                            plugin.version.as_deref(),
                            plugin.installed_version.as_deref(),
                        );
                } else {
                    plugins.push(MarketplacePlugin {
                        name,
                        marketplace,
                        status: "available".to_string(),
                        version,
                        installed_version: None,
                        description,
                        update_available: false,
                        skill_count,
                        has_hooks,
                        has_agents,
                        has_mcp,
                    });
                }
            }
            _ => {}
        }
    }

    Ok(plugins)
}

fn is_newer_version(latest: Option<&str>, installed: Option<&str>) -> bool {
    let Some(latest) = latest.and_then(parse_version) else {
        return false;
    };
    let Some(installed) = installed.and_then(parse_version) else {
        return false;
    };
    latest > installed
}

fn parse_version(value: &str) -> Option<Version> {
    Version::parse(value.trim().trim_start_matches(['v', 'V'])).ok()
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
    let output = run_plugin_command_output(&app, &cwd, &["plugin", "update", name]).await?;
    if output
        .stderr
        .lines()
        .any(|line| line.to_ascii_lowercase().contains("update failed:"))
    {
        return Err(output.stderr);
    }
    Ok(PluginInstallResult {
        source: name.to_string(),
        message: format_plugin_update_message(name, &output.stdout),
    })
}

pub(crate) fn format_plugin_update_message(name: &str, output: &str) -> String {
    let message = output.trim();
    let lowercase = message.to_ascii_lowercase();
    if message.is_empty() || lowercase.contains("already up to date") {
        return format!("{name} 已是最新版本。");
    }
    if lowercase.contains("updated (? -> ?)") {
        return format!("{name} 已完成同步；插件来源未提供版本号，暂时无法确认是否有版本变化。");
    }
    if lowercase.contains("updated (") {
        return format!("{name} 已更新。",);
    }
    message.to_string()
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
