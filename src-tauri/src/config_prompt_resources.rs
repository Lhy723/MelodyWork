//! Host-owned discovery for Pi's declarative command prompt templates.
//!
//! Prompt templates are declarative input, not executable extensions. Only
//! bounded concrete Markdown paths and a root/disabled snapshot cross into
//! the Pi worker.

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use super::{extension_config_names, pi_plugin_resources};
use crate::config_core::{melody_home, user_home};

pub(crate) const MAX_PI_PROMPT_PATHS: usize = 512;
pub(crate) const MAX_PI_PROMPT_FILE_BYTES: u64 = 1024 * 1024;
pub(crate) const MAX_PI_PROMPT_TOTAL_BYTES: u64 = 64 * 1024 * 1024;

/// Scan one trusted command directory for regular Markdown prompt templates.
///
/// Keep the scan flat to match Melody's historical `commands/*.md` behaviour,
/// reject symlinks, and apply bounded file/aggregate sizes before handing
/// paths to the Pi worker.
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
