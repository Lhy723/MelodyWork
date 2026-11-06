//! Stages a managed plugin snapshot and commits its filesystem and registry
//! state together, restoring the previous target if the registry commit fails.

use std::{fs, path::Path};

use serde_json::Value;
use uuid::Uuid;

use super::{
    marketplace_filesystem::{copy_directory_safely, replace_installed_directory},
    marketplace_registry::MarketplaceRegistry,
};

pub(super) struct MarketplaceInstallProvenance<'a> {
    pub(super) source_identity: &'a str,
    pub(super) source_name: &'a str,
    pub(super) plugin_subdir: &'a str,
}

pub(super) struct InstallSnapshotRequest<'a> {
    pub(super) install_dir: &'a Path,
    pub(super) key: &'a str,
    pub(super) source_root: &'a Path,
    pub(super) plugin_name: &'a str,
    pub(super) version: Option<&'a str>,
    pub(super) kind: Value,
    pub(super) provenance: Option<MarketplaceInstallProvenance<'a>>,
    pub(super) replace: bool,
}

pub(super) fn install_snapshot(request: InstallSnapshotRequest<'_>) -> Result<(), String> {
    let InstallSnapshotRequest {
        install_dir,
        key,
        source_root,
        plugin_name,
        version,
        kind,
        provenance,
        replace,
    } = request;
    fs::create_dir_all(install_dir)
        .map_err(|error| format!("Could not create plugin install directory: {error}"))?;
    let target = install_dir.join(key);
    if target.exists() && !replace {
        return Err(format!("Plugin installation already exists: {plugin_name}"));
    }
    let mut registry = MarketplaceRegistry::load(install_dir)?;
    let rollback = registry.prepare_install(key)?;
    let staging = install_dir.join(format!(".staging-{}", Uuid::new_v4()));
    if let Err(error) = copy_directory_safely(source_root, &staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    let provenance = provenance.map(|provenance| {
        (
            provenance.source_identity,
            provenance.source_name,
            provenance.plugin_subdir,
        )
    });
    registry.record_install(key, &target, plugin_name, version, kind, provenance)?;
    let backup = match replace_installed_directory(install_dir, &target, &staging) {
        Ok(backup) => backup,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
    };
    if let Err(error) = registry.save() {
        let _ = fs::remove_dir_all(&target);
        if let Some(backup) = backup.as_ref() {
            let _ = fs::rename(backup, &target);
        }
        registry.rollback_install(rollback);
        let _ = registry.save();
        return Err(error);
    }
    if let Some(backup) = backup {
        let _ = fs::remove_dir_all(backup);
    }
    Ok(())
}
