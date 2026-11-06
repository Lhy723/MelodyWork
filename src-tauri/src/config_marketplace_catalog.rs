//! Marketplace package discovery and bounded manifest projection.
//!
//! This module owns marketplace index parsing, plugin metadata discovery, and
//! source-relative path validation. Installation and registry mutation remain
//! in the command-facing marketplace owner.

use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use serde_json::Value;

use super::MarketplacePlugin;

const MAX_MARKETPLACE_INDEX_BYTES: u64 = 2 * 1024 * 1024;
const MAX_PLUGIN_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_SCAN_ENTRIES: usize = 4096;

#[derive(Clone)]
pub(super) struct RemotePluginSource {
    pub(super) url: String,
    pub(super) git_ref: Option<String>,
    pub(super) git_sha: Option<String>,
    pub(super) subdir: Option<String>,
}

#[derive(Clone)]
pub(super) struct PluginCandidate {
    pub(super) plugin: MarketplacePlugin,
    pub(super) relative_path: String,
    pub(super) local_path: Option<PathBuf>,
    pub(super) remote: Option<RemotePluginSource>,
}

pub(super) struct PluginMetadata {
    pub(super) name: String,
    pub(super) version: Option<String>,
    pub(super) description: Option<String>,
    pub(super) skill_count: usize,
    pub(super) has_hooks: bool,
    pub(super) has_agents: bool,
    pub(super) has_mcp: bool,
}

pub(super) fn validate_relative_path(value: &str) -> Result<PathBuf, String> {
    let normalized = value.replace('\\', "/");
    let normalized = normalized.strip_prefix("./").unwrap_or(&normalized);
    if normalized.is_empty() || normalized.starts_with('/') || normalized.contains(':') {
        return Err("Plugin path must be a non-empty relative path".to_string());
    }
    let mut path = PathBuf::new();
    for component in Path::new(normalized).components() {
        match component {
            Component::Normal(part) => path.push(part),
            _ => return Err("Plugin path must not escape its source directory".to_string()),
        }
    }
    if path.as_os_str().is_empty() {
        return Err("Plugin path must be a non-empty relative path".to_string());
    }
    Ok(path)
}

fn resolve_beneath(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = validate_relative_path(relative)?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Could not read source directory: {error}"))?;
    let candidate = canonical_root.join(relative);
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("Plugin source path is unavailable: {error}"))?;
    if !canonical.starts_with(&canonical_root) || !canonical.is_dir() {
        return Err("Plugin source path escapes the marketplace or is not a directory".to_string());
    }
    Ok(canonical)
}

fn read_json_file(path: &Path, limit: u64) -> Option<Value> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_file() || metadata.len() > limit {
        return None;
    }
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn marketplace_index(root: &Path) -> Option<Value> {
    for path in [
        root.join(".melody-plugin/marketplace.json"),
        root.join(".melody-plugin/plugin.json"),
        root.join(".claude-plugin/marketplace.json"),
        root.join(".claude-plugin/plugin.json"),
    ] {
        if path.exists() {
            return read_json_file(&path, MAX_MARKETPLACE_INDEX_BYTES);
        }
    }
    None
}

pub(super) fn manifest_value(root: &Path) -> Option<Value> {
    for path in [
        root.join("plugin.json"),
        root.join(".melody-plugin/plugin.json"),
        root.join(".claude-plugin/plugin.json"),
    ] {
        if path.exists() {
            return read_json_file(&path, MAX_PLUGIN_MANIFEST_BYTES);
        }
    }
    None
}

fn safe_manifest_path(root: &Path, value: &str) -> Option<PathBuf> {
    let relative = validate_relative_path(value).ok()?;
    let root = root.canonicalize().ok()?;
    let candidate = root.join(relative);
    let canonical = candidate.canonicalize().ok()?;
    canonical.starts_with(&root).then_some(canonical)
}

fn manifest_paths(
    root: &Path,
    manifest: Option<&Value>,
    field: &str,
    fallback: &str,
) -> Vec<PathBuf> {
    let Some(value) = manifest.and_then(|manifest| manifest.get(field)) else {
        return safe_manifest_path(root, fallback)
            .filter(|path| path.is_dir())
            .into_iter()
            .collect();
    };
    let values = match value {
        Value::String(value) => vec![value.as_str()],
        Value::Array(values) => values.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    };
    values
        .into_iter()
        .filter_map(|value| safe_manifest_path(root, value))
        .filter(|path| path.is_dir())
        .collect()
}

fn bounded_skill_count(roots: &[PathBuf]) -> usize {
    let mut stack = roots
        .iter()
        .map(|root| (root.clone(), 0usize))
        .collect::<Vec<_>>();
    let mut count = 0;
    let mut visited = 0;
    while let Some((directory, depth)) = stack.pop() {
        if depth > 8 || visited >= MAX_SCAN_ENTRIES {
            continue;
        }
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited >= MAX_SCAN_ENTRIES {
                return count;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_dir() {
                if path.join("SKILL.md").is_file() {
                    count += 1;
                } else {
                    stack.push((path, depth + 1));
                }
            }
        }
    }
    count
}

fn directory_has_entries(path: &Path) -> bool {
    fs::read_dir(path)
        .ok()
        .is_some_and(|mut entries| entries.next().is_some())
}

fn manifest_component_exists(
    root: &Path,
    manifest: Option<&Value>,
    field: &str,
    fallback: &str,
) -> bool {
    let Some(value) = manifest.and_then(|manifest| manifest.get(field)) else {
        return safe_manifest_path(root, fallback)
            .is_some_and(|path| path.is_file() || path.is_dir());
    };
    if value.is_object() || value.is_array() {
        return !value.is_null();
    }
    value
        .as_str()
        .and_then(|value| safe_manifest_path(root, value))
        .is_some_and(|path| path.is_file() || path.is_dir())
}

pub(super) fn plugin_metadata(root: &Path, fallback_name: &str) -> PluginMetadata {
    let manifest = manifest_value(root);
    let name = manifest
        .as_ref()
        .and_then(|manifest| manifest.get("name"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback_name)
        .to_string();
    let version = manifest
        .as_ref()
        .and_then(|manifest| manifest.get("version"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let description = manifest
        .as_ref()
        .and_then(|manifest| manifest.get("description"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let skill_roots = manifest_paths(root, manifest.as_ref(), "skills", "skills");
    let agent_roots = manifest_paths(root, manifest.as_ref(), "agents", "agents");
    let skill_count = bounded_skill_count(&skill_roots);
    let has_hooks = manifest_component_exists(root, manifest.as_ref(), "hooks", "hooks/hooks.json");
    let has_agents = agent_roots.iter().any(|path| directory_has_entries(path));
    let has_mcp = manifest_component_exists(root, manifest.as_ref(), "mcpServers", ".mcp.json");
    PluginMetadata {
        name,
        version,
        description,
        skill_count,
        has_hooks,
        has_agents,
        has_mcp,
    }
}

fn candidate_from_local(
    marketplace: &str,
    root: &Path,
    relative_path: &str,
    fallback_name: &str,
    version: Option<String>,
    description: Option<String>,
) -> Option<PluginCandidate> {
    let local_path = resolve_beneath(root, relative_path).ok()?;
    let metadata = plugin_metadata(&local_path, fallback_name);
    Some(PluginCandidate {
        plugin: MarketplacePlugin {
            name: metadata.name,
            marketplace: marketplace.to_string(),
            status: "available".to_string(),
            version: metadata.version.or(version),
            installed_version: None,
            description: metadata.description.or(description),
            update_available: false,
            skill_count: metadata.skill_count,
            has_hooks: metadata.has_hooks,
            has_agents: metadata.has_agents,
            has_mcp: metadata.has_mcp,
        },
        relative_path: validate_relative_path(relative_path)
            .ok()?
            .to_string_lossy()
            .replace('\\', "/"),
        local_path: Some(local_path),
        remote: None,
    })
}

pub(super) fn scan_marketplace(root: &Path, marketplace: &str) -> Vec<PluginCandidate> {
    let mut candidates = Vec::new();
    if let Some(index) = marketplace_index(root)
        && let Some(entries) = index.get("plugins").and_then(Value::as_array)
    {
        for entry in entries {
            let Some(name) = entry.get("name").and_then(Value::as_str) else {
                continue;
            };
            let version = entry
                .get("version")
                .and_then(Value::as_str)
                .map(str::to_string);
            let description = entry
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string);
            let source = entry.get("source");
            let remote = source.and_then(|source| {
                let object = source.as_object()?;
                let url = object.get("url")?.as_str()?.to_string();
                Some(RemotePluginSource {
                    url,
                    git_ref: object
                        .get("ref")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    git_sha: object
                        .get("sha")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    subdir: object
                        .get("path")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                })
            });
            if let Some(remote) = remote {
                candidates.push(PluginCandidate {
                    plugin: MarketplacePlugin {
                        name: name.to_string(),
                        marketplace: marketplace.to_string(),
                        status: "available".to_string(),
                        version,
                        installed_version: None,
                        description,
                        update_available: false,
                        skill_count: 0,
                        has_hooks: false,
                        has_agents: false,
                        has_mcp: false,
                    },
                    relative_path: name.to_string(),
                    local_path: None,
                    remote: Some(remote),
                });
                continue;
            }
            let relative_path = source
                .and_then(|source| {
                    source
                        .as_str()
                        .or_else(|| source.get("path").and_then(Value::as_str))
                })
                .unwrap_or_else(|| "");
            let relative_path = if relative_path.is_empty() {
                format!("plugins/{name}")
            } else {
                relative_path.to_string()
            };
            if let Some(candidate) = candidate_from_local(
                marketplace,
                root,
                &relative_path,
                name,
                version,
                description,
            ) {
                candidates.push(candidate);
            }
        }
        return candidates;
    }

    let plugins_root = root.join("plugins");
    let Ok(entries) = fs::read_dir(&plugins_root) else {
        return candidates;
    };
    let mut entries = entries.flatten().collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if !kind.is_dir() || kind.is_symlink() {
            continue;
        }
        let fallback_name = entry.file_name().to_string_lossy().into_owned();
        let relative = format!("plugins/{fallback_name}");
        if let Some(candidate) =
            candidate_from_local(marketplace, root, &relative, &fallback_name, None, None)
        {
            candidates.push(candidate);
        }
    }
    candidates
}
