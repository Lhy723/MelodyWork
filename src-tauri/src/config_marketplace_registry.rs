//! Persistent marketplace plugin registry format, path validation, and projections.
//! The registry remains a JSON value so unknown fields survive install/update operations.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde_json::{Map, Value, json};

use crate::config_io::TextFileStore;

use super::marketplace_catalog::{plugin_metadata, validate_relative_path};

const REGISTRY_MAX_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone)]
pub(super) struct InstalledPlugin {
    pub(super) repo_key: String,
    pub(super) name: String,
    pub(super) installed_version: Option<String>,
    pub(super) marketplace: Option<String>,
    pub(super) source_identity: Option<String>,
    pub(super) plugin_subdir: Option<String>,
    pub(super) plugin_path: PathBuf,
    pub(super) repo_path: PathBuf,
    pub(super) repo: Value,
}

fn read_registry(install_dir: &Path) -> Result<Value, String> {
    let path = install_dir.join("registry.json");
    let store = TextFileStore::with_limit_description(
        &path,
        REGISTRY_MAX_BYTES,
        "the 16 MB plugin registry limit",
    );
    let content = store.read_text("Plugin registry")?;
    let Some(content) = content else {
        return Ok(json!({ "version": 1, "repos": {} }));
    };
    let registry: Value = serde_json::from_str(&content)
        .map_err(|error| format!("Plugin registry contains invalid JSON: {error}"))?;
    if !registry.get("repos").is_some_and(Value::is_object) {
        return Err("Plugin registry does not contain a repos object".to_string());
    }
    Ok(registry)
}

fn save_registry(install_dir: &Path, registry: &Value) -> Result<(), String> {
    let content = serde_json::to_string_pretty(registry)
        .map_err(|error| format!("Could not encode plugin registry: {error}"))?;
    TextFileStore::with_limit_description(
        install_dir.join("registry.json"),
        REGISTRY_MAX_BYTES,
        "the 16 MB plugin registry limit",
    )
    .write_text(&content, "Plugin registry")
}

fn registry_repos(registry: &Value) -> Result<&Map<String, Value>, String> {
    registry
        .get("repos")
        .and_then(Value::as_object)
        .ok_or_else(|| "Plugin registry does not contain a repos object".to_string())
}

fn registry_repos_mut(registry: &mut Value) -> Result<&mut Map<String, Value>, String> {
    registry
        .get_mut("repos")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Plugin registry does not contain a repos object".to_string())
}

fn installed_plugins(registry: &Value, install_dir: &Path) -> Result<Vec<InstalledPlugin>, String> {
    let mut installed = Vec::new();
    for (repo_key, repo) in registry_repos(registry)? {
        let Some(repo_path) = registry_repo_path(install_dir, repo_key, repo) else {
            continue;
        };
        let Some(plugins) = repo.get("plugins").and_then(Value::as_object) else {
            continue;
        };
        let marketplace = repo.get("marketplace");
        for (name, plugin) in plugins {
            let subdir = plugin.get("subdir").and_then(Value::as_str);
            let plugin_path = match subdir {
                Some(subdir) => match safe_join_existing(&repo_path, subdir) {
                    Some(path) => path,
                    None => continue,
                },
                None => repo_path.clone(),
            };
            if !plugin_path.is_dir() {
                continue;
            }
            installed.push(InstalledPlugin {
                repo_key: repo_key.clone(),
                name: name.clone(),
                installed_version: plugin
                    .get("version")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| plugin_metadata(&plugin_path, name).version),
                marketplace: marketplace
                    .and_then(|value| value.get("source_display_name"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                source_identity: marketplace
                    .and_then(|value| value.get("source_url_or_path"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                plugin_subdir: marketplace
                    .and_then(|value| value.get("plugin_subdir"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                plugin_path,
                repo_path: repo_path.clone(),
                repo: repo.clone(),
            });
        }
    }
    installed.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then(left.repo_key.cmp(&right.repo_key))
    });
    Ok(installed)
}

fn registry_repo_path(install_dir: &Path, key: &str, repo: &Value) -> Option<PathBuf> {
    let canonical_root = install_dir.canonicalize().ok()?;
    let mut path = repo
        .get("path")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(key));
    if !path.is_absolute() {
        path = canonical_root.join(path);
    }
    let metadata = fs::symlink_metadata(&path).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return None;
    }
    let canonical_path = path.canonicalize().ok()?;
    (canonical_path.parent() == Some(canonical_root.as_path())).then_some(canonical_path)
}

fn safe_join_existing(root: &Path, relative: &str) -> Option<PathBuf> {
    let relative = validate_relative_path(relative).ok()?;
    let root = root.canonicalize().ok()?;
    let path = root.join(relative).canonicalize().ok()?;
    path.starts_with(root).then_some(path)
}

fn registry_install_record(
    kind: Value,
    target: &Path,
    plugin_name: &str,
    version: Option<&str>,
    provenance: Option<(&str, &str, &str)>,
) -> Value {
    let now = chrono::Utc::now().to_rfc3339();
    let mut plugins = Map::new();
    plugins.insert(plugin_name.to_string(), json!({ "version": version }));
    let mut repo = json!({
        "kind": kind,
        "installed_at": now,
        "updated_at": now,
        "path": target,
        "plugins": plugins
    });
    if let Some((source_identity, source_name, plugin_subdir)) = provenance {
        repo["marketplace"] = json!({
            "source_url_or_path": source_identity,
            "source_display_name": source_name,
            "plugin_subdir": plugin_subdir,
        });
    }
    repo
}

fn repo_key(name: &str, identity: &str) -> String {
    let basename = name
        .to_ascii_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let digest = sha256_hex(identity.as_bytes());
    format!(
        "{}-{}",
        if basename.is_empty() {
            "plugin"
        } else {
            &basename
        },
        &digest[..8]
    )
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn valid_repo_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 160
        && key
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

pub(super) struct RegistryInstallRollback {
    key: String,
    old_record: Option<Value>,
}

pub(super) struct MarketplaceRegistry {
    install_dir: PathBuf,
    document: Value,
}

pub(super) enum MarketplaceRegistryRemoval {
    SharedSubpath {
        repo_path: PathBuf,
        relative: String,
    },
    Repository {
        repo_path: PathBuf,
    },
}

impl MarketplaceRegistry {
    pub(super) fn load(install_dir: &Path) -> Result<Self, String> {
        Ok(Self {
            install_dir: install_dir.to_path_buf(),
            document: read_registry(install_dir)?,
        })
    }

    pub(super) fn installed_plugins(&self) -> Result<Vec<InstalledPlugin>, String> {
        installed_plugins(&self.document, &self.install_dir)
    }

    pub(super) fn save(&self) -> Result<(), String> {
        save_registry(&self.install_dir, &self.document)
    }

    pub(super) fn has_marketplace_install(
        &self,
        identity: &str,
        marketplace: &str,
        plugin_subdir: &str,
    ) -> Result<bool, String> {
        Ok(self.installed_plugins()?.iter().any(|plugin| {
            plugin
                .source_identity
                .as_deref()
                .is_some_and(|existing| same_source(existing, identity))
                && plugin.marketplace.as_deref() == Some(marketplace)
                && plugin.plugin_subdir.as_deref() == Some(plugin_subdir)
        }))
    }

    pub(super) fn find_plugin(
        &self,
        name: &str,
        marketplace: Option<&str>,
    ) -> Result<InstalledPlugin, String> {
        let installed = self.installed_plugins()?;
        let mut matches = installed.into_iter().filter(|plugin| {
            plugin.name.eq_ignore_ascii_case(name)
                && marketplace
                    .is_none_or(|marketplace| plugin.marketplace.as_deref() == Some(marketplace))
        });
        let Some(plugin) = matches.next() else {
            return Err(format!("Installed plugin '{name}' was not found"));
        };
        if matches.next().is_some() {
            return Err(format!(
                "More than one installed plugin is named '{name}'; specify its Marketplace"
            ));
        }
        Ok(plugin)
    }

    pub(super) fn prepare_install(&self, key: &str) -> Result<RegistryInstallRollback, String> {
        if !valid_repo_key(key) {
            return Err("Plugin installation key is invalid".to_string());
        }
        let old_record = registry_repos(&self.document)?.get(key).cloned();
        Ok(RegistryInstallRollback {
            key: key.to_string(),
            old_record,
        })
    }

    pub(super) fn record_install(
        &mut self,
        key: &str,
        target: &Path,
        plugin_name: &str,
        version: Option<&str>,
        kind: Value,
        provenance: Option<(&str, &str, &str)>,
    ) -> Result<(), String> {
        if !valid_repo_key(key) {
            return Err("Plugin installation key is invalid".to_string());
        }
        let record = registry_install_record(kind, target, plugin_name, version, provenance);
        registry_repos_mut(&mut self.document)?.insert(key.to_string(), record);
        Ok(())
    }

    pub(super) fn rollback_install(&mut self, rollback: RegistryInstallRollback) {
        if let Ok(repos) = registry_repos_mut(&mut self.document) {
            if let Some(old_record) = rollback.old_record {
                repos.insert(rollback.key, old_record);
            } else {
                repos.remove(&rollback.key);
            }
        }
    }

    pub(super) fn remove_plugin(
        &mut self,
        plugin: &InstalledPlugin,
    ) -> Result<MarketplaceRegistryRemoval, String> {
        let repos = registry_repos_mut(&mut self.document)?;
        let repo = repos
            .get_mut(&plugin.repo_key)
            .ok_or_else(|| "Installed plugin registry entry disappeared".to_string())?;
        let plugins = repo
            .get_mut("plugins")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| "Installed plugin registry entry is invalid".to_string())?;

        if plugins.len() > 1 {
            let relative = plugins
                .get(&plugin.name)
                .and_then(|entry| entry.get("subdir"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    "This shared installation cannot safely remove one plugin".to_string()
                })?
                .to_string();
            plugins.remove(&plugin.name);
            Ok(MarketplaceRegistryRemoval::SharedSubpath {
                repo_path: plugin.repo_path.clone(),
                relative,
            })
        } else {
            repos.remove(&plugin.repo_key);
            Ok(MarketplaceRegistryRemoval::Repository {
                repo_path: plugin.repo_path.clone(),
            })
        }
    }
}

pub(super) fn plugin_install_key(name: &str, identity: &str) -> String {
    repo_key(name, identity)
}

pub(super) fn resolve_existing_plugin_directory(root: &Path, relative: &str) -> Option<PathBuf> {
    safe_join_existing(root, relative)
}

pub(super) fn same_source(left: &str, right: &str) -> bool {
    let normalize = |value: &str| {
        value
            .trim()
            .trim_end_matches('/')
            .trim_end_matches(".git")
            .to_ascii_lowercase()
    };
    normalize(left) == normalize(right)
}
