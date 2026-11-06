//! Resolve named sandbox profiles into canonical filesystem rules.
//!
//! This owner reads the trusted user profile before project additions and
//! normalizes profile paths for the platform adapters. It does not decide
//! whether a profile can be enforced or authorize a workspace command.

use std::path::{Path, PathBuf};

use crate::config_core::user_home;

/// The resolved filesystem rules for one workspace.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SandboxProfile {
    pub(crate) name: String,
    /// Subtrees the child may read and write.
    pub(crate) read_write: Vec<PathBuf>,
    /// Paths the child may read but not write.
    pub(crate) read_only: Vec<PathBuf>,
    /// Paths denied for both read and write.
    pub(crate) deny: Vec<PathBuf>,
    /// Glob-style deny entries, which Seatbelt would need anchored regexes for.
    pub(crate) deny_globs: Vec<String>,
    /// Whether the profile also restricts child networking.
    pub(crate) restrict_network: bool,
}

#[derive(Clone, Debug)]
struct ProfileEnvironment {
    state_dir: PathBuf,
    home_for_tilde: PathBuf,
    tmpdir: Option<PathBuf>,
}

impl ProfileEnvironment {
    fn from_process() -> Self {
        let home = user_home();
        let state_dir = std::env::var_os("MELODY_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                home.as_ref()
                    .cloned()
                    .unwrap_or_else(|_| PathBuf::from("/tmp"))
                    .join(".melody")
            });
        let home_for_tilde = home.unwrap_or_else(|_| PathBuf::from("/"));
        let tmpdir = std::env::var("TMPDIR").ok().map(PathBuf::from);
        Self {
            state_dir,
            home_for_tilde,
            tmpdir,
        }
    }
}

pub(crate) fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn temp_writable_paths(environment: &ProfileEnvironment) -> Vec<PathBuf> {
    let mut paths = vec![PathBuf::from("/tmp"), PathBuf::from("/var/tmp")];
    if cfg!(target_os = "macos") {
        for candidate in ["/private/tmp", "/private/var/tmp", "/private/var/folders"] {
            let path = PathBuf::from(candidate);
            if path.is_dir() {
                paths.push(path);
            }
        }
    }
    if let Some(tmpdir) = &environment.tmpdir {
        if tmpdir.is_dir() && !paths.contains(tmpdir) {
            paths.push(tmpdir.clone());
        }
    }
    paths
}

/// Melody's state directory, always writable so agent bookkeeping keeps working.
#[cfg(target_os = "linux")]
pub(crate) fn melody_state_dir() -> PathBuf {
    ProfileEnvironment::from_process().state_dir
}

fn split_deny(
    entries: &[String],
    workspace: &Path,
    home_for_tilde: &Path,
) -> (Vec<PathBuf>, Vec<String>) {
    let mut exact = Vec::new();
    let mut globs = Vec::new();
    for entry in entries {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.contains('*') || trimmed.contains('?') || trimmed.contains('[') {
            globs.push(trimmed.to_string());
            continue;
        }
        let expanded = match trimmed.strip_prefix("~/") {
            Some(relative) => home_for_tilde.join(relative),
            None => {
                let path = PathBuf::from(trimmed);
                if path.is_absolute() {
                    path
                } else {
                    workspace.join(path)
                }
            }
        };
        exact.push(canonical(&expanded));
    }
    (exact, globs)
}

fn path_strings(paths: &[PathBuf]) -> Vec<PathBuf> {
    paths.iter().map(|path| canonical(path)).collect()
}

/// Resolve the effective profile for a workspace.
///
/// Built-ins mirror Melody's profiles; a custom name is accepted only when
/// this module can express its rules.
pub(crate) fn resolve_profile(
    workspace: &Path,
    requested: Option<&str>,
) -> Result<Option<SandboxProfile>, String> {
    let Some(requested) = requested.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if matches!(requested.to_ascii_lowercase().as_str(), "off" | "none") {
        return Ok(None);
    }
    resolve_profile_with_environment(
        workspace,
        Some(requested),
        &ProfileEnvironment::from_process(),
    )
}

fn resolve_profile_with_environment(
    workspace: &Path,
    requested: Option<&str>,
    environment: &ProfileEnvironment,
) -> Result<Option<SandboxProfile>, String> {
    let Some(requested) = requested.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let workspace = canonical(workspace);
    let name = requested.to_ascii_lowercase();
    if matches!(name.as_str(), "off" | "none") {
        return Ok(None);
    }
    let mut read_write = vec![environment.state_dir.clone()];
    read_write.extend(temp_writable_paths(environment));
    let (read_write, read_only, deny, deny_globs, restrict_network) = match name.as_str() {
        "workspace" => {
            let mut read_write = read_write.clone();
            read_write.push(workspace.clone());
            (read_write, Vec::new(), Vec::new(), Vec::new(), false)
        }
        "devbox" => {
            let mut read_write = read_write.clone();
            read_write.push(workspace.clone());
            (read_write, Vec::new(), Vec::new(), Vec::new(), false)
        }
        // These profiles also restrict child networking, which the Host
        // sandbox does not implement; the caller must keep its compatibility
        // engine instead of weakening the requested policy.
        "read-only" | "readonly" | "strict" => {
            (read_write.clone(), Vec::new(), Vec::new(), Vec::new(), true)
        }
        custom => {
            let entry = load_custom_profile(workspace.as_path(), custom, environment)?;
            let (deny_paths, deny_globs) =
                split_deny(&entry.deny, &workspace, &environment.home_for_tilde);
            let mut read_write = read_write.clone();
            for path in &entry.read_write {
                let candidate = PathBuf::from(path);
                read_write.push(if candidate.is_absolute() {
                    canonical(&candidate)
                } else {
                    canonical(&workspace.join(candidate))
                });
            }
            let read_only_paths = entry
                .read_only
                .iter()
                .map(|path| {
                    let candidate = PathBuf::from(path);
                    if candidate.is_absolute() {
                        canonical(&candidate)
                    } else {
                        canonical(&workspace.join(candidate))
                    }
                })
                .collect::<Vec<_>>();
            (
                read_write,
                read_only_paths,
                deny_paths,
                deny_globs,
                entry.restrict_network.unwrap_or(false),
            )
        }
    };
    Ok(Some(SandboxProfile {
        name: requested.to_string(),
        read_write: path_strings(&read_write),
        read_only: path_strings(&read_only),
        deny,
        deny_globs,
        restrict_network,
    }))
}

#[derive(Debug, Default, serde::Deserialize)]
struct CustomProfileEntry {
    #[serde(default)]
    read_only: Vec<String>,
    #[serde(default)]
    read_write: Vec<String>,
    #[serde(default)]
    deny: Vec<String>,
    #[serde(default)]
    restrict_network: Option<bool>,
}

#[derive(Debug, Default, serde::Deserialize)]
struct SandboxConfigFile {
    #[serde(default)]
    profiles: std::collections::HashMap<String, CustomProfileEntry>,
}

fn load_config_file(path: &Path) -> Option<SandboxConfigFile> {
    let content = std::fs::read_to_string(path).ok()?;
    toml::from_str(&content).ok()
}

/// Load a custom profile from the user config and then the workspace config.
///
/// A workspace may add names, but cannot replace a user profile whose rules
/// could carry enterprise restrictions.
fn load_custom_profile(
    workspace: &Path,
    name: &str,
    environment: &ProfileEnvironment,
) -> Result<CustomProfileEntry, String> {
    let user_config =
        load_config_file(&environment.state_dir.join("sandbox.toml")).unwrap_or_default();
    if let Some(entry) = user_config.profiles.get(name) {
        return Ok(entry_clone(entry));
    }
    let project_config =
        load_config_file(&workspace.join(".melody").join("sandbox.toml")).unwrap_or_default();
    if let Some(entry) = project_config.profiles.get(name) {
        return Ok(entry_clone(entry));
    }
    Err(format!(
        "sandbox profile '{name}' is not defined by sandbox.toml and is not a built-in profile"
    ))
}

fn entry_clone(entry: &CustomProfileEntry) -> CustomProfileEntry {
    CustomProfileEntry {
        read_only: entry.read_only.clone(),
        read_write: entry.read_write.clone(),
        deny: entry.deny.clone(),
        restrict_network: entry.restrict_network,
    }
}
