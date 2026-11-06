//! Bounded and root-scoped filesystem operations for installed Marketplace plugins.
//!
//! The command owner coordinates these operations with registry persistence;
//! this module owns the filesystem safety rules for staged copies and removal.

use std::{
    env, fs,
    path::{Path, PathBuf},
};

use uuid::Uuid;

use super::marketplace_catalog::validate_relative_path;

const MAX_COPY_ENTRIES: usize = 20_000;
const MAX_COPY_BYTES: u64 = 256 * 1024 * 1024;

pub(super) struct CleanupDirectory(PathBuf);

impl CleanupDirectory {
    pub(super) fn create(prefix: &str) -> Result<Self, String> {
        let path = env::temp_dir().join(format!("{prefix}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path)
            .map_err(|error| format!("Could not create temporary plugin directory: {error}"))?;
        Ok(Self(path))
    }

    pub(super) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for CleanupDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(super) fn copy_directory_safely(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("Could not inspect plugin source: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Plugin source must be a real directory, not a symlink".to_string());
    }
    let canonical = source
        .canonicalize()
        .map_err(|error| format!("Could not resolve plugin source: {error}"))?;
    let mut files = 0usize;
    let mut bytes = 0u64;
    copy_directory_contents(&canonical, destination, &mut files, &mut bytes)
}

fn copy_directory_contents(
    source: &Path,
    destination: &Path,
    files: &mut usize,
    bytes: &mut u64,
) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|error| format!("Could not create plugin installation directory: {error}"))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("Could not read plugin source: {error}"))?
        .flatten()
    {
        *files += 1;
        if *files > MAX_COPY_ENTRIES {
            return Err("Plugin source has too many files to install safely".to_string());
        }
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path)
            .map_err(|error| format!("Could not inspect plugin source entry: {error}"))?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            copy_directory_contents(&source_path, &destination_path, files, bytes)?;
        } else if metadata.is_file() {
            *bytes = bytes.saturating_add(metadata.len());
            if *bytes > MAX_COPY_BYTES {
                return Err("Plugin source exceeds the 256 MB installation limit".to_string());
            }
            fs::copy(&source_path, &destination_path)
                .map_err(|error| format!("Could not copy plugin file: {error}"))?;
        }
    }
    Ok(())
}

pub(super) fn replace_installed_directory(
    install_dir: &Path,
    target: &Path,
    staging: &Path,
) -> Result<Option<PathBuf>, String> {
    let root = install_dir
        .canonicalize()
        .map_err(|error| format!("Could not resolve plugin install directory: {error}"))?;
    let target_parent = target
        .parent()
        .ok_or_else(|| "Plugin install path has no parent".to_string())?;
    if target_parent.canonicalize().ok().as_deref() != Some(root.as_path()) {
        return Err(
            "Plugin install path must be a direct child of the install directory".to_string(),
        );
    }
    if target.exists() {
        let backup = install_dir.join(format!(".backup-{}", Uuid::new_v4()));
        fs::rename(target, &backup).map_err(|error| {
            format!("Could not preserve the existing plugin before update: {error}")
        })?;
        if let Err(error) = fs::rename(staging, target) {
            let _ = fs::rename(&backup, target);
            return Err(format!("Could not activate updated plugin files: {error}"));
        }
        Ok(Some(backup))
    } else {
        fs::rename(staging, target)
            .map_err(|error| format!("Could not activate plugin files: {error}"))?;
        Ok(None)
    }
}

pub(super) fn remove_managed_path(root: &Path, path: &Path) -> Result<(), String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Could not resolve plugin install directory: {error}"))?;
    if path
        .parent()
        .and_then(|parent| parent.canonicalize().ok())
        .as_deref()
        != Some(canonical_root.as_path())
    {
        return Err("Refusing to remove a plugin path outside its install directory".to_string());
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect installed plugin: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        fs::remove_file(path).map_err(|error| format!("Could not remove installed plugin: {error}"))
    } else {
        fs::remove_dir_all(path)
            .map_err(|error| format!("Could not remove installed plugin: {error}"))
    }
}

pub(super) fn remove_managed_subpath(root: &Path, relative: &str) -> Result<(), String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Could not resolve plugin install directory: {error}"))?;
    let relative = validate_relative_path(relative)?;
    let path = root.join(relative);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("Could not inspect installed plugin: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return fs::remove_file(path)
            .map_err(|error| format!("Could not remove installed plugin: {error}"));
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Could not resolve installed plugin: {error}"))?;
    if !canonical.starts_with(&canonical_root) {
        return Err("Refusing to remove a plugin path outside its install directory".to_string());
    }
    fs::remove_dir_all(canonical)
        .map_err(|error| format!("Could not remove installed plugin: {error}"))
}

pub(super) fn remove_plugin_data(root: &Path, name: &str) -> Result<(), String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Ok(());
    }
    let path = root.join(name);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            fs::remove_file(path).map_err(|error| format!("Could not remove plugin data: {error}"))
        }
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path)
            .map_err(|error| format!("Could not remove plugin data: {error}")),
        Ok(_) => {
            fs::remove_file(path).map_err(|error| format!("Could not remove plugin data: {error}"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not inspect plugin data: {error}")),
    }
}
