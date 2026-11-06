//! Host-owned discovery and policy projection for Pi's declarative Skill resources.
//! Skills cross the worker seam only as bounded, concrete paths.

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use serde_json::{Value, json};

use super::super::config_skill_details::{allowed_skill_path, skill_description_from_directory};
use super::prompt_resources::pi_prompt_scan_roots;
use super::{
    MAX_PI_SKILL_IGNORE_BYTES, extension_config_names, merged_config_array, pi_plugin_resources,
    pi_respect_gitignore,
};
use crate::config_core::{MelodyExtension, MelodyPluginCapability, melody_home, user_home};

pub(crate) const MAX_PI_SKILL_PATHS: usize = 256;
pub(crate) const MAX_PI_SKILL_DEPTH: usize = 6;
pub(crate) const MAX_PI_SKILL_FILE_BYTES: u64 = 1024 * 1024;
pub(crate) const MAX_PI_SKILL_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
pub(crate) const MAX_PI_SKILL_IGNORE_PATHS: usize = 64;

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
    scan_pi_skill_root_by_status(root, disabled, ignore_paths, paths, total_bytes, false);
}

/// Collect only Skills disabled by the same name-based policy Pi receives.
/// Keeping this as a separate bounded scan lets the Settings inventory show
/// disabled Skills without changing the exact active path list sent to Pi.
pub(crate) fn scan_pi_disabled_skill_root(
    root: &Path,
    disabled: &HashSet<String>,
    ignore_paths: &[PathBuf],
    paths: &mut Vec<PathBuf>,
    total_bytes: &mut u64,
) {
    scan_pi_skill_root_by_status(root, disabled, ignore_paths, paths, total_bytes, true);
}

fn scan_pi_skill_root_by_status(
    root: &Path,
    disabled: &HashSet<String>,
    ignore_paths: &[PathBuf],
    paths: &mut Vec<PathBuf>,
    total_bytes: &mut u64,
    include_disabled: bool,
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
            if !name.starts_with('.') && disabled.contains(name) == include_disabled {
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

/// Return the active paths Pi receives plus the bounded, explicitly disabled
/// Skills that Settings may offer to re-enable. The active half is delegated
/// to `pi_skill_paths` unchanged so the UI cannot claim Pi will load a Skill
/// that the worker does not receive.
pub(crate) fn pi_skill_catalog_paths(cwd: &str) -> Result<(Vec<PathBuf>, Vec<PathBuf>), String> {
    let active = pi_skill_paths(cwd)?;
    let roots = pi_skill_scan_roots(cwd)?;
    let mut disabled_paths = Vec::new();
    let mut total_bytes = 0;
    for root in roots {
        scan_pi_disabled_skill_root(
            &root.path,
            &root.disabled,
            &root.ignore_paths,
            &mut disabled_paths,
            &mut total_bytes,
        );
        if disabled_paths.len() >= MAX_PI_SKILL_PATHS {
            break;
        }
    }
    disabled_paths.retain(|path| !active.iter().any(|active| active == path));
    let mut deduped = Vec::with_capacity(disabled_paths.len());
    for path in disabled_paths {
        if !deduped.iter().any(|existing| existing == &path) {
            deduped.push(path);
        }
    }
    Ok((active, deduped))
}

/// Map Pi's concrete, Host-validated paths to the existing Settings skill
/// model. The directory basename is intentionally the displayed/toggled name:
/// `[skills].disabled` is matched against that same name by the worker.
pub(crate) fn pi_skill_extensions_from_catalog(
    cwd: &str,
    active_paths: &[PathBuf],
    disabled_paths: &[PathBuf],
    roots: &[PiSkillScanRoot],
    plugins: &[MelodyPluginCapability],
) -> Vec<MelodyExtension> {
    let active = active_paths.iter().cloned().collect::<HashSet<_>>();
    let mut extensions = Vec::new();
    for path in active_paths.iter().chain(disabled_paths) {
        let Ok(canonical) = path.canonicalize() else {
            continue;
        };
        let Some(name) = canonical.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let containing_root = roots
            .iter()
            .filter_map(|root| {
                let canonical_root = root.path.canonicalize().ok()?;
                canonical
                    .starts_with(&canonical_root)
                    .then_some((canonical_root.components().count(), root))
            })
            .max_by_key(|(depth, _)| *depth)
            .map(|(_, root)| root);
        let plugin = plugins.iter().find(|plugin| {
            plugin.enabled
                && plugin.static_resources
                && plugin.skill_roots.iter().any(|root| {
                    Path::new(root)
                        .canonicalize()
                        .ok()
                        .is_some_and(|root| canonical.starts_with(root))
                })
        });
        let provider = if plugin.is_some() {
            "plugin"
        } else {
            let path = canonical.to_string_lossy();
            if path.contains("/.agents/") || path.contains("\\.agents\\") {
                "agents"
            } else if path.contains("/.claude/") || path.contains("\\.claude\\") {
                "claude"
            } else if path.contains("/.cursor/") || path.contains("\\.cursor\\") {
                "cursor"
            } else {
                "melody"
            }
        };
        let scope = containing_root
            .map(|root| root.scope.as_str())
            .unwrap_or("project");
        extensions.push(MelodyExtension {
            kind: "skills".to_string(),
            name: name.to_string(),
            path: canonical.to_string_lossy().into_owned(),
            scope: scope.to_string(),
            provider: provider.to_string(),
            managed: plugin.is_some(),
            enabled: active.contains(&canonical),
            description: skill_description_from_directory(&canonical),
            source: Some(if plugin.is_some() { "plugin" } else { "pi" }.to_string()),
            plugin_name: plugin.map(|plugin| plugin.name.clone()),
            user_invocable: None,
            compatibility_status: None,
            deletable: allowed_skill_path(cwd, &canonical).is_ok(),
        });
    }
    extensions.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then(left.scope.cmp(&right.scope))
            .then(left.provider.cmp(&right.provider))
            .then(left.path.cmp(&right.path))
    });
    extensions
}

pub(crate) fn pi_skill_extensions(cwd: &str) -> Result<Vec<MelodyExtension>, String> {
    let (active_paths, disabled_paths) = pi_skill_catalog_paths(cwd)?;
    let roots = pi_skill_scan_roots(cwd)?;
    let plugins = pi_plugin_resources(cwd)?;
    Ok(pi_skill_extensions_from_catalog(
        cwd,
        &active_paths,
        &disabled_paths,
        &roots,
        &plugins,
    ))
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

/// Build the resource-discovery portion of the worker manifest.
///
/// The runtime facade combines these roots with subagent and policy snapshots,
/// keeping resource discovery independent from the subagent configuration
/// owner that consumes plugin-provided agent roots.
pub(crate) fn pi_resource_manifest_parts(cwd: &str) -> Result<Value, String> {
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
    let manifest = json!({
        "cwd": cwd,
        "skillRoots": skill_roots,
        "promptRoots": prompt_roots,
        "respectGitignore": pi_respect_gitignore(cwd),
    });
    Ok(manifest)
}
