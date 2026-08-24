use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

use uuid::Uuid;

/// Owns bounded UTF-8 reads and replacement writes for Melody configuration
/// files. Keeping this boundary in one place prevents individual commands from
/// accidentally using different size limits or partial-write behavior.
pub(crate) struct TextFileStore {
    path: PathBuf,
    max_bytes: u64,
    limit_description: &'static str,
}

pub(crate) fn remove_directory(path: &Path, label: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Failed to inspect {label}: {error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(format!("{label} is not a real directory"));
    }
    fs::remove_dir_all(path).map_err(|error| format!("Failed to delete {label}: {error}"))
}

impl TextFileStore {
    pub(crate) fn with_limit_description(
        path: impl Into<PathBuf>,
        max_bytes: u64,
        limit_description: &'static str,
    ) -> Self {
        Self {
            path: path.into(),
            max_bytes,
            limit_description,
        }
    }

    pub(crate) fn exists(&self) -> bool {
        self.path.is_file()
    }

    pub(crate) fn read_text(&self, label: &str) -> Result<Option<String>, String> {
        if !self.exists() {
            return Ok(None);
        }
        let metadata = self
            .path
            .metadata()
            .map_err(|error| format!("Failed to inspect {label}: {error}"))?;
        if metadata.len() > self.max_bytes {
            return Err(self.size_error(label));
        }
        let bytes =
            fs::read(&self.path).map_err(|error| format!("Failed to read {label}: {error}"))?;
        if bytes.len() as u64 > self.max_bytes {
            return Err(self.size_error(label));
        }
        String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| format!("{label} is not valid UTF-8 text"))
    }

    pub(crate) fn write_text(&self, content: &str, label: &str) -> Result<(), String> {
        if content.len() as u64 > self.max_bytes {
            return Err(self.size_error(label));
        }
        let parent = self
            .path
            .parent()
            .ok_or_else(|| format!("{label} has no parent directory"))?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {label} directory: {error}"))?;

        let temporary = parent.join(format!(
            ".{}.{}.tmp",
            self.path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("config"),
            Uuid::new_v4()
        ));
        let existing_permissions = fs::metadata(&self.path)
            .ok()
            .map(|metadata| metadata.permissions());
        let result = (|| {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)
                .map_err(|error| {
                    io::Error::new(error.kind(), format!("create temporary file: {error}"))
                })?;
            file.write_all(content.as_bytes())?;
            file.sync_all()?;
            if let Some(permissions) = existing_permissions {
                fs::set_permissions(&temporary, permissions)?;
            }
            replace_file(&temporary, &self.path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result.map_err(|error| format!("Failed to write {label}: {error}"))
    }

    fn size_error(&self, label: &str) -> String {
        format!("{label} is larger than {}", self.limit_description)
    }
}

#[cfg(windows)]
fn replace_file(temporary: &Path, target: &Path) -> io::Result<()> {
    if target.exists() {
        fs::remove_file(target)?;
    }
    fs::rename(temporary, target)
}

#[cfg(not(windows))]
fn replace_file(temporary: &Path, target: &Path) -> io::Result<()> {
    fs::rename(temporary, target)
}

#[cfg(test)]
mod tests {
    use super::TextFileStore;
    use std::{fs, path::PathBuf};
    use uuid::Uuid;

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("melody-work-config-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn bounded_store_round_trips_utf8_and_leaves_no_temp_file() {
        let root = temp_root();
        let path = root.join("config.toml");
        let store = TextFileStore::with_limit_description(&path, 1024, "the 1024 byte limit");

        assert_eq!(store.read_text("Test config").unwrap(), None);
        store
            .write_text("[plugins]\nenabled = [\"review\"]\n", "Test config")
            .unwrap();
        assert_eq!(
            store.read_text("Test config").unwrap(),
            Some("[plugins]\nenabled = [\"review\"]\n".to_string())
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bounded_store_rejects_oversized_and_invalid_utf8_content() {
        let root = temp_root();
        let oversized = TextFileStore::with_limit_description(
            root.join("oversized.toml"),
            4,
            "the 4 byte limit",
        );
        assert!(
            oversized
                .write_text("12345", "Test config")
                .unwrap_err()
                .contains("larger than the 4 byte limit")
        );

        let invalid_path = root.join("invalid.toml");
        fs::write(&invalid_path, [0xff, 0xfe]).unwrap();
        let invalid = TextFileStore::with_limit_description(invalid_path, 4, "the 4 byte limit");
        assert!(
            invalid
                .read_text("Test config")
                .unwrap_err()
                .contains("not valid UTF-8")
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn directory_removal_requires_a_real_directory() {
        let root = temp_root();
        let directory = root.join("skill");
        fs::create_dir(&directory).unwrap();

        super::remove_directory(&directory, "Test skill").unwrap();

        assert!(!directory.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn directory_removal_rejects_symlinks() {
        let root = temp_root();
        let target = root.join("target");
        let link = root.join("skill");
        fs::create_dir(&target).unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        assert!(
            super::remove_directory(&link, "Test skill")
                .unwrap_err()
                .contains("not a real directory")
        );
        assert!(target.is_dir());

        fs::remove_file(link).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
