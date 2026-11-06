use std::{
    collections::BTreeMap,
    env,
    path::{Path, PathBuf},
};

use crate::workspace_access::WorkspaceRegistry;
use semver::Version;
use serde_json::{Value, json};
use tauri::State;

#[path = "config_marketplace_install_transaction.rs"]
mod install_transaction;
#[path = "config_marketplace_catalog.rs"]
mod marketplace_catalog;
#[path = "config_marketplace_filesystem.rs"]
mod marketplace_filesystem;
#[path = "config_marketplace_registry.rs"]
mod marketplace_registry;
#[path = "config_marketplace_transport.rs"]
mod marketplace_transport;
#[path = "config_marketplace_plugin_source.rs"]
mod plugin_source;

use self::install_transaction::{
    InstallSnapshotRequest, MarketplaceInstallProvenance, install_snapshot,
};
use self::marketplace_catalog::{PluginCandidate, plugin_metadata, scan_marketplace};
use self::marketplace_filesystem::{
    CleanupDirectory, remove_managed_path, remove_managed_subpath, remove_plugin_data,
};
use self::marketplace_registry::{
    InstalledPlugin, MarketplaceRegistry, MarketplaceRegistryRemoval, plugin_install_key,
    resolve_existing_plugin_directory, same_source,
};
use self::marketplace_transport::{
    clone_repository, source_identity, sync_marketplace_source, validate_git_sha,
};
use self::plugin_source::{
    DirectPluginSource, detect_plugin_directory, parse_direct_source,
    resolve_direct_git_plugin_path,
};

use super::{
    super::config_extensions::PluginEnablement,
    config_marketplace_sources::{marketplace_sources, read_user_config_document},
};

use crate::config_core::{
    MarketplacePlugin, MarketplaceSource, MelodyExtension, PluginInstallResult, melody_home,
    user_home,
};

fn resolve_install_dir(cwd: &str) -> Result<PathBuf, String> {
    let (_, document) = read_user_config_document()?;
    if let Some(value) = document
        .get("plugins")
        .and_then(|item| item.as_table())
        .and_then(|table| table.get("install_dir"))
        .and_then(|item| item.as_str())
    {
        let value = value.trim();
        if value.is_empty() {
            return Err("[plugins].install_dir cannot be empty".to_string());
        }
        let path = expand_path(value, Path::new(cwd))?;
        return Ok(path);
    }
    Ok(melody_home()?.join("installed-plugins"))
}

fn expand_path(value: &str, relative_to: &Path) -> Result<PathBuf, String> {
    if let Some(relative) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        return Ok(user_home()?.join(relative));
    }
    let path = PathBuf::from(value);
    Ok(if path.is_absolute() {
        path
    } else {
        relative_to.join(path)
    })
}

fn canonical_identity(source: &MarketplaceSource, cwd: &Path) -> Result<String, String> {
    source_identity(source, cwd)
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
pub async fn scan_marketplace_plugins(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    refresh: bool,
) -> Result<Vec<MarketplacePlugin>, String> {
    let cwd = registry.authorize(&cwd)?;
    let (_, document) = read_user_config_document()?;
    let sources = marketplace_sources(&document)?;
    let install_dir = resolve_install_dir(&cwd.to_string_lossy())?;
    let installed_registry = MarketplaceRegistry::load(&install_dir)?;
    let installed = installed_registry.installed_plugins()?;
    let mut plugins: BTreeMap<(String, String), MarketplacePlugin> = BTreeMap::new();
    let mut source_error = None;

    for source in &sources {
        let identity = canonical_identity(source, &cwd)?;
        let root = match sync_marketplace_source(source, &cwd, refresh).await {
            Ok(root) => root,
            Err(error) => {
                source_error.get_or_insert_with(|| format!("{}: {error}", source.name));
                continue;
            }
        };
        for candidate in scan_marketplace(&root, &source.name) {
            let current = installed.iter().find(|entry| {
                entry.marketplace.as_deref() == Some(source.name.as_str())
                    && entry
                        .source_identity
                        .as_deref()
                        .is_some_and(|existing| same_source(existing, &identity))
                    && entry.plugin_subdir.as_deref() == Some(candidate.relative_path.as_str())
            });
            let mut plugin = candidate.plugin;
            if let Some(current) = current {
                plugin.status = "installed".to_string();
                plugin.installed_version = current.installed_version.clone();
                plugin.update_available = is_newer_version(
                    plugin.version.as_deref(),
                    plugin.installed_version.as_deref(),
                );
            }
            plugins.insert((plugin.marketplace.clone(), plugin.name.clone()), plugin);
        }
    }

    for installed in installed
        .into_iter()
        .filter(|entry| entry.marketplace.is_some())
    {
        let marketplace = installed.marketplace.unwrap_or_default();
        let key = (marketplace.clone(), installed.name.clone());
        plugins.entry(key).or_insert_with(|| {
            let metadata = plugin_metadata(&installed.plugin_path, &installed.name);
            MarketplacePlugin {
                name: metadata.name,
                marketplace,
                status: "installed".to_string(),
                version: None,
                installed_version: installed.installed_version.or(metadata.version),
                description: metadata.description,
                update_available: false,
                skill_count: metadata.skill_count,
                has_hooks: metadata.has_hooks,
                has_agents: metadata.has_agents,
                has_mcp: metadata.has_mcp,
            }
        });
    }

    if plugins.is_empty() && !sources.is_empty() {
        if let Some(error) = source_error {
            return Err(error);
        }
    }
    Ok(plugins.into_values().collect())
}

#[tauri::command]
pub fn list_installed_melody_plugins(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
) -> Result<Vec<MelodyExtension>, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    let install_dir = resolve_install_dir(&cwd)?;
    let registry = MarketplaceRegistry::load(&install_dir)?;
    let enablement = PluginEnablement::for_workspace(&cwd)?;
    let mut extensions = registry
        .installed_plugins()?
        .into_iter()
        .map(|plugin| MelodyExtension {
            kind: "plugins".to_string(),
            name: plugin.name.clone(),
            path: plugin.plugin_path.to_string_lossy().into_owned(),
            scope: "user".to_string(),
            provider: "melody".to_string(),
            managed: true,
            enabled: enablement.is_enabled("user", &plugin.plugin_path, &plugin.name),
            description: plugin_metadata(&plugin.plugin_path, &plugin.name).description,
            source: Some("plugin".to_string()),
            plugin_name: None,
            user_invocable: None,
            compatibility_status: None,
            deletable: false,
        })
        .collect::<Vec<_>>();
    extensions.sort_by(|left, right| left.name.cmp(&right.name).then(left.path.cmp(&right.path)));
    Ok(extensions)
}

fn require_sha_enabled() -> Result<bool, String> {
    let env_enabled = env::var_os("MELODY_MARKETPLACE_REQUIRE_SHA").is_some_and(|value| {
        matches!(
            value.to_string_lossy().trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    });
    let (_, document) = read_user_config_document()?;
    Ok(env_enabled
        || document
            .get("marketplace")
            .and_then(|item| item.as_table())
            .and_then(|table| table.get("require_sha"))
            .and_then(|item| item.as_bool())
            .unwrap_or(false))
}

fn resolve_marketplace_source<'a>(
    sources: &'a [MarketplaceSource],
    qualifier: &str,
    cwd: &Path,
) -> Result<&'a MarketplaceSource, String> {
    let matches = sources
        .iter()
        .filter(|source| {
            source.name == qualifier
                || source_identity(source, cwd)
                    .ok()
                    .is_some_and(|identity| same_source(&identity, qualifier))
        })
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [source] => Ok(source),
        [] => Err(format!(
            "Marketplace source '{qualifier}' is not configured"
        )),
        _ => Err(format!("Marketplace source '{qualifier}' is ambiguous")),
    }
}

fn parse_marketplace_reference(input: &str) -> Option<(&str, &str)> {
    if input.contains("://")
        || input.starts_with("git@")
        || input.starts_with('/')
        || input.starts_with('\\')
        || input.starts_with('.')
        || input.starts_with('~')
        || input.contains('#')
    {
        return None;
    }
    let (name, qualifier) = input.split_once('@')?;
    if name.trim().is_empty() || qualifier.trim().is_empty() || name.contains('/') {
        return None;
    }
    Some((name.trim(), qualifier.trim()))
}

async fn install_marketplace_candidate(
    candidate: &PluginCandidate,
    source: &MarketplaceSource,
    identity: &str,
    install_dir: &Path,
    replace: bool,
    existing_key: Option<&str>,
) -> Result<String, String> {
    let key = plugin_install_key(
        &candidate.plugin.name,
        &format!("{identity}#{}", candidate.relative_path),
    );
    let key = existing_key.unwrap_or(&key);
    let temp_root = CleanupDirectory::create("melody-plugin")?;
    let (plugin_root, kind) = if let Some(remote) = &candidate.remote {
        if require_sha_enabled()?
            && remote
                .git_sha
                .as_deref()
                .and_then(|sha| validate_git_sha(sha).ok())
                .is_none()
        {
            return Err(format!(
                "Remote plugin '{}' has no pinned full commit SHA; Marketplace require_sha is enabled",
                candidate.plugin.name
            ));
        }
        let clone_root = temp_root.path().join("repo");
        let commit = clone_repository(
            &remote.url,
            remote.git_ref.as_deref(),
            remote.git_sha.as_deref(),
            &clone_root,
        )
        .await?;
        let plugin_root = match remote.subdir.as_deref() {
            Some(subdir) => resolve_existing_plugin_directory(&clone_root, subdir)
                .ok_or_else(|| "Remote plugin subdirectory is invalid".to_string())?,
            None => clone_root.clone(),
        };
        (
            plugin_root,
            json!({
                "type": "Git",
                "url": remote.url,
                "git_ref": remote.git_sha.as_deref().or(remote.git_ref.as_deref()),
                "commit": commit,
                "subdir": remote.subdir,
            }),
        )
    } else {
        let path = candidate
            .local_path
            .clone()
            .ok_or_else(|| "Marketplace plugin source is missing".to_string())?;
        (
            path.clone(),
            json!({ "type": "Local", "source_path": path }),
        )
    };
    let metadata = plugin_metadata(&plugin_root, &candidate.plugin.name);
    let version = metadata
        .version
        .or_else(|| candidate.plugin.version.clone());
    let installed = install_snapshot(InstallSnapshotRequest {
        install_dir,
        key: &key,
        source_root: &plugin_root,
        plugin_name: &metadata.name,
        version: version.as_deref(),
        kind,
        provenance: Some(MarketplaceInstallProvenance {
            source_identity: identity,
            source_name: &source.name,
            plugin_subdir: &candidate.relative_path,
        }),
        replace,
    });
    installed?;
    Ok(metadata.name)
}

#[tauri::command]
pub async fn install_melody_plugin(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    source: String,
) -> Result<PluginInstallResult, String> {
    let cwd = registry.authorize(&cwd)?;
    let install_dir = resolve_install_dir(&cwd.to_string_lossy())?;
    let source = source.trim();
    if source.is_empty() || source.len() > 4096 {
        return Err("Plugin source is empty or too long".to_string());
    }

    if let Some((plugin_name, qualifier)) = parse_marketplace_reference(source) {
        let (_, document) = read_user_config_document()?;
        let sources = marketplace_sources(&document)?;
        let marketplace = resolve_marketplace_source(&sources, qualifier, &cwd)?;
        let identity = source_identity(marketplace, &cwd)?;
        let root = sync_marketplace_source(marketplace, &cwd, false).await?;
        let matches = scan_marketplace(&root, &marketplace.name)
            .into_iter()
            .filter(|candidate| candidate.plugin.name.eq_ignore_ascii_case(plugin_name))
            .collect::<Vec<_>>();
        let candidate = match matches.as_slice() {
            [candidate] => candidate,
            [] => {
                return Err(format!(
                    "Plugin '{plugin_name}' was not found in '{qualifier}'"
                ));
            }
            _ => {
                return Err(format!(
                    "Plugin '{plugin_name}' is ambiguous in '{qualifier}'"
                ));
            }
        };
        if MarketplaceRegistry::load(&install_dir)?.has_marketplace_install(
            &identity,
            &marketplace.name,
            &candidate.relative_path,
        )? {
            return Ok(PluginInstallResult {
                source: source.to_string(),
                message: format!("{} 已安装。", candidate.plugin.name),
            });
        }
        let name = install_marketplace_candidate(
            candidate,
            marketplace,
            &identity,
            &install_dir,
            false,
            None,
        )
        .await?;
        return Ok(PluginInstallResult {
            source: source.to_string(),
            message: format!("已安装插件 {name}。"),
        });
    }

    let direct = parse_direct_source(source, &cwd)?;
    let temp_root = CleanupDirectory::create("melody-plugin-source")?;
    let result = match direct {
        DirectPluginSource::Local { path } => {
            let (plugin_path, name, version) = detect_plugin_directory(&path)?;
            let identity = format!("local:{}", plugin_path.display());
            let key = plugin_install_key(&name, &identity);
            let kind = json!({ "type": "Local", "source_path": plugin_path });
            install_snapshot(InstallSnapshotRequest {
                install_dir: &install_dir,
                key: &key,
                source_root: &plugin_path,
                plugin_name: &name,
                version: version.as_deref(),
                kind,
                provenance: None,
                replace: false,
            })?;
            name
        }
        DirectPluginSource::Git {
            url,
            git_ref,
            git_sha,
            subdir,
        } => {
            if require_sha_enabled()? && git_sha.is_none() {
                return Err("Remote plugin installs require a full commit SHA while Marketplace require_sha is enabled".to_string());
            }
            let clone_root = temp_root.path().join("repo");
            let commit =
                clone_repository(&url, git_ref.as_deref(), git_sha.as_deref(), &clone_root).await?;
            let (plugin_path, resolved_subdir) =
                resolve_direct_git_plugin_path(&clone_root, subdir.as_deref())?;
            let metadata = plugin_metadata(&plugin_path, "plugin");
            let identity = format!("{url}#{}", subdir.as_deref().unwrap_or("."));
            let key = plugin_install_key(&metadata.name, &identity);
            let kind = json!({
                "type": "Git",
                "url": url,
                "git_ref": git_sha.as_deref().or(git_ref.as_deref()),
                "commit": commit,
                "subdir": resolved_subdir,
            });
            install_snapshot(InstallSnapshotRequest {
                install_dir: &install_dir,
                key: &key,
                source_root: &plugin_path,
                plugin_name: &metadata.name,
                version: metadata.version.as_deref(),
                kind,
                provenance: None,
                replace: false,
            })?;
            metadata.name
        }
    };
    Ok(PluginInstallResult {
        source: source.to_string(),
        message: format!("已安装插件 {result}。"),
    })
}

fn plugin_reference(value: &str) -> (&str, Option<&str>) {
    value
        .split_once('@')
        .map_or((value, None), |(name, marketplace)| {
            (name, Some(marketplace))
        })
}

async fn update_installed_plugin(
    workspace: &Path,
    install_dir: &Path,
    installed: &InstalledPlugin,
) -> Result<String, String> {
    let old_version = installed.installed_version.clone();
    if let Some(stored_identity) = installed.source_identity.as_deref() {
        let (_, document) = read_user_config_document()?;
        let sources = marketplace_sources(&document)?;
        let matching_sources = sources
            .iter()
            .filter(|source| {
                source_identity(source, workspace)
                    .ok()
                    .is_some_and(|identity| same_source(&identity, stored_identity))
            })
            .collect::<Vec<_>>();
        let name_matches = installed
            .marketplace
            .as_deref()
            .map(|name| {
                matching_sources
                    .iter()
                    .copied()
                    .filter(|source| source.name == name)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let source = match name_matches.as_slice() {
            [source] => *source,
            [] => match matching_sources.as_slice() {
                [source] => *source,
                [] => {
                    return Err(
                        "The plugin's Marketplace source is no longer configured".to_string()
                    );
                }
                _ => {
                    return Err(
                        "The plugin's Marketplace source is ambiguous; keep its original source name or remove duplicate URLs".to_string(),
                    );
                }
            },
            _ => {
                return Err(
                    "The plugin's Marketplace source name is duplicated in configuration"
                        .to_string(),
                );
            }
        };
        let identity = source_identity(source, workspace)?;
        let root = sync_marketplace_source(source, workspace, true).await?;
        let plugin_subdir = installed
            .plugin_subdir
            .as_deref()
            .ok_or_else(|| "Installed Marketplace plugin has no source path".to_string())?;
        let candidate = scan_marketplace(&root, &source.name)
            .into_iter()
            .find(|candidate| candidate.relative_path == plugin_subdir)
            .ok_or_else(|| {
                format!(
                    "Plugin '{}' is no longer listed in its Marketplace",
                    installed.name
                )
            })?;
        install_marketplace_candidate(
            &candidate,
            source,
            &identity,
            install_dir,
            true,
            Some(&installed.repo_key),
        )
        .await?;
    } else {
        let kind = installed
            .repo
            .get("kind")
            .ok_or_else(|| "Installed plugin source metadata is missing".to_string())?;
        let type_name = kind.get("type").and_then(Value::as_str).unwrap_or_default();
        let plugin_subdir = kind.get("subdir").and_then(Value::as_str);
        let (source_root, updated_kind) = match type_name {
            "Git" => {
                let url = kind
                    .get("url")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "Installed Git plugin has no source URL".to_string())?;
                let git_ref = kind.get("git_ref").and_then(Value::as_str);
                let git_sha = git_ref.filter(|reference| validate_git_sha(reference).is_ok());
                if require_sha_enabled()? && git_sha.is_none() {
                    return Err("Remote plugin updates require a full commit SHA while Marketplace require_sha is enabled".to_string());
                }
                let temp_root = CleanupDirectory::create("melody-plugin-update")?;
                let clone_root = temp_root.path().join("repo");
                let commit = clone_repository(
                    url,
                    git_ref.filter(|_| git_sha.is_none()),
                    git_sha,
                    &clone_root,
                )
                .await?;
                let plugin_path = match plugin_subdir {
                    Some(subdir) => resolve_existing_plugin_directory(&clone_root, subdir)
                        .ok_or_else(|| "Installed plugin subdirectory is invalid".to_string())?,
                    None => clone_root.clone(),
                };
                let updated_kind = json!({
                    "type": "Git",
                    "url": url,
                    "git_ref": git_sha.or(git_ref),
                    "commit": commit,
                    "subdir": plugin_subdir,
                });
                let version = plugin_metadata(&plugin_path, &installed.name).version;
                let result = install_snapshot(InstallSnapshotRequest {
                    install_dir,
                    key: &installed.repo_key,
                    source_root: &plugin_path,
                    plugin_name: &installed.name,
                    version: version.as_deref(),
                    kind: updated_kind,
                    provenance: None,
                    replace: true,
                });
                result?;
                return Ok(update_message(
                    &installed.name,
                    old_version.as_deref(),
                    installed.plugin_path.as_path(),
                ));
            }
            "Local" => {
                let path = kind
                    .get("source_path")
                    .and_then(Value::as_str)
                    .map(PathBuf::from)
                    .ok_or_else(|| "Installed local plugin has no source path".to_string())?;
                let path = match plugin_subdir {
                    Some(subdir) => resolve_existing_plugin_directory(&path, subdir)
                        .ok_or_else(|| "Installed plugin subdirectory is invalid".to_string())?,
                    None => path,
                };
                let kind = json!({ "type": "Local", "source_path": path });
                (path, kind)
            }
            _ => return Err("Installed plugin source type is unsupported".to_string()),
        };
        let metadata = plugin_metadata(&source_root, &installed.name);
        install_snapshot(InstallSnapshotRequest {
            install_dir,
            key: &installed.repo_key,
            source_root: &source_root,
            plugin_name: &metadata.name,
            version: metadata.version.as_deref(),
            kind: updated_kind,
            provenance: None,
            replace: true,
        })?;
    }
    Ok(update_message(
        &installed.name,
        old_version.as_deref(),
        &installed.plugin_path,
    ))
}

fn update_message(name: &str, old_version: Option<&str>, path: &Path) -> String {
    let new_version = plugin_metadata(path, name).version;
    match (old_version, new_version.as_deref()) {
        (Some(old), Some(new)) if old.trim() == new.trim() => {
            format!("{name} 已是最新版本。")
        }
        (Some(old), Some(new))
            if parse_version(old)
                .zip(parse_version(new))
                .is_some_and(|(old, new)| old == new) =>
        {
            format!("{name} 已是最新版本。")
        }
        (Some(_), Some(_)) => format!("{name} 已更新。"),
        _ => format!("{name} 已完成同步；插件来源未提供版本号，暂时无法确认是否有版本变化。"),
    }
}

#[tauri::command]
pub async fn update_melody_plugin(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    name: String,
) -> Result<PluginInstallResult, String> {
    let workspace = registry.authorize(&cwd)?;
    let name = name.trim();
    if name.is_empty() {
        return Err("Plugin name cannot be empty".to_string());
    }
    let (plugin_name, marketplace) = plugin_reference(name);
    let install_dir = resolve_install_dir(&workspace.to_string_lossy())?;
    let registry = MarketplaceRegistry::load(&install_dir)?;
    let plugin = registry.find_plugin(plugin_name, marketplace)?;
    let message = update_installed_plugin(&workspace, &install_dir, &plugin).await?;
    Ok(PluginInstallResult {
        source: name.to_string(),
        message,
    })
}

#[tauri::command]
pub fn uninstall_melody_plugin(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    name: String,
    keep_data: bool,
    path: Option<String>,
) -> Result<String, String> {
    let workspace = registry.authorize(&cwd)?;
    let name = name.trim();
    if name.is_empty() {
        return Err("Plugin name cannot be empty".to_string());
    }
    let (plugin_name, marketplace) = plugin_reference(name);
    let install_dir = resolve_install_dir(&workspace.to_string_lossy())?;
    let mut registry = MarketplaceRegistry::load(&install_dir)?;
    let installed = registry.installed_plugins()?;
    let plugin = if let Some(path) = path {
        let requested_path = PathBuf::from(path)
            .canonicalize()
            .map_err(|error| format!("Installed plugin path is unavailable: {error}"))?;
        installed
            .iter()
            .find(|plugin| {
                plugin.name.eq_ignore_ascii_case(plugin_name)
                    && marketplace.is_none_or(|marketplace| {
                        plugin.marketplace.as_deref() == Some(marketplace)
                    })
                    && plugin.plugin_path.canonicalize().ok().as_ref() == Some(&requested_path)
            })
            .cloned()
            .ok_or_else(|| format!("Installed plugin '{plugin_name}' was not found at that path"))?
    } else {
        registry.find_plugin(plugin_name, marketplace)?
    };
    match registry.remove_plugin(&plugin)? {
        MarketplaceRegistryRemoval::SharedSubpath {
            repo_path,
            relative,
        } => {
            remove_managed_subpath(&repo_path, &relative)?;
        }
        MarketplaceRegistryRemoval::Repository { repo_path } => {
            remove_managed_path(&install_dir, &repo_path)?;
        }
    }
    registry.save()?;
    if !keep_data {
        remove_plugin_data(&melody_home()?.join("plugin-data"), &plugin.name)?;
    }
    Ok(format!("Plugin {} was removed", plugin.name))
}
