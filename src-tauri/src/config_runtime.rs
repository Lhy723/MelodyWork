use std::{
    env, fs,
    path::{Path, PathBuf},
};

use serde::Serialize;

const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MelodyConfigDocument {
    scope: String,
    path: String,
    exists: bool,
    content: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MelodyExtension {
    kind: String,
    name: String,
    path: String,
    scope: String,
}

fn melody_home() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("MELODY_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    let home = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .ok_or_else(|| "Could not locate the user home directory".to_string())?;
    Ok(PathBuf::from(home).join(".melody"))
}

fn project_melody_root(cwd: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(cwd);
    if !root.is_dir() {
        return Err(format!("Workspace does not exist: {}", root.display()));
    }
    Ok(root.join(".melody"))
}

fn config_path(scope: &str, cwd: &str) -> Result<PathBuf, String> {
    match scope {
        "user" => Ok(melody_home()?.join("config.toml")),
        "project" => Ok(project_melody_root(cwd)?.join("config.toml")),
        _ => Err("Config scope must be user or project".to_string()),
    }
}

#[tauri::command]
pub fn read_melody_config(scope: String, cwd: String) -> Result<MelodyConfigDocument, String> {
    let path = config_path(&scope, &cwd)?;
    let exists = path.is_file();
    let content = if exists {
        let metadata = path
            .metadata()
            .map_err(|error| format!("Failed to inspect config: {error}"))?;
        if metadata.len() > MAX_CONFIG_BYTES {
            return Err("Melody config is larger than the 1 MB editor limit".to_string());
        }
        fs::read_to_string(&path)
            .map_err(|error| format!("Melody config is not valid UTF-8 text: {error}"))?
    } else {
        String::new()
    };
    Ok(MelodyConfigDocument {
        scope,
        path: path.to_string_lossy().into_owned(),
        exists,
        content,
    })
}

#[tauri::command]
pub fn write_melody_config(scope: String, cwd: String, content: String) -> Result<(), String> {
    if content.len() as u64 > MAX_CONFIG_BYTES {
        return Err("Melody config is larger than the 1 MB editor limit".to_string());
    }
    let path = config_path(&scope, &cwd)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Melody config has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create Melody config directory: {error}"))?;
    fs::write(&path, content).map_err(|error| format!("Failed to write Melody config: {error}"))
}

fn scan_kind(root: &Path, scope: &str, kind: &str, extensions: &mut Vec<MelodyExtension>) {
    let directory = root.join(kind);
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let valid = if kind == "hooks" {
            path.is_file() || path.is_dir()
        } else {
            path.is_dir()
        };
        if !valid {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        extensions.push(MelodyExtension {
            kind: kind.to_string(),
            name,
            path: path.to_string_lossy().into_owned(),
            scope: scope.to_string(),
        });
    }
}

#[tauri::command]
pub fn list_melody_extensions(cwd: String) -> Result<Vec<MelodyExtension>, String> {
    let user_root = melody_home()?;
    let project_root = project_melody_root(&cwd)?;
    let mut extensions = Vec::new();
    for (scope, root) in [("user", user_root), ("project", project_root)] {
        for kind in ["skills", "plugins", "hooks"] {
            scan_kind(&root, scope, kind, &mut extensions);
        }
    }
    extensions.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then(left.name.cmp(&right.name))
            .then(left.scope.cmp(&right.scope))
    });
    Ok(extensions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_supported_extension_directories() {
        let root = env::temp_dir().join(format!("melody-work-config-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("skills/review")).unwrap();
        fs::create_dir_all(root.join("plugins/git-tools")).unwrap();
        fs::create_dir_all(root.join("hooks")).unwrap();
        fs::write(root.join("hooks/after-tool.sh"), "#!/bin/sh").unwrap();

        let mut extensions = Vec::new();
        for kind in ["skills", "plugins", "hooks"] {
            scan_kind(&root, "project", kind, &mut extensions);
        }

        assert_eq!(extensions.len(), 3);
        assert!(extensions.iter().any(|item| item.name == "review"));
        assert!(extensions.iter().any(|item| item.name == "git-tools"));
        assert!(extensions.iter().any(|item| item.name == "after-tool.sh"));
        fs::remove_dir_all(root).unwrap();
    }
}
