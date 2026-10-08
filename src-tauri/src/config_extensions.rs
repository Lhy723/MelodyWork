use std::{
    collections::HashSet,
    env, fs,
    path::{Path, PathBuf},
};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};

use crate::capability_lifecycle::{CapabilityKind, capability_name, change_capability_state};
use crate::melody_command::MelodyCommandRunner;
use crate::pi_worker_runtime::PiWorkerRuntime;
use crate::workspace_access::WorkspaceRegistry;

use super::config_core::*;
use super::config_plugin_details::allowed_skill_path;
use super::config_subagents::pi_subagent_policy_manifest;

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

    /// Build an enablement state directly so suites can exercise scans without
    /// touching the user's real config.
    #[cfg(test)]
    pub(crate) fn explicit(enabled: &[&str], disabled: &[&str]) -> Self {
        Self {
            enabled: enabled.iter().map(|entry| entry.to_string()).collect(),
            disabled: disabled.iter().map(|entry| entry.to_string()).collect(),
        }
    }
}

/// Melody's stable plugin identity: `<scope>/<hex8>/<name>`, where `<hex8>` is
/// the first four bytes of the SHA-256 of the canonical plugin root.
/// `melody plugin add` records this id in `[plugins].enabled`, so both the id
/// and the plain plugin name have to resolve to the same plugin.
pub(crate) fn plugin_identity(scope: &str, root: &Path, name: &str) -> String {
    let canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    format!(
        "{scope}/{:02x}{:02x}{:02x}{:02x}/{name}",
        digest[0], digest[1], digest[2], digest[3]
    )
}

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

pub(crate) const MAX_PI_SKILL_PATHS: usize = 256;
pub(crate) const MAX_PI_SKILL_DEPTH: usize = 6;
pub(crate) const MAX_PI_SKILL_FILE_BYTES: u64 = 1024 * 1024;
pub(crate) const MAX_PI_SKILL_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
pub(crate) const MAX_PI_PROMPT_PATHS: usize = 512;
pub(crate) const MAX_PI_PROMPT_FILE_BYTES: u64 = 1024 * 1024;
pub(crate) const MAX_PI_PROMPT_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
pub(crate) const MAX_PI_PLUGIN_ROOTS: usize = 128;
const MAX_PI_PLUGIN_SCAN_DEPTH: usize = 5;
const MAX_PI_PLUGIN_SCAN_ENTRIES: usize = 4096;
/// Bounds for `[skills].ignore`; must match the worker's parsed limits.
pub(crate) const MAX_PI_SKILL_IGNORE_PATHS: usize = 64;
pub(crate) const MAX_PI_SKILL_IGNORE_BYTES: usize = 4096;
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
    if let Some(mut capability) =
        super::config_plugin_details::plugin_capability_from_directory(root, scope, true)
    {
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
            if let Some(mut capability) =
                super::config_plugin_details::plugin_capability_from_directory(&path, scope, true)
            {
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

/// Agent-definition directories contributed by enabled, Markdown-only plugins.
///
/// Plugin agents are declarative Markdown, so they join the same bounded
/// subagent policy manifest as Melody's own `.melody/.agents/.claude/.cursor`
/// agent roots. Plugins with hooks, MCP/LSP servers, extensions or unsafe
/// manifest paths are excluded and keep the session on the compatibility
/// engine instead.
pub(crate) fn pi_plugin_agent_roots(cwd: &str) -> Result<Vec<(PathBuf, String, String)>, String> {
    let mut roots = Vec::new();
    for plugin in pi_plugin_resources(cwd)? {
        if !plugin.enabled || !plugin.static_resources {
            continue;
        }
        roots.extend(
            plugin
                .agent_roots
                .into_iter()
                .map(|path| {
                    (
                        PathBuf::from(path),
                        plugin.scope.clone(),
                        plugin.name.clone(),
                    )
                })
                .collect::<Vec<_>>(),
        );
    }
    Ok(roots)
}

/// Scan one explicitly trusted Skill root for ordinary `SKILL.md` directories.
///
/// Pi's resource loader can accept additional skill paths even when ambient
/// discovery is disabled. The Host therefore enumerates concrete directories
/// instead of handing Pi an arbitrary root. Symlinks, hidden/dependency
/// directories, malformed files and oversized definitions are ignored before
/// a path crosses the worker boundary. A directory containing SKILL.md is a
/// leaf, matching Pi's own discovery semantics.
pub(crate) fn scan_pi_skill_root(
    root: &Path,
    disabled: &HashSet<String>,
    ignore_paths: &[PathBuf],
    paths: &mut Vec<PathBuf>,
    total_bytes: &mut u64,
) {
    if paths.len() >= MAX_PI_SKILL_PATHS {
        return;
    }
    let Ok(root_metadata) = fs::symlink_metadata(root) else {
        return;
    };
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return;
    }
    let Ok(canonical_root) = root.canonicalize() else {
        return;
    };
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((directory, depth)) = stack.pop() {
        if paths.len() >= MAX_PI_SKILL_PATHS || depth > MAX_PI_SKILL_DEPTH {
            continue;
        }
        let Ok(directory_metadata) = fs::symlink_metadata(&directory) else {
            continue;
        };
        if directory_metadata.file_type().is_symlink() || !directory_metadata.is_dir() {
            continue;
        }
        // An ignored subtree is skipped before it is walked, so a hidden Skill
        // cannot reappear through a nested directory either.
        if !ignore_paths.is_empty() && skill_is_ignored(&directory, ignore_paths) {
            continue;
        }
        let Ok(skill_file_metadata) = fs::symlink_metadata(directory.join("SKILL.md")) else {
            continue_scan_pi_skill_children(&directory, depth, &mut stack);
            continue;
        };
        // A declared Skill directory is a Skill itself: plugin manifests list
        // concrete `skills/<name>` directories, not only container roots. A
        // directory with SKILL.md is still a leaf below the root, so nested
        // helper files are never exposed as separate Skills.
        if skill_file_metadata.file_type().is_file()
            && skill_file_metadata.len() <= MAX_PI_SKILL_FILE_BYTES
        {
            let Some(name) = directory.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if !name.starts_with('.') && !disabled.contains(name) {
                let Ok(canonical) = directory.canonicalize() else {
                    continue;
                };
                if canonical.starts_with(&canonical_root)
                    && !paths.iter().any(|existing| existing == &canonical)
                    && total_bytes.saturating_add(skill_file_metadata.len())
                        <= MAX_PI_SKILL_TOTAL_BYTES
                {
                    *total_bytes = total_bytes.saturating_add(skill_file_metadata.len());
                    paths.push(canonical);
                }
            }
            if depth > 0 {
                continue;
            }
        }
        continue_scan_pi_skill_children(&directory, depth, &mut stack);
    }
}

fn continue_scan_pi_skill_children(
    directory: &Path,
    depth: usize,
    stack: &mut Vec<(PathBuf, usize)>,
) {
    if depth >= MAX_PI_SKILL_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut children = entries.flatten().collect::<Vec<_>>();
    children.sort_by_key(|entry| entry.file_name());
    // A stack is used so the scan remains iterative and bounded. Reverse
    // lexical insertion preserves the same order as a recursive walk.
    for entry in children.into_iter().rev() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() && !file_type.is_symlink() {
            stack.push((entry.path(), depth + 1));
        }
    }
}

fn pi_skill_roots(cwd: &str) -> Result<Vec<(PathBuf, String)>, String> {
    let cwd_path = PathBuf::from(cwd);
    if !cwd_path.is_dir() {
        return Err(format!("Workspace does not exist: {}", cwd_path.display()));
    }
    let mut roots = Vec::new();
    let config_names = [".melody", ".agents", ".claude", ".cursor"];
    let mut current = cwd_path;
    let mut found_repository_marker = false;
    loop {
        for name in config_names {
            roots.push((current.join(name).join("skills"), "project".to_string()));
        }
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
        roots.truncate(config_names.len());
    }
    let home = user_home()?;
    let melody = melody_home()?;
    roots.push((melody.join("skills"), "user".to_string()));
    for name in [".agents", ".claude", ".cursor"] {
        roots.push((home.join(name).join("skills"), "user".to_string()));
    }
    for plugin in pi_plugin_resources(cwd)? {
        if plugin.enabled && plugin.static_resources {
            roots.extend(
                plugin
                    .skill_roots
                    .into_iter()
                    .map(|path| (PathBuf::from(path), plugin.scope.clone())),
            );
        }
    }
    Ok(roots)
}

/// Return explicitly enumerated Skill directories for the Pi worker.
///
/// This includes Melody's managed roots, the standard external
/// `.agents/.claude/.cursor` roots that Melody already discovers as ordinary
/// Markdown Skills, and concrete Skill roots from static-only plugins.
/// Plugin roots with executable extensions, hooks or MCP/LSP declarations are
/// intentionally omitted and remain on the legacy compatibility path.
pub(crate) fn pi_skill_paths(cwd: &str) -> Result<Vec<PathBuf>, String> {
    let roots = pi_skill_scan_roots(cwd)?;
    let mut paths = Vec::new();
    let mut total_bytes = 0;
    for root in roots {
        let before = paths.len();
        scan_pi_skill_root(
            &root.path,
            &root.disabled,
            &root.ignore_paths,
            &mut paths,
            &mut total_bytes,
        );
        // Keep project/user precedence stable while still making each root's
        // traversal deterministic. Duplicates are removed after the full
        // ordered scan below.
        if paths.len() == before {
            continue;
        }
        if paths.len() >= MAX_PI_SKILL_PATHS {
            break;
        }
    }
    let mut deduped = Vec::with_capacity(paths.len());
    for path in paths {
        if !deduped.iter().any(|existing| existing == &path) {
            deduped.push(path);
        }
    }
    deduped.truncate(MAX_PI_SKILL_PATHS);
    Ok(deduped)
}

/// One trusted Skill root plus the policy snapshots used by both the initial
/// concrete-path projection and a worker refresh. Keeping them in one
/// Host-owned representation prevents a refresh from re-enabling a Skill the
/// user disabled in config or hiding one they did not ignore.
pub(crate) struct PiSkillScanRoot {
    pub(crate) path: PathBuf,
    pub(crate) scope: String,
    pub(crate) disabled: HashSet<String>,
    /// `[skills].ignore` prefixes, attached to native roots only: the engine
    /// filters `ignore` before plugin Skills are merged, so a plugin Skill that
    /// happens to live under an ignored directory stays visible.
    pub(crate) ignore_paths: Vec<PathBuf>,
}

pub(crate) fn pi_skill_scan_roots(cwd: &str) -> Result<Vec<PiSkillScanRoot>, String> {
    let ignore_paths = pi_skill_ignore_paths(cwd)?;
    let mut roots = Vec::new();
    for (path, scope) in pi_skill_roots(cwd)? {
        let disabled = extension_config_names(&scope, cwd, "skills", "disabled")?;
        // Plugin roots are appended last and identified by their scope label.
        let is_plugin_root = plugin_skill_root(cwd, &path)?;
        let scope_ignored = if is_plugin_root {
            Vec::new()
        } else {
            ignore_paths.clone()
        };
        roots.push(PiSkillScanRoot {
            path,
            scope,
            disabled,
            ignore_paths: scope_ignored,
        });
    }
    Ok(roots)
}

/// True when the root came from an enabled Markdown-only plugin.
fn plugin_skill_root(cwd: &str, root: &Path) -> Result<bool, String> {
    for plugin in pi_plugin_resources(cwd)? {
        if !plugin.enabled || !plugin.static_resources {
            continue;
        }
        if plugin
            .skill_roots
            .iter()
            .any(|declared| Path::new(declared) == root)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Scan one trusted command directory for regular Markdown prompt templates.
///
/// Prompt templates are declarative input, not executable extensions. Keep the
/// scan flat to match Melody's historical `commands/*.md` behaviour, reject
/// symlinks, and apply bounded file/aggregate sizes before handing paths to
/// the Pi worker.
pub(crate) fn scan_pi_prompt_root(
    root: &Path,
    disabled: &HashSet<String>,
    paths: &mut Vec<PathBuf>,
    total_bytes: &mut u64,
) {
    if paths.len() >= MAX_PI_PROMPT_PATHS {
        return;
    }
    let Ok(root_metadata) = fs::symlink_metadata(root) else {
        return;
    };
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return;
    }
    let Ok(canonical_root) = root.canonicalize() else {
        return;
    };
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut entries = entries.flatten().collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if paths.len() >= MAX_PI_PROMPT_PATHS {
            break;
        }
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || path.extension().and_then(|extension| extension.to_str()) != Some("md")
            || metadata.len() > MAX_PI_PROMPT_FILE_BYTES
        {
            continue;
        }
        let Some(name) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if disabled.contains(name)
            || total_bytes.saturating_add(metadata.len()) > MAX_PI_PROMPT_TOTAL_BYTES
        {
            continue;
        }
        let Ok(canonical) = path.canonicalize() else {
            continue;
        };
        // Canonicalizing and checking the parent closes the symlink escape
        // race between directory enumeration and worker startup.
        if canonical.parent() != Some(canonical_root.as_path()) {
            continue;
        }
        if paths.iter().any(|existing| existing == &canonical) {
            continue;
        }
        *total_bytes = total_bytes.saturating_add(metadata.len());
        paths.push(canonical);
    }
}

/// Return the explicitly allow-listed Markdown command templates for Pi.
///
/// Roots follow Melody's command discovery order: nearest project config
/// directories first (up to the repository marker), then the app's global
/// `.melody/commands`, followed by user compatibility roots. Pi's ambient
/// prompt directories remain disabled; only these concrete files cross the
/// Host/worker boundary.
pub(crate) fn pi_prompt_paths(cwd: &str) -> Result<Vec<PathBuf>, String> {
    let roots = pi_prompt_scan_roots(cwd)?;
    let mut paths = Vec::new();
    let mut total_bytes = 0;
    for (root, disabled) in roots {
        scan_pi_prompt_root(&root, &disabled, &mut paths, &mut total_bytes);
        if paths.len() >= MAX_PI_PROMPT_PATHS {
            break;
        }
    }
    Ok(paths)
}

/// Return command roots and the disabled-name snapshot used by the Pi worker
/// to discover newly-created prompt templates after a worker has started.
pub(crate) fn pi_prompt_scan_roots(cwd: &str) -> Result<Vec<(PathBuf, HashSet<String>)>, String> {
    let cwd_path = PathBuf::from(cwd);
    if !cwd_path.is_dir() {
        return Err(format!("Workspace does not exist: {}", cwd_path.display()));
    }
    let user_root = user_home()?;
    let melody_root = melody_home()?;
    let project_disabled = extension_config_names("project", cwd, "skills", "disabled")?;
    let user_disabled = extension_config_names("user", cwd, "skills", "disabled")?;

    let project_config_names = [".melody", ".agents", ".claude", ".cursor"];
    let mut project_roots = Vec::new();
    let mut current = cwd_path;
    let mut found_repository_marker = false;
    loop {
        for name in project_config_names {
            project_roots.push((
                current.join(name).join("commands"),
                project_disabled.clone(),
            ));
        }
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
        project_roots.truncate(project_config_names.len());
    }

    let mut roots = project_roots;
    roots.push((melody_root.join("commands"), user_disabled.clone()));
    for name in [".agents", ".claude", ".cursor"] {
        roots.push((user_root.join(name).join("commands"), user_disabled.clone()));
    }
    for plugin in pi_plugin_resources(cwd)? {
        if plugin.enabled && plugin.static_resources {
            let disabled = if plugin.scope == "project" {
                project_disabled.clone()
            } else {
                user_disabled.clone()
            };
            roots.extend(
                plugin
                    .prompt_roots
                    .into_iter()
                    .map(|path| (PathBuf::from(path), disabled.clone())),
            );
        }
    }
    Ok(roots)
}

fn parse_boolean_override(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

const PI_TERMINAL_DEFAULT_TIMEOUT_MS: u64 = 120_000;
const PI_TERMINAL_ABSOLUTE_MAX_TIMEOUT_MS: u64 = 36_000_000;
const PI_TERMINAL_DEFAULT_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const PI_QUESTION_TIMEOUT_DEFAULT_MS: u64 = 30 * 60 * 1000;
// JavaScript setTimeout accepts a signed 32-bit delay. Keeping the Host
// projection below that boundary avoids overflow-to-immediate timers.
const PI_QUESTION_TIMEOUT_MAX_MS: u64 = 2_147_483_647;

fn positive_seconds_to_millis(value: &Value) -> Option<u64> {
    let seconds = value.as_f64()?;
    if !seconds.is_finite() || seconds <= 0.0 {
        return None;
    }
    let millis = (seconds * 1000.0).round();
    if !millis.is_finite() || millis <= 0.0 {
        return Some(1);
    }
    Some((millis as u64).clamp(1, PI_TERMINAL_ABSOLUTE_MAX_TIMEOUT_MS))
}

fn positive_output_limit(value: &Value) -> Option<usize> {
    let bytes = value.as_u64()?.max(1);
    Some(bytes.min(PI_TERMINAL_DEFAULT_OUTPUT_BYTES as u64) as usize)
}

fn positive_question_seconds_to_millis(value: &Value) -> Option<u64> {
    let seconds = value.as_f64()?;
    if !seconds.is_finite() || seconds <= 0.0 {
        return None;
    }
    let millis = (seconds * 1000.0).round();
    if !millis.is_finite() || millis <= 0.0 {
        return Some(1);
    }
    Some((millis as u64).clamp(1, PI_QUESTION_TIMEOUT_MAX_MS))
}

fn terminal_policy_value(document: &MelodyConfigDocument, key: &str) -> Option<Value> {
    document
        .values
        .get("toolset")
        .and_then(Value::as_object)
        .and_then(|toolset| toolset.get("bash"))
        .and_then(Value::as_object)
        .and_then(|bash| bash.get(key))
        .cloned()
}

fn env_positive_seconds(name: &str) -> Option<u64> {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .and_then(|value| positive_seconds_to_millis(&Value::from(value)))
}

fn env_positive_output_limit(name: &str) -> Option<usize> {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .and_then(|value| positive_output_limit(&Value::from(value)))
}

/// Resolve the foreground terminal controls that can be enforced by the
/// Host-owned Pi ToolGateway.  Project values override user values per field;
/// explicit environment overrides are applied last.  The hard caps keep a
/// malformed or over-generous config from turning a worker request into an
/// unbounded process or an unbounded in-memory preview.
pub(crate) fn pi_terminal_policy(cwd: &str) -> Option<PiTerminalPolicy> {
    let mut timeout_ms = None;
    let mut max_timeout_ms = None;
    let mut output_byte_limit = None;
    for scope in ["user", "project"] {
        let Ok(document) = read_melody_config_inner(scope.to_string(), cwd.to_string()) else {
            continue;
        };
        if let Some(value) = terminal_policy_value(&document, "timeout_secs")
            && let Some(parsed) = positive_seconds_to_millis(&value)
        {
            timeout_ms = Some(parsed);
        }
        if let Some(value) = terminal_policy_value(&document, "max_timeout_secs")
            && let Some(parsed) = positive_seconds_to_millis(&value)
        {
            max_timeout_ms = Some(parsed);
        }
        if let Some(value) = terminal_policy_value(&document, "output_byte_limit")
            && let Some(parsed) = positive_output_limit(&value)
        {
            output_byte_limit = Some(parsed);
        }
    }
    if let Some(parsed) = env_positive_seconds("MELODY_TERMINAL_TIMEOUT_SECS") {
        timeout_ms = Some(parsed);
    }
    if let Some(parsed) = env_positive_seconds("MELODY_TERMINAL_MAX_TIMEOUT_SECS") {
        max_timeout_ms = Some(parsed);
    }
    if let Some(parsed) = env_positive_output_limit("MELODY_TERMINAL_OUTPUT_BYTE_LIMIT") {
        output_byte_limit = Some(parsed);
    }

    if timeout_ms.is_none() && max_timeout_ms.is_none() && output_byte_limit.is_none() {
        return None;
    }
    let default_timeout_ms = timeout_ms.unwrap_or(PI_TERMINAL_DEFAULT_TIMEOUT_MS);
    let max_timeout_ms = max_timeout_ms
        .unwrap_or(PI_TERMINAL_DEFAULT_TIMEOUT_MS.max(default_timeout_ms))
        .max(1);
    Some(PiTerminalPolicy {
        default_timeout_ms: default_timeout_ms.min(max_timeout_ms),
        max_timeout_ms,
        output_byte_limit: output_byte_limit.unwrap_or(PI_TERMINAL_DEFAULT_OUTPUT_BYTES),
    })
}

fn question_policy_value(document: &MelodyConfigDocument, key: &str) -> Option<Value> {
    document
        .values
        .get("toolset")
        .and_then(Value::as_object)
        .and_then(|toolset| toolset.get("ask_user_question"))
        .and_then(Value::as_object)
        .and_then(|question| question.get(key))
        .cloned()
}

/// Resolve Melody's question waiting policy for the Pi worker.  Pi exposes
/// the interaction itself but no product-level timeout switch, so this small
/// Host projection preserves the existing `timeout_enabled`/`timeout_secs`
/// semantics without exposing an ambient timer or config file to the worker.
pub(crate) fn pi_question_timeout_policy(cwd: &str) -> Option<PiQuestionTimeoutPolicy> {
    let mut enabled = None;
    let mut timeout_ms = None;
    for scope in ["user", "project"] {
        let Ok(document) = read_melody_config_inner(scope.to_string(), cwd.to_string()) else {
            continue;
        };
        if let Some(value) = question_policy_value(&document, "timeout_enabled")
            && let Some(parsed) = value.as_bool()
        {
            enabled = Some(parsed);
        }
        if let Some(value) = question_policy_value(&document, "timeout_secs")
            && let Some(parsed) = positive_question_seconds_to_millis(&value)
        {
            timeout_ms = Some(parsed);
        }
    }
    if let Ok(raw) = env::var("MELODY_ASK_USER_QUESTION_TIMEOUT_ENABLED")
        && let Some(parsed) = parse_boolean_override(&raw)
    {
        enabled = Some(parsed);
    }
    if let Ok(raw) = env::var("MELODY_ASK_USER_QUESTION_TIMEOUT_SECS")
        && let Ok(seconds) = raw.parse::<f64>()
    {
        if let Some(parsed) = positive_question_seconds_to_millis(&Value::from(seconds)) {
            timeout_ms = Some(parsed);
        }
    }

    if enabled.is_none() && timeout_ms.is_none() {
        return None;
    }
    Some(PiQuestionTimeoutPolicy {
        enabled: enabled.unwrap_or(true),
        timeout_ms: timeout_ms.unwrap_or(PI_QUESTION_TIMEOUT_DEFAULT_MS),
    })
}

const PI_GOAL_MAX_TOKEN_BUDGET: u64 = 100_000_000;
const PI_GOAL_MAX_STALL_TIMEOUT_SECS: u64 = 7 * 24 * 60 * 60;
const PI_GOAL_MAX_BLOCKED_ATTEMPTS: u64 = 100;

fn goal_policy_value(document: &MelodyConfigDocument, key: &str) -> Option<Value> {
    for section_name in ["goal", "goal_orchestration"] {
        if let Some(value) = document
            .values
            .get(section_name)
            .and_then(Value::as_object)
            .and_then(|section| section.get(key))
        {
            return Some(value.clone());
        }
    }
    None
}

fn goal_policy_top_level_value(document: &MelodyConfigDocument, key: &str) -> Option<Value> {
    document.values.get(key).cloned()
}

fn positive_goal_integer(value: &Value, max: u64) -> Option<u64> {
    value
        .as_u64()
        .filter(|number| *number >= 1 && *number <= max)
}

fn env_positive_goal_integer(name: &str, max: u64) -> Option<u64> {
    env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|number| *number >= 1 && *number <= max)
}

/// Project the deterministic portion of Melody's goal safeguards into Pi.
///
/// A configured classifier/planner/retry policy is still negotiated by the
/// capability report and routed to ACP. This projection only carries bounded
/// token, wall-clock stall, and blocked-report controls that the Pi extension
/// can enforce without hidden model calls.
pub(crate) fn pi_goal_policy(cwd: &str) -> Option<Value> {
    let mut policy = serde_json::Map::new();
    let mut token_budget = None;
    let mut stall_detection = None;
    let mut stall_timeout_secs = None;
    let mut max_blocked_attempts = None;
    for scope in ["user", "project"] {
        let Ok(document) = read_melody_config_inner(scope.to_string(), cwd.to_string()) else {
            continue;
        };
        token_budget = goal_policy_value(&document, "token_budget")
            .or_else(|| goal_policy_top_level_value(&document, "goal_token_budget"))
            .and_then(|value| positive_goal_integer(&value, PI_GOAL_MAX_TOKEN_BUDGET))
            .or(token_budget);
        stall_detection = goal_policy_value(&document, "stall_detection")
            .or_else(|| goal_policy_top_level_value(&document, "goal_stall_detection"))
            .and_then(|value| value.as_bool())
            .or(stall_detection);
        stall_timeout_secs = goal_policy_value(&document, "stall_timeout_secs")
            .or_else(|| goal_policy_top_level_value(&document, "goal_stall_timeout_secs"))
            .and_then(|value| positive_goal_integer(&value, PI_GOAL_MAX_STALL_TIMEOUT_SECS))
            .or(stall_timeout_secs);
        max_blocked_attempts = goal_policy_value(&document, "max_blocked_attempts")
            .or_else(|| goal_policy_top_level_value(&document, "goal_max_blocked_attempts"))
            .and_then(|value| positive_goal_integer(&value, PI_GOAL_MAX_BLOCKED_ATTEMPTS))
            .or(max_blocked_attempts);
    }
    if let Some(value) =
        env_positive_goal_integer("MELODY_GOAL_TOKEN_BUDGET", PI_GOAL_MAX_TOKEN_BUDGET)
    {
        token_budget = Some(value);
    }
    if let Ok(raw) = env::var("MELODY_GOAL_STALL_DETECTION")
        && let Some(value) = parse_boolean_override(&raw)
    {
        stall_detection = Some(value);
    }
    if let Some(value) = env_positive_goal_integer(
        "MELODY_GOAL_STALL_TIMEOUT_SECS",
        PI_GOAL_MAX_STALL_TIMEOUT_SECS,
    ) {
        stall_timeout_secs = Some(value);
    }
    if let Some(value) = env_positive_goal_integer(
        "MELODY_GOAL_MAX_BLOCKED_ATTEMPTS",
        PI_GOAL_MAX_BLOCKED_ATTEMPTS,
    ) {
        max_blocked_attempts = Some(value);
    }
    if let Some(value) = token_budget {
        policy.insert("tokenBudget".to_string(), Value::from(value));
    }
    if let Some(value) = stall_detection {
        policy.insert("stallDetection".to_string(), Value::from(value));
    }
    if let Some(value) = stall_timeout_secs {
        policy.insert("stallTimeoutSecs".to_string(), Value::from(value));
    }
    if let Some(value) = max_blocked_attempts {
        policy.insert("maxBlockedAttempts".to_string(), Value::from(value));
    }
    (!policy.is_empty()).then_some(Value::Object(policy))
}

/// Resolve Melody's `.gitignore` visibility policy for the Pi worker.
///
/// The project setting wins over the user setting, and the explicit
/// `MELODY_RESPECT_GITIGNORE` environment override wins over both. Invalid
/// environment values are ignored so a malformed inherited environment cannot
/// silently change the Host's default-deny projection.
pub(crate) fn pi_respect_gitignore(cwd: &str) -> bool {
    let mut enabled = false;
    for scope in ["user", "project"] {
        let Ok(document) = read_melody_config_inner(scope.to_string(), cwd.to_string()) else {
            continue;
        };
        if let Some(value) = document
            .values
            .get("tools")
            .and_then(Value::as_object)
            .and_then(|tools| tools.get("respect_gitignore"))
            .and_then(Value::as_bool)
        {
            enabled = value;
        }
    }
    if let Ok(raw) = env::var("MELODY_RESPECT_GITIGNORE")
        && let Some(value) = parse_boolean_override(&raw)
    {
        enabled = value;
    }
    enabled
}

/// Host-side projection of the optional `.envrc` integration.  The worker is
/// started with an empty environment; when this setting is enabled the Host
/// evaluates only the workspace's own `.envrc` through `direnv export json`
/// and injects the bounded result into that one worker generation.
pub(crate) fn pi_load_envrc(cwd: &str) -> bool {
    let mut enabled = false;
    for scope in ["user", "project"] {
        let Ok(document) = read_melody_config_inner(scope.to_string(), cwd.to_string()) else {
            continue;
        };
        if let Some(value) = document
            .values
            .get("session")
            .and_then(Value::as_object)
            .and_then(|session| session.get("load_envrc"))
            .and_then(Value::as_bool)
        {
            enabled = value;
        }
    }
    if let Ok(raw) = env::var("MELODY_PI_LOAD_ENVRC")
        && let Some(value) = parse_boolean_override(&raw)
    {
        enabled = value;
    }
    enabled
}

/// Resolve whether Pi may use its native online model catalog overlay.  The
/// setting is intentionally projected as a process flag rather than copied
/// into the renderer or an arbitrary worker environment.  A custom catalog
/// base is accepted only as a public HTTPS URL; the default remains Pi's
/// signed `pi.dev` catalog.
pub(crate) fn pi_model_network_policy(cwd: &str) -> Result<Option<(bool, Option<String>)>, String> {
    // Melody-build defaults remote_fetch to true.  Keep that behavior for Pi
    // while allowing an explicit config/environment opt-out for offline use.
    let mut enabled = true;
    let mut catalog_base_url = None;
    for scope in ["user", "project"] {
        let document = read_melody_config_inner(scope.to_string(), cwd.to_string())?;
        if let Some(error) = document.parse_error {
            return Err(format!("无法解析 {scope} Melody 配置：{error}"));
        }
        if let Some(value) = document
            .values
            .get("features")
            .and_then(Value::as_object)
            .and_then(|features| features.get("remote_fetch"))
            .and_then(Value::as_bool)
        {
            enabled = value;
        }
        if let Some(value) = document
            .values
            .get("endpoints")
            .and_then(Value::as_object)
            .and_then(|endpoints| endpoints.get("models_catalog_base_url"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            catalog_base_url = Some(value.to_string());
        }
    }
    if let Ok(raw) = env::var("MELODY_PI_ALLOW_MODEL_NETWORK")
        && let Some(value) = parse_boolean_override(&raw)
    {
        enabled = value;
    }
    if let Ok(value) = env::var("MELODY_PI_CATALOG_BASE_URL") {
        let value = value.trim().to_string();
        if !value.is_empty() {
            catalog_base_url = Some(value);
        }
    }
    if !enabled {
        return Ok(Some((false, None)));
    }
    if let Some(value) = catalog_base_url.as_deref() {
        let url =
            reqwest::Url::parse(value).map_err(|error| format!("Pi 模型目录地址无效：{error}"))?;
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err("Pi 模型目录地址必须是无凭据/片段的 HTTPS URL。".to_string());
        }
    }
    Ok(Some((true, catalog_base_url)))
}

/// Build the single Host-owned resource manifest used both when starting a
/// worker and when refreshing an already-running worker after a configuration
/// toggle. Keeping serialization here prevents the two paths from drifting
/// on root order or disabled-name snapshots.
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

/// The sandbox profile that applies to this workspace, if any.
///
/// `MELODY_SANDBOX` is an explicit process-level override (it is how Melody
/// launches a sandboxed agent), so it wins over `[sandbox].profile` in config.
pub(crate) fn pi_sandbox_profile(cwd: &str) -> Option<String> {
    let override_value = std::env::var(crate::workspace_sandbox::PROFILE_ENV_VAR).ok();
    resolve_sandbox_profile(
        override_value.as_deref(),
        merged_config_string(cwd, "sandbox", "profile"),
    )
}

/// Apply the documented precedence without touching the environment.
///
/// Kept pure so the rule can be tested deterministically: an explicit
/// `MELODY_SANDBOX` (unless it disables sandboxing) beats the config value.
fn resolve_sandbox_profile(
    override_value: Option<&str>,
    config_value: Option<String>,
) -> Option<String> {
    if let Some(value) = override_value {
        let trimmed = value.trim();
        if !trimmed.is_empty() && !matches!(trimmed.to_ascii_lowercase().as_str(), "off" | "none") {
            return Some(trimmed.to_string());
        }
    }
    config_value
}

/// Absolute path prefixes hidden by `[skills].ignore`.
///
/// Melody treats each entry as a path prefix (not a glob): it expands `~`,
/// resolves relative entries against the process working directory, and drops
/// any Skill whose canonical path starts with one of them. The Host resolves
/// the same prefixes once so both the initial projection and the worker's
/// later refresh hide exactly the same Skills.
pub(crate) fn pi_skill_ignore_paths(cwd: &str) -> Result<Vec<PathBuf>, String> {
    let entries = merged_config_array(cwd, "skills", "ignore")?;
    let home = user_home()?;
    let workspace = PathBuf::from(cwd);
    let mut prefixes = Vec::new();
    for entry in entries.into_iter().take(MAX_PI_SKILL_IGNORE_PATHS) {
        if entry.len() > MAX_PI_SKILL_IGNORE_BYTES {
            continue;
        }
        let expanded = match entry.strip_prefix("~/") {
            Some(relative) => home.join(relative),
            None => PathBuf::from(&entry),
        };
        if expanded.is_absolute() {
            // An absolute ignore entry is used as written; a relative one is
            // relative to the workspace, like the engine's process cwd.
            prefixes.push(expanded.canonicalize().unwrap_or(expanded));
            continue;
        }
        let resolved = workspace.join(expanded);
        prefixes.push(resolved.canonicalize().unwrap_or(resolved));
    }
    prefixes.sort();
    prefixes.dedup();
    Ok(prefixes)
}

/// True when a Skill directory is hidden by one of the resolved prefixes.
fn skill_is_ignored(path: &Path, prefixes: &[PathBuf]) -> bool {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    prefixes.iter().any(|prefix| canonical.starts_with(prefix))
}

pub(crate) fn pi_resource_manifest(cwd: &str) -> Result<Value, String> {
    let skill_roots = pi_skill_scan_roots(cwd)?
        .into_iter()
        .map(|root| {
            let mut disabled = root.disabled.into_iter().collect::<Vec<_>>();
            disabled.sort();
            let mut entry = json!({
                "path": root.path,
                "scope": root.scope,
                "disabled": disabled,
            });
            if !root.ignore_paths.is_empty() {
                let mut ignore_paths = root
                    .ignore_paths
                    .iter()
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect::<Vec<_>>();
                ignore_paths.sort();
                entry["ignorePaths"] = json!(ignore_paths);
            }
            entry
        })
        .collect::<Vec<_>>();
    let prompt_roots = pi_prompt_scan_roots(cwd)?
        .into_iter()
        .map(|(path, disabled)| {
            let mut disabled = disabled.into_iter().collect::<Vec<_>>();
            disabled.sort();
            json!({
                "path": path,
                "disabled": disabled,
            })
        })
        .collect::<Vec<_>>();
    let mut manifest = json!({
        "cwd": cwd,
        "skillRoots": skill_roots,
        "promptRoots": prompt_roots,
        "respectGitignore": pi_respect_gitignore(cwd),
        "subagentPolicies": pi_subagent_policy_manifest(cwd)?,
    });
    if let Some(policy) = pi_question_timeout_policy(cwd) {
        manifest["questionTimeoutPolicy"] = serde_json::to_value(policy)
            .map_err(|error| format!("Failed to serialize Pi question timeout policy: {error}"))?;
    }
    if let Some(policy) = pi_goal_policy(cwd) {
        manifest["goalPolicy"] = policy;
    }
    Ok(manifest)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let root = env::temp_dir().join(format!(
            "melody-work-plugin-enablement-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn config_document(source: &str) -> Value {
        let parsed = toml::from_str::<toml::Value>(source).unwrap();
        serde_json::to_value(parsed).unwrap()
    }

    /// A convention plugin root: a directory with a `skills/` component is
    /// discovered as a plugin even without a manifest.
    fn make_plugin(plugins: &Path, name: &str) -> PathBuf {
        let root = plugins.join(name);
        fs::create_dir_all(root.join("skills").join(name)).unwrap();
        fs::write(root.join("skills").join(name).join("SKILL.md"), "# Skill").unwrap();
        root
    }

    fn inventory_enabled(inventory: &[MelodyPluginCapability], name: &str) -> bool {
        inventory
            .iter()
            .find(|plugin| plugin.name == name)
            .unwrap_or_else(|| panic!("{name} should stay visible for Settings"))
            .enabled
    }

    #[test]
    fn skills_ignore_hides_a_path_prefix_for_native_roots_only() {
        let root = temp_root("skills-ignore");
        let home = root.join("home");
        let melody = home.join(".melody");
        fs::create_dir_all(&melody).unwrap();
        // Two native sources: an ignored user root and a kept one.
        let ignored = home.join(".agents/skills/hidden");
        let kept = melody.join("skills/visible");
        fs::create_dir_all(&ignored).unwrap();
        fs::create_dir_all(&kept).unwrap();
        fs::write(ignored.join("SKILL.md"), "# Hidden").unwrap();
        fs::write(kept.join("SKILL.md"), "# Visible").unwrap();
        fs::write(
            melody.join("config.toml"),
            format!(
                "[skills]\nignore = [\"{}\", \".agents\"]\ndisabled = []\n",
                home.join(".agents").display()
            ),
        )
        .unwrap();

        unsafe {
            std::env::set_var("MELODY_HOME", &melody);
        }
        let ignore_paths = pi_skill_ignore_paths(root.to_str().unwrap()).unwrap();
        assert!(
            ignore_paths.contains(&home.join(".agents").canonicalize().unwrap()),
            "an existing absolute entry is canonicalized: {ignore_paths:?}"
        );
        assert!(
            ignore_paths.contains(&root.join(".agents")),
            "a relative entry resolves against the workspace: {ignore_paths:?}"
        );

        let mut paths = Vec::new();
        let mut total = 0;
        scan_pi_skill_root(
            &home.join(".agents/skills"),
            &HashSet::new(),
            &ignore_paths,
            &mut paths,
            &mut total,
        );
        assert!(paths.is_empty(), "the ignored prefix hides its Skills");

        scan_pi_skill_root(
            &melody.join("skills"),
            &HashSet::new(),
            &ignore_paths,
            &mut paths,
            &mut total,
        );
        assert_eq!(paths.len(), 1);
        assert!(paths[0].ends_with("visible"));
        unsafe {
            std::env::remove_var("MELODY_HOME");
        }
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn sandbox_profile_precedence_is_process_override_then_config() {
        let config = || Some("workspace".to_string());
        // An explicit process override is how Melody launches a sandboxed agent.
        assert_eq!(
            resolve_sandbox_profile(Some("strict"), config()),
            Some("strict".to_string())
        );
        assert_eq!(
            resolve_sandbox_profile(Some("  devbox  "), config()),
            Some("devbox".to_string())
        );
        // "off"/"none" (and blanks) explicitly mean "no process override", so the
        // config value still applies rather than silently disabling isolation.
        for disabled in ["off", "OFF", "none", "None", "", "   "] {
            assert_eq!(
                resolve_sandbox_profile(Some(disabled), config()),
                Some("workspace".to_string()),
                "{disabled:?} must fall through to config"
            );
        }
        assert_eq!(resolve_sandbox_profile(None, config()), config());
        assert_eq!(resolve_sandbox_profile(None, None), None);
        assert_eq!(
            resolve_sandbox_profile(Some("strict"), None),
            Some("strict".to_string())
        );
    }

    #[test]
    fn plugin_skill_roots_are_not_ignored() {
        let root = temp_root("plugin-ignore");
        let plugins = root.join(".melody/plugins");
        let plugin = make_plugin(&plugins, "tools");
        fs::create_dir_all(root.join(".agents")).unwrap();
        fs::write(
            root.join(".melody/config.toml"),
            "[plugins]\nenabled = [\"tools\"]\ndisabled = []\n\n[skills]\nignore = [\".agents\"]\ndisabled = []\n",
        )
        .unwrap();

        let roots = pi_skill_scan_roots(root.to_str().unwrap()).unwrap();
        let canonical_plugin = plugin.canonicalize().unwrap();
        let plugin_root = roots
            .iter()
            .find(|entry| entry.path.starts_with(&canonical_plugin))
            .expect("the plugin Skill root is projected");
        assert!(
            plugin_root.ignore_paths.is_empty(),
            "the engine applies [skills].ignore before plugin Skills are merged"
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn plugin_name_conflicts_resolve_by_source_precedence() {
        let root = temp_root("dedupe");
        let project_plugins = root.join(".melody/plugins");
        let user_plugins = root.join("user-plugins");
        let project_plugin = make_plugin(&project_plugins, "tools");
        let user_plugin = make_plugin(&user_plugins, "tools");
        let enablement = PluginEnablement::explicit(&["tools"], &[]);

        let inventory = scan_plugin_roots(
            vec![
                (user_plugins.clone(), "user".to_string()),
                (project_plugins.clone(), "project".to_string()),
            ],
            &enablement,
        )
        .unwrap();
        assert_eq!(inventory.len(), 1, "one entry per plugin name");
        assert_eq!(
            PathBuf::from(&inventory[0].path),
            project_plugin.canonicalize().unwrap(),
            "the project copy wins over the user copy"
        );
        assert!(inventory[0].enabled);

        // Within one scope the first canonical root wins, so the same plugin
        // discovered twice does not duplicate diagnostics.
        let inventory = scan_plugin_roots(
            vec![
                (project_plugins.clone(), "project".to_string()),
                (project_plugins.clone(), "project".to_string()),
            ],
            &enablement,
        )
        .unwrap();
        assert_eq!(inventory.len(), 1);
        assert_eq!(
            PathBuf::from(&inventory[0].path),
            project_plugin.canonicalize().unwrap()
        );
        let _ = user_plugin;
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn plugins_paths_entries_are_discovered_and_enabled_by_configuration() {
        let root = temp_root("plugin-paths");
        let custom = root.join("custom-plugins");
        let plugin = make_plugin(&custom, "from-path");
        fs::create_dir_all(root.join(".melody")).unwrap();
        fs::write(
            root.join(".melody/config.toml"),
            format!(
                "[plugins]\npaths = [\"{}\"]\nenabled = []\ndisabled = []\n",
                custom.display()
            ),
        )
        .unwrap();

        let plugins = pi_plugin_resources(root.to_str().unwrap()).unwrap();
        let entry = plugins
            .iter()
            .find(|plugin| plugin.name == "from-path")
            .expect("a configured plugin directory is scanned");
        assert_eq!(entry.scope, "config");
        assert!(
            entry.enabled,
            "Melody auto-enables plugins found through [plugins].paths"
        );
        assert!(entry.static_resources);
        assert_eq!(PathBuf::from(&entry.path), plugin.canonicalize().unwrap());

        // An explicit disable still wins over the configuration default.
        fs::write(
            root.join(".melody/config.toml"),
            format!(
                "[plugins]\npaths = [\"{}\"]\nenabled = []\ndisabled = [\"from-path\"]\n",
                custom.display()
            ),
        )
        .unwrap();
        let plugins = pi_plugin_resources(root.to_str().unwrap()).unwrap();
        assert!(
            !plugins
                .iter()
                .find(|plugin| plugin.name == "from-path")
                .expect("still discovered")
                .enabled
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn plugin_enablement_requires_explicit_opt_in() {
        let root = temp_root("opt-in");
        let plugins = root.join("plugins");
        for name in ["alpha", "beta", "gamma"] {
            make_plugin(&plugins, name);
        }
        let enablement = PluginEnablement::from_documents(&[&config_document(
            r#"
            [plugins]
            enabled = ["alpha"]
            disabled = ["beta"]
            "#,
        )]);

        let inventory =
            scan_plugin_roots(vec![(plugins.clone(), "project".to_string())], &enablement).unwrap();

        assert!(
            inventory_enabled(&inventory, "alpha"),
            "an explicitly enabled plugin stays active"
        );
        assert!(
            !inventory_enabled(&inventory, "beta"),
            "a disabled entry overrides an opt-out default"
        );
        assert!(
            !inventory_enabled(&inventory, "gamma"),
            "presence on disk is not enablement, so an unlisted plugin stays inactive"
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn plugin_enablement_resolves_melody_ids_and_project_overrides() {
        let root = temp_root("ids");
        let plugins = root.join("plugins");
        make_plugin(&plugins, "alpha");
        make_plugin(&plugins, "beta");
        let alpha_id = plugin_identity("project", &plugins.join("alpha"), "alpha");

        // `melody plugin add` records `<scope>/<hex8>/<name>`, and project
        // config replaces the user value for the whole key.
        let enablement = PluginEnablement::from_documents(&[
            &config_document(
                r#"
                [plugins]
                enabled = ["legacy-user-only"]
                "#,
            ),
            &config_document(&format!(
                r#"
                [plugins]
                enabled = ["{alpha_id}"]
                "#,
            )),
        ]);
        let inventory =
            scan_plugin_roots(vec![(plugins.clone(), "project".to_string())], &enablement).unwrap();

        assert!(
            inventory_enabled(&inventory, "alpha"),
            "an id-form entry enables the plugin"
        );
        assert!(!inventory_enabled(&inventory, "beta"));
        assert_eq!(
            plugin_identity("project", &plugins.join("alpha"), "alpha"),
            alpha_id,
            "plugin identity has to stay stable for a given root"
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn plugin_enablement_ignores_malformed_sections() {
        let root = temp_root("malformed");
        let plugins = root.join("plugins");
        make_plugin(&plugins, "alpha");
        let enablement = PluginEnablement::from_documents(&[&config_document(
            r#"
            [plugins]
            enabled = "alpha"
            disabled = [1, 2]
            "#,
        )]);
        let inventory =
            scan_plugin_roots(vec![(plugins.clone(), "project".to_string())], &enablement).unwrap();
        assert_eq!(inventory.len(), 1);
        assert!(
            !inventory[0].enabled,
            "a malformed enabled list cannot enable a plugin"
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn declarative_plugin_surfaces_stay_on_pi() {
        let root = temp_root("declarative");
        let plugins = root.join("plugins");
        // `agents/` and `scripts/` are content directories: Melody never runs a
        // plugin script except through a hook, which is detected separately.
        let declarative = make_plugin(&plugins, "declarative");
        fs::create_dir_all(declarative.join("agents")).unwrap();
        fs::write(declarative.join("agents/helper.md"), "# Helper").unwrap();
        fs::create_dir_all(declarative.join("scripts")).unwrap();
        fs::write(declarative.join("scripts/build.sh"), "#!/bin/sh").unwrap();

        let enabled = PluginEnablement::explicit(&["declarative"], &[]);
        let inventory =
            scan_plugin_roots(vec![(plugins.clone(), "project".to_string())], &enabled).unwrap();
        assert!(inventory[0].static_resources);
        assert!(inventory[0].dynamic_components.is_empty());
        assert_eq!(inventory[0].agent_roots.len(), 1);

        // A hook or an MCP/LSP declaration still keeps the plugin on ACP.
        let hooked = make_plugin(&plugins, "hooked");
        fs::create_dir_all(hooked.join("hooks")).unwrap();
        fs::write(hooked.join("hooks/hooks.json"), "{}").unwrap();
        let with_server = make_plugin(&plugins, "with-server");
        fs::write(with_server.join(".mcp.json"), "{\"mcpServers\":{}}").unwrap();

        let enabled = PluginEnablement::explicit(&["hooked", "with-server"], &[]);
        let inventory =
            scan_plugin_roots(vec![(plugins.clone(), "project".to_string())], &enabled).unwrap();
        for plugin in inventory.iter().filter(|plugin| plugin.enabled) {
            assert!(
                !plugin.static_resources,
                "{} must stay on the compatibility engine",
                plugin.name
            );
        }
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn declared_plugin_components_use_relative_prefixes_and_concrete_directories() {
        let root = temp_root("declared");
        let plugins = root.join("plugins");
        let plugin = plugins.join("declared");
        fs::create_dir_all(plugin.join("skills/group/first")).unwrap();
        fs::create_dir_all(plugin.join("skills/group/second")).unwrap();
        fs::write(plugin.join("skills/group/first/SKILL.md"), "# First").unwrap();
        fs::write(plugin.join("skills/group/second/SKILL.md"), "# Second").unwrap();
        fs::create_dir_all(plugin.join(".claude-plugin")).unwrap();
        fs::write(
            plugin.join(".claude-plugin/plugin.json"),
            r#"{"name":"declared","skills":["./skills/group/first","./skills/group/second"]}"#,
        )
        .unwrap();

        let enabled = PluginEnablement::explicit(&["declared"], &[]);
        let inventory =
            scan_plugin_roots(vec![(plugins.clone(), "project".to_string())], &enabled).unwrap();
        assert!(
            inventory[0].static_resources,
            "a `./` prefix is not an unsafe manifest path"
        );
        assert_eq!(inventory[0].skill_roots.len(), 2);

        // Each declared path is the Skill directory itself, not a container.
        let mut paths = Vec::new();
        let mut total = 0;
        for skill_root in &inventory[0].skill_roots {
            scan_pi_skill_root(
                Path::new(skill_root),
                &HashSet::new(),
                &[],
                &mut paths,
                &mut total,
            );
        }
        assert_eq!(paths.len(), 2, "declared Skill directories are projected");
        assert!(paths.iter().any(|path| path.ends_with("first")));

        // A manifest that tries to escape the plugin root still blocks.
        fs::write(
            plugin.join(".claude-plugin/plugin.json"),
            r#"{"name":"declared","skills":["../outside"]}"#,
        )
        .unwrap();
        let inventory =
            scan_plugin_roots(vec![(plugins.clone(), "project".to_string())], &enabled).unwrap();
        assert!(!inventory[0].static_resources);
        assert!(
            inventory[0]
                .dynamic_components
                .contains(&"resource-path".to_string())
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn skill_scans_keep_opt_out_semantics() {
        let root = temp_root("opt-out");
        fs::create_dir_all(root.join("skills/review")).unwrap();
        fs::write(root.join("skills/review/SKILL.md"), "# Review").unwrap();
        let disabled = HashSet::new();
        let mut extensions = Vec::new();
        scan_kind(
            &root,
            "project",
            "skills",
            "melody",
            &ExtensionEnablement::DisabledOnly(&disabled),
            &mut extensions,
        );
        assert_eq!(extensions.len(), 1);
        assert!(
            extensions[0].enabled,
            "skills stay active without an explicit opt-in"
        );
        fs::remove_dir_all(&root).unwrap();
    }
}
