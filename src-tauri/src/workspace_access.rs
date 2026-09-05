use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
};

/// Renderer supplied paths are only accepted after the user has selected the
/// directory through the native picker or the path has been restored from the
/// trusted project database.  This registry is deliberately kept in Rust so a
/// compromised renderer cannot authorize an arbitrary new root by calling
/// `upsert_project` first.
#[derive(Clone, Default)]
pub struct WorkspaceRegistry {
    roots: Arc<RwLock<HashSet<PathBuf>>>,
    approved_config_paths: Arc<RwLock<HashSet<PathBuf>>>,
}

fn canonical_directory(path: &Path) -> Result<PathBuf, String> {
    if !path.is_dir() {
        return Err(format!(
            "Workspace directory does not exist: {}",
            path.display()
        ));
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Failed to resolve workspace directory: {error}"))?;
    if canonical.parent().is_none() {
        return Err("The filesystem root cannot be used as a workspace".to_string());
    }
    Ok(canonical)
}

fn is_within(root: &Path, candidate: &Path) -> bool {
    candidate == root || candidate.starts_with(root)
}

impl WorkspaceRegistry {
    /// Register a path that came from a native user selection or persisted
    /// project record.
    pub fn register(&self, path: &Path) -> Result<PathBuf, String> {
        let canonical = canonical_directory(path)?;
        self.roots
            .write()
            .map_err(|_| "Workspace registry lock poisoned".to_string())?
            .insert(canonical.clone());
        Ok(canonical)
    }

    /// Resolve a renderer supplied workspace path only if it is already
    /// covered by a registered project root.
    pub fn authorize(&self, path: &str) -> Result<PathBuf, String> {
        let canonical = canonical_directory(Path::new(path))?;
        let roots = self
            .roots
            .read()
            .map_err(|_| "Workspace registry lock poisoned".to_string())?;
        if roots.iter().any(|root| is_within(root, &canonical)) {
            return Ok(canonical);
        }
        Err(
            "Workspace is not authorized. Select it through the native workspace picker first."
                .to_string(),
        )
    }

    /// Check whether settings writes to a config file have already been
    /// approved during this application run.
    pub fn config_write_approved(&self, path: &Path) -> Result<bool, String> {
        self.approved_config_paths
            .read()
            .map_err(|_| "Config approval registry lock poisoned".to_string())
            .map(|paths| paths.contains(path))
    }

    /// Remember an approved config file so subsequent setting changes do not
    /// interrupt the user with another native confirmation dialog.
    pub fn approve_config_write(&self, path: PathBuf) -> Result<(), String> {
        self.approved_config_paths
            .write()
            .map_err(|_| "Config approval registry lock poisoned".to_string())?
            .insert(path);
        Ok(())
    }

    #[cfg(test)]
    fn clear(&self) {
        self.roots.write().unwrap().clear();
        self.approved_config_paths.write().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_registered_roots_and_descendants_are_authorized() {
        let root = std::env::temp_dir().join(format!("melody-access-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        let registry = WorkspaceRegistry::default();
        assert!(registry.authorize(root.to_str().unwrap()).is_err());
        let canonical = registry.register(&root).unwrap();
        assert_eq!(
            registry.authorize(root.to_str().unwrap()).unwrap(),
            canonical
        );
        assert!(
            registry
                .authorize(root.join("src").to_str().unwrap())
                .is_ok()
        );
        assert!(registry.authorize("/").is_err());
        registry.clear();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn config_write_approval_is_scoped_to_each_path() {
        let registry = WorkspaceRegistry::default();
        let user_config = PathBuf::from("/tmp/melody-user-config.toml");
        let project_config = PathBuf::from("/tmp/melody-project-config.toml");

        assert!(!registry.config_write_approved(&user_config).unwrap());
        registry.approve_config_write(user_config.clone()).unwrap();
        assert!(registry.config_write_approved(&user_config).unwrap());
        assert!(!registry.config_write_approved(&project_config).unwrap());
    }
}
