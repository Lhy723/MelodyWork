use std::path::{Path, PathBuf};

use super::{
    expand_path,
    marketplace_catalog::{manifest_value, plugin_metadata, scan_marketplace},
    marketplace_registry::resolve_existing_plugin_directory,
    marketplace_transport::{validate_git_ref, validate_git_sha, validate_git_url},
};

pub(super) enum DirectPluginSource {
    Local {
        path: PathBuf,
    },
    Git {
        url: String,
        git_ref: Option<String>,
        git_sha: Option<String>,
        subdir: Option<String>,
    },
}

pub(super) fn parse_direct_source(input: &str, cwd: &Path) -> Result<DirectPluginSource, String> {
    let input = input.trim();
    if input.is_empty() || input.len() > 4096 {
        return Err("Plugin source is empty or too long".to_string());
    }
    let (input, subdir) = match input.rsplit_once('#') {
        Some((input, subdir)) if !subdir.is_empty() => (input, Some(subdir.to_string())),
        _ => (input, None),
    };
    let path_like = input.starts_with('/')
        || input.starts_with("./")
        || input.starts_with("../")
        || input.starts_with("~/")
        || input.starts_with('\\')
        || input.as_bytes().get(1) == Some(&b':');
    if path_like || cwd.join(input).is_dir() {
        let path = expand_path(input, cwd)?
            .canonicalize()
            .map_err(|error| format!("Plugin source path is unavailable: {error}"))?;
        if !path.is_dir() {
            return Err("Plugin source must be a directory".to_string());
        }
        let path = if let Some(subdir) = subdir {
            resolve_existing_plugin_directory(&path, &subdir)
                .ok_or_else(|| "Plugin source subdirectory is invalid".to_string())?
        } else {
            path
        };
        return Ok(DirectPluginSource::Local { path });
    }

    let mut url = input.to_string();
    let mut git_ref = None;
    if !input.starts_with("git@") {
        if let Some((base, reference)) = input.rsplit_once('@')
            && !reference.is_empty()
            && (base.contains("://") || base.matches('/').count() == 1)
        {
            url = base.to_string();
            git_ref = Some(reference.to_string());
        }
    }
    if !url.contains("://") && !url.starts_with("git@") && url.matches('/').count() == 1 {
        url = format!("https://github.com/{}.git", url.trim_end_matches(".git"));
    }
    validate_git_url(&url)?;
    if let Some(git_ref) = git_ref.as_deref() {
        validate_git_ref(git_ref)?;
    }
    let git_sha = git_ref
        .as_deref()
        .filter(|reference| validate_git_sha(reference).is_ok())
        .map(str::to_string);
    Ok(DirectPluginSource::Git {
        url,
        git_ref: if git_sha.is_some() { None } else { git_ref },
        git_sha,
        subdir,
    })
}

pub(super) fn detect_plugin_directory(
    root: &Path,
) -> Result<(PathBuf, String, Option<String>), String> {
    let root_manifest = manifest_value(root);
    if root_manifest.is_some()
        || ["skills", "agents", "hooks", ".mcp.json"]
            .iter()
            .any(|name| root.join(name).exists())
    {
        let fallback = root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("plugin");
        let metadata = plugin_metadata(root, fallback);
        return Ok((root.to_path_buf(), metadata.name, metadata.version));
    }
    let candidates = scan_marketplace(root, "local");
    match candidates.as_slice() {
        [candidate] => Ok((
            candidate
                .local_path
                .clone()
                .expect("local scanner candidates always have paths"),
            candidate.plugin.name.clone(),
            candidate.plugin.version.clone(),
        )),
        [] => {
            Err("No plugin was found. Select its directory or append #relative/path.".to_string())
        }
        _ => Err(
            "This source contains multiple plugins. Select one with #relative/path.".to_string(),
        ),
    }
}

pub(super) fn resolve_direct_git_plugin_path(
    repository_root: &Path,
    requested_subdir: Option<&str>,
) -> Result<(PathBuf, Option<String>), String> {
    if let Some(subdir) = requested_subdir {
        return resolve_existing_plugin_directory(repository_root, subdir)
            .map(|path| (path, Some(subdir.to_string())))
            .ok_or_else(|| "Plugin source subdirectory is invalid".to_string());
    }
    let canonical_root = repository_root
        .canonicalize()
        .map_err(|error| format!("Could not resolve plugin repository: {error}"))?;
    let (plugin_path, _, _) = detect_plugin_directory(&canonical_root)?;
    let detected_subdir = plugin_path
        .strip_prefix(&canonical_root)
        .ok()
        .filter(|path| !path.as_os_str().is_empty())
        .map(|path| path.to_string_lossy().replace('\\', "/"));
    Ok((plugin_path, detected_subdir))
}
