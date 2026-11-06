//! Host-owned plugin discovery and effective enablement.
//!
//! This module returns the single ordered capability inventory consumed by
//! Settings, Marketplace and Pi's resource projections. Plugin parsing remains
//! in `config_plugin_details`; this owner controls which sources are scanned,
//! how configured/plugin identities are activated, and how conflicts resolve.

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::super::config_plugin_details::plugin_capability_from_directory;
use super::{MAX_PI_SKILL_IGNORE_BYTES, merged_config_array};
use crate::config_core::{
    MelodyPluginCapability, melody_home, read_melody_config_inner, user_home,
};

/// Effective `[plugins]` enablement for a workspace.
///
/// Melody activates a discovered plugin only when it is listed in
/// `[plugins].enabled` and not listed in `[plugins].disabled`
/// (`melody-agent`'s plugin registry: `enabled = !is_disabled && explicitly_enabled`;
/// disabled wins on conflict). Presence on disk is *not* enablement: a
/// marketplace clone or its install cache holds every plugin the source
/// offers, and Melody deliberately leaves those inactive until the user
/// enables one.
///
/// Project config replaces the user value for a whole key, matching Melody's
/// `deep_merge_toml` array semantics, so the resolved sets apply to plugins
/// discovered from either scope.
#[derive(Debug, Default, Clone)]
pub(crate) struct PluginEnablement {
    enabled: HashSet<String>,
    disabled: HashSet<String>,
}

impl PluginEnablement {
    /// Resolve enablement from explicit config documents, lowest precedence
    /// first. Later documents win per key, and a document that omits a key
    /// keeps the previously resolved value.
    pub(crate) fn from_documents(documents: &[&Value]) -> Self {
        let mut resolved = Self::default();
        for document in documents {
            let section = document.get("plugins");
            for (key, target) in [
                ("enabled", &mut resolved.enabled),
                ("disabled", &mut resolved.disabled),
            ] {
                let Some(entries) = section
                    .and_then(|section| section.get(key))
                    .and_then(Value::as_array)
                else {
                    continue;
                };
                *target = entries
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|entry| entry.trim().to_string())
                    .filter(|entry| !entry.is_empty())
                    .collect();
            }
        }
        resolved
    }

    pub(crate) fn for_workspace(cwd: &str) -> Result<Self, String> {
        let mut documents = Vec::new();
        for scope in ["user", "project"] {
            documents.push(read_melody_config_inner(scope.to_string(), cwd.to_string())?.values);
        }
        let borrowed = documents.iter().collect::<Vec<_>>();
        Ok(Self::from_documents(&borrowed))
    }

    /// A plugin is active only when explicitly enabled and not disabled.
    /// `disabled` wins so an entry left in both lists never silently
    /// reactivates a plugin the user turned off.
    ///
    /// A plugin discovered through `[plugins].paths` is the exception: Melody
    /// adds those to the enabled list itself, because the directory only enters
    /// discovery when the user configured it, so no explicit name is required.
    pub(crate) fn is_enabled(&self, scope: &str, root: &Path, name: &str) -> bool {
        let id = plugin_identity(scope, root, name);
        let listed = |entries: &HashSet<String>| entries.contains(name) || entries.contains(&id);
        if listed(&self.disabled) {
            return false;
        }
        scope == "config" || listed(&self.enabled)
    }
}

/// Melody's stable plugin identity: `<scope>/<hex8>/<name>`, where `<hex8>` is
/// the first four bytes of the SHA-256 of the canonical plugin root.
/// `melody plugin add` records this id in `[plugins].enabled`, so both the id
/// and the plain plugin name have to resolve to the same plugin.
fn plugin_identity(scope: &str, root: &Path, name: &str) -> String {
    let canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    format!(
        "{scope}/{:02x}{:02x}{:02x}{:02x}/{name}",
        digest[0], digest[1], digest[2], digest[3]
    )
}

pub(crate) const MAX_PI_PLUGIN_ROOTS: usize = 128;
const MAX_PI_PLUGIN_SCAN_DEPTH: usize = 5;
const MAX_PI_PLUGIN_SCAN_ENTRIES: usize = 4096;
/// `[plugins].paths` entries Melody would scan.
pub(crate) const MAX_PI_PLUGIN_PATH_ENTRIES: usize = 64;

fn plugin_search_roots(cwd: &str) -> Result<Vec<(PathBuf, String)>, String> {
    let workspace = PathBuf::from(cwd);
    if !workspace.is_dir() {
        return Err(format!("Workspace does not exist: {}", workspace.display()));
    }
    let mut roots = Vec::new();
    let mut current = workspace;
    let mut found_repository_marker = false;
    loop {
        roots.push((current.join(".melody/plugins"), "project".to_string()));
        roots.push((current.join(".claude/plugins"), "project".to_string()));
        if current.join(".git").exists() {
            found_repository_marker = true;
            break;
        }
        let Some(parent) = current.parent() else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent.to_path_buf();
    }
    if !found_repository_marker {
        roots.truncate(2);
    }

    let home = user_home()?;
    let melody = melody_home()?;
    roots.extend([
        (melody.join("installed-plugins"), "user".to_string()),
        (melody.join("plugins"), "user".to_string()),
        (home.join(".claude/plugins"), "user".to_string()),
    ]);

    // `[plugins].paths` adds custom plugin directories. Melody treats plugins
    // found there as explicitly enabled (they only enter discovery because the
    // user configured the directory), so they carry the `config` scope.
    for configured in merged_config_array(cwd, "plugins", "paths")?
        .into_iter()
        .take(MAX_PI_PLUGIN_PATH_ENTRIES)
    {
        if configured.len() > MAX_PI_SKILL_IGNORE_BYTES {
            continue;
        }
        let expanded = match configured.strip_prefix("~/") {
            Some(relative) => home.join(relative),
            None => PathBuf::from(&configured),
        };
        roots.push((expanded, "config".to_string()));
    }

    // Melody allows an explicit install directory for marketplace plugins.
    // It is still a Host-owned path and is scanned with the same symlink and
    // depth bounds as the built-in roots.
    if let Ok(document) = read_melody_config_inner("user".to_string(), cwd.to_string())
        && let Some(value) = document
            .values
            .get("plugins")
            .and_then(Value::as_object)
            .and_then(|plugins| plugins.get("install_dir"))
            .and_then(Value::as_str)
    {
        let configured = value.trim();
        if !configured.is_empty() {
            let path = configured
                .strip_prefix("~/")
                .map(|relative| home.join(relative))
                .unwrap_or_else(|| PathBuf::from(configured));
            roots.push((path, "user".to_string()));
        }
    }

    let mut deduped = Vec::new();
    for (root, scope) in roots {
        if !root.exists() {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(&root) else {
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let Ok(canonical) = root.canonicalize() else {
            continue;
        };
        if deduped
            .iter()
            .any(|(existing, existing_scope): &(PathBuf, String)| {
                existing == &canonical && existing_scope == &scope
            })
        {
            continue;
        }
        deduped.push((canonical, scope));
    }
    Ok(deduped)
}

fn scan_plugin_tree(
    root: &Path,
    scope: &str,
    enablement: &PluginEnablement,
    plugins: &mut Vec<MelodyPluginCapability>,
    seen: &mut HashSet<PathBuf>,
) {
    if plugins.len() >= MAX_PI_PLUGIN_ROOTS {
        return;
    }
    let Ok(metadata) = fs::symlink_metadata(root) else {
        return;
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return;
    }
    if let Some(mut capability) = plugin_capability_from_directory(root, scope, true) {
        capability.enabled =
            enablement.is_enabled(scope, Path::new(&capability.path), &capability.name);
        if seen.insert(PathBuf::from(&capability.path)) {
            plugins.push(capability);
        }
        return;
    }

    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut visited = 0usize;
    while let Some((directory, depth)) = stack.pop() {
        if plugins.len() >= MAX_PI_PLUGIN_ROOTS
            || depth >= MAX_PI_PLUGIN_SCAN_DEPTH
            || visited >= MAX_PI_PLUGIN_SCAN_ENTRIES
        {
            break;
        }
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        let mut children = entries.flatten().collect::<Vec<_>>();
        children.sort_by_key(|entry| entry.file_name());
        for entry in children.into_iter().rev() {
            visited += 1;
            if visited >= MAX_PI_PLUGIN_SCAN_ENTRIES {
                break;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || matches!(name.as_str(), "node_modules" | "target") {
                continue;
            }
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() || !file_type.is_dir() {
                continue;
            }
            if let Some(mut capability) = plugin_capability_from_directory(&path, scope, true) {
                capability.enabled =
                    enablement.is_enabled(scope, Path::new(&capability.path), &capability.name);
                if seen.insert(PathBuf::from(&capability.path)) {
                    plugins.push(capability);
                }
                continue;
            }
            stack.push((path, depth + 1));
        }
    }
}

/// Return the Host-validated plugin inventory used by Pi preflight and
/// resource projection. Only plugins the user actually enabled are marked
/// active; discovered-but-inactive plugins stay visible for Settings but can
/// neither block Pi nor contribute resources.
pub(crate) fn pi_plugin_resources(cwd: &str) -> Result<Vec<MelodyPluginCapability>, String> {
    let enablement = PluginEnablement::for_workspace(cwd)?;
    scan_plugin_roots(plugin_search_roots(cwd)?, &enablement)
}

fn scan_plugin_roots(
    roots: Vec<(PathBuf, String)>,
    enablement: &PluginEnablement,
) -> Result<Vec<MelodyPluginCapability>, String> {
    let mut plugins = Vec::new();
    let mut seen = HashSet::new();
    for (root, scope) in roots {
        scan_plugin_tree(&root, &scope, enablement, &mut plugins, &mut seen);
        if plugins.len() >= MAX_PI_PLUGIN_ROOTS {
            break;
        }
    }
    plugins.sort_by(|left, right| left.name.cmp(&right.name).then(left.path.cmp(&right.path)));
    // Melody resolves a name conflict by source precedence: project beats user
    // beats a configured directory, and within one scope the first canonical
    // root wins. Without this, a plugin installed both under
    // `installed-plugins` and inside a marketplace cache plugin appears twice
    // in the inventory and in the capability diagnostics.
    let mut by_name: Vec<MelodyPluginCapability> = Vec::new();
    for plugin in plugins {
        match by_name
            .iter()
            .position(|existing| existing.name == plugin.name)
        {
            Some(index) => {
                if scope_rank(&plugin.scope) < scope_rank(&by_name[index].scope) {
                    by_name[index] = plugin;
                }
            }
            None => by_name.push(plugin),
        }
    }
    by_name.sort_by(|left, right| left.name.cmp(&right.name).then(left.path.cmp(&right.path)));
    Ok(by_name)
}

/// Lower rank wins a name conflict, matching Melody's scope precedence.
fn scope_rank(scope: &str) -> u8 {
    match scope {
        "project" => 0,
        "user" => 1,
        _ => 2,
    }
}
