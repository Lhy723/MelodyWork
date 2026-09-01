use std::{
    fs,
    path::{Path, PathBuf},
};

use tauri::{AppHandle, State};
use toml_edit::Item;

use crate::config_io::remove_directory;
use crate::workspace_access::{WorkspaceRegistry, confirm_action};

use super::config_core::*;
use super::config_extensions::{inspect_skill_directory, run_melody_inspect};
use super::config_marketplace::read_user_config_document;

fn manifest_candidates(root: &Path) -> [PathBuf; 3] {
    [
        root.join("plugin.json"),
        root.join(".melody-plugin/plugin.json"),
        root.join(".claude-plugin/plugin.json"),
    ]
}

fn read_json_file(path: &Path) -> Option<serde_json::Value> {
    let metadata = path.metadata().ok()?;
    if metadata.len() > MAX_CONFIG_BYTES {
        return None;
    }
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn find_plugin_manifest(root: &Path, expected_name: &str) -> Option<(PathBuf, serde_json::Value)> {
    for candidate in manifest_candidates(root) {
        if let Some(value) = read_json_file(&candidate) {
            return Some((candidate, value));
        }
    }

    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut fallback = None;
    let mut visited = 0usize;
    while let Some((directory, depth)) = stack.pop() {
        if depth > 4 || visited >= 4096 {
            continue;
        }
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited >= 4096 {
                break;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !matches!(name.as_ref(), ".git" | "node_modules" | "target") {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            let relative = path.strip_prefix(root).ok()?.to_string_lossy();
            let manifest = relative == "plugin.json"
                || relative.ends_with("/.melody-plugin/plugin.json")
                || relative.ends_with("/.claude-plugin/plugin.json");
            if !manifest {
                continue;
            }
            let Some(value) = read_json_file(&path) else {
                continue;
            };
            if value.get("name").and_then(serde_json::Value::as_str) == Some(expected_name) {
                return Some((path, value));
            }
            fallback.get_or_insert((path, value));
        }
    }
    fallback
}

fn plugin_root_from_manifest(manifest_path: &Path) -> PathBuf {
    let Some(parent) = manifest_path.parent() else {
        return manifest_path.to_path_buf();
    };
    if parent
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == ".melody-plugin" || name == ".claude-plugin")
    {
        return parent.parent().unwrap_or(parent).to_path_buf();
    }
    parent.to_path_buf()
}

fn manifest_paths(value: Option<&serde_json::Value>, fallback: &str) -> Vec<String> {
    match value {
        Some(serde_json::Value::String(path)) => vec![path.clone()],
        Some(serde_json::Value::Array(paths)) => paths
            .iter()
            .filter_map(serde_json::Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => vec![fallback.to_string()],
    }
}

fn collect_skill_names(root: &Path, paths: Vec<String>) -> Vec<String> {
    let mut names = Vec::new();
    for relative in paths {
        let directory = root.join(relative);
        if directory.join("SKILL.md").is_file() {
            if let Some(name) = directory.file_name().and_then(|name| name.to_str()) {
                names.push(name.to_string());
            }
            continue;
        }
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && path.join("SKILL.md").is_file() {
                names.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
    }
    names.sort();
    names.dedup();
    names
}

fn collect_markdown_names(root: &Path, paths: Vec<String>) -> Vec<String> {
    let mut names = Vec::new();
    for relative in paths {
        let directory = root.join(relative);
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().and_then(|value| value.to_str()) == Some("md") {
                if let Some(name) = path.file_stem().and_then(|value| value.to_str()) {
                    names.push(name.to_string());
                }
            }
        }
    }
    names.sort();
    names.dedup();
    names
}

fn object_keys(value: Option<&serde_json::Value>, wrapper: &str) -> Vec<String> {
    let value = value.and_then(|value| value.get(wrapper).or(Some(value)));
    let mut keys = value
        .and_then(serde_json::Value::as_object)
        .map(|object| object.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    keys.sort();
    keys
}

fn component_json(
    root: &Path,
    manifest: &serde_json::Value,
    field: &str,
    fallback: &str,
) -> Option<serde_json::Value> {
    match manifest.get(field) {
        Some(value @ serde_json::Value::Object(_)) => Some(value.clone()),
        Some(serde_json::Value::String(relative)) => read_json_file(&root.join(relative)),
        _ => read_json_file(&root.join(fallback)),
    }
}

fn manifest_author(manifest: &serde_json::Value) -> Option<String> {
    match manifest.get("author") {
        Some(serde_json::Value::String(author)) => Some(author.clone()),
        Some(serde_json::Value::Object(author)) => author
            .get("name")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        _ => None,
    }
}

pub(crate) fn plugin_details_from_directory(root: &Path, expected_name: &str) -> PluginDetails {
    let found = find_plugin_manifest(root, expected_name);
    let (plugin_root, manifest_path, manifest) = if let Some((path, manifest)) = found {
        (
            plugin_root_from_manifest(&path),
            Some(path.to_string_lossy().into_owned()),
            manifest,
        )
    } else {
        (root.to_path_buf(), None, serde_json::json!({}))
    };
    let groups = vec![
        PluginComponentGroup {
            kind: "skills".to_string(),
            items: collect_skill_names(
                &plugin_root,
                manifest_paths(manifest.get("skills"), "skills"),
            ),
        },
        PluginComponentGroup {
            kind: "commands".to_string(),
            items: collect_markdown_names(
                &plugin_root,
                manifest_paths(manifest.get("commands"), "commands"),
            ),
        },
        PluginComponentGroup {
            kind: "agents".to_string(),
            items: collect_markdown_names(
                &plugin_root,
                manifest_paths(manifest.get("agents"), "agents"),
            ),
        },
        PluginComponentGroup {
            kind: "hooks".to_string(),
            items: object_keys(
                component_json(&plugin_root, &manifest, "hooks", "hooks/hooks.json").as_ref(),
                "hooks",
            ),
        },
        PluginComponentGroup {
            kind: "mcps".to_string(),
            items: object_keys(
                component_json(&plugin_root, &manifest, "mcpServers", ".mcp.json").as_ref(),
                "mcpServers",
            ),
        },
        PluginComponentGroup {
            kind: "lsps".to_string(),
            items: object_keys(
                component_json(&plugin_root, &manifest, "lspServers", ".lsp.json").as_ref(),
                "lspServers",
            ),
        },
    ];
    PluginDetails {
        name: manifest
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(expected_name)
            .to_string(),
        version: manifest
            .get("version")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        description: manifest
            .get("description")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        author: manifest_author(&manifest),
        homepage: manifest
            .get("homepage")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        repository: manifest
            .get("repository")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        license: manifest
            .get("license")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        path: plugin_root.to_string_lossy().into_owned(),
        manifest_path,
        components: groups,
    }
}

fn allowed_plugin_path(cwd: &str, path: &Path) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Plugin path is unavailable: {error}"))?;
    let workspace = PathBuf::from(cwd)
        .canonicalize()
        .map_err(|error| format!("Workspace is unavailable: {error}"))?;
    let mut roots = vec![
        melody_home()?,
        user_home()?.join(".claude"),
        workspace.join(".melody"),
        workspace.join(".claude"),
    ];
    if let Ok((_, document)) = read_user_config_document()
        && let Some(install_dir) = document
            .get("plugins")
            .and_then(Item::as_table)
            .and_then(|plugins| plugins.get("install_dir"))
            .and_then(Item::as_str)
    {
        let install_dir = install_dir
            .strip_prefix("~/")
            .map(|relative| user_home().map(|home| home.join(relative)))
            .unwrap_or_else(|| Ok(PathBuf::from(install_dir)))?;
        roots.push(install_dir);
    }
    roots.retain(|root| root.exists());
    if roots.iter().any(|root| {
        root.canonicalize()
            .ok()
            .is_some_and(|root| canonical.starts_with(root))
    }) {
        Ok(canonical)
    } else {
        Err("Plugin path is outside the allowed Melody and Claude directories".to_string())
    }
}

#[tauri::command]
pub fn get_melody_plugin_details(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    name: String,
    path: String,
) -> Result<PluginDetails, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    let root = allowed_plugin_path(&cwd, Path::new(&path))?;
    Ok(plugin_details_from_directory(&root, &name))
}

fn skill_frontmatter_value(content: &str, key: &str) -> Option<String> {
    let normalized = content.replace("\r\n", "\n");
    let frontmatter = normalized.strip_prefix("---\n")?.split_once("\n---\n")?.0;
    frontmatter.lines().find_map(|line| {
        let (candidate, value) = line.split_once(':')?;
        if candidate.trim() != key {
            return None;
        }
        let value = value.trim();
        if value.is_empty() || matches!(value, "|" | ">") {
            return None;
        }
        Some(
            value
                .trim_matches(|character| character == '"' || character == '\'')
                .to_string(),
        )
    })
}

fn collect_skill_files(root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((directory, depth)) = stack.pop() {
        if depth > 6 || files.len() >= 256 {
            continue;
        }
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                stack.push((path, depth + 1));
            } else if file_type.is_file()
                && let Ok(relative) = path.strip_prefix(root)
            {
                files.push(relative.to_string_lossy().into_owned());
            }
        }
    }
    files.sort();
    files.truncate(256);
    files
}

pub(crate) fn skill_details_from_directory(
    root: &Path,
    expected_name: &str,
) -> Result<SkillDetails, String> {
    let skill_path = root.join("SKILL.md");
    let metadata = skill_path
        .metadata()
        .map_err(|error| format!("Skill definition is unavailable: {error}"))?;
    if !metadata.is_file() {
        return Err("Skill directory does not contain SKILL.md".to_string());
    }
    if metadata.len() > MAX_CONFIG_BYTES {
        return Err("SKILL.md is larger than the 1 MB details limit".to_string());
    }
    let content = fs::read_to_string(&skill_path)
        .map_err(|error| format!("SKILL.md is not valid UTF-8 text: {error}"))?;
    Ok(SkillDetails {
        name: skill_frontmatter_value(&content, "name")
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| expected_name.to_string()),
        description: skill_frontmatter_value(&content, "description"),
        license: skill_frontmatter_value(&content, "license"),
        compatibility: skill_frontmatter_value(&content, "compatibility"),
        path: root.to_string_lossy().into_owned(),
        skill_path: skill_path.to_string_lossy().into_owned(),
        files: collect_skill_files(root),
        content,
    })
}

pub(crate) fn allowed_skill_path_in_roots(
    path: &Path,
    roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Skill path is unavailable: {error}"))?;
    let parent = canonical
        .parent()
        .ok_or_else(|| "Skill path has no parent directory".to_string())?;
    let allowed = roots.iter().any(|root| {
        root.canonicalize()
            .ok()
            .is_some_and(|root| parent == root && canonical.starts_with(root))
    });
    if !allowed {
        return Err("Skill path is outside the allowed Melody skill directories".to_string());
    }
    if !canonical.join("SKILL.md").is_file() {
        return Err("Skill directory does not contain SKILL.md".to_string());
    }
    Ok(canonical)
}

pub(crate) fn allowed_skill_path(cwd: &str, path: &Path) -> Result<PathBuf, String> {
    let workspace = PathBuf::from(cwd)
        .canonicalize()
        .map_err(|error| format!("Workspace is unavailable: {error}"))?;
    allowed_skill_path_in_roots(
        path,
        &[
            melody_home()?.join("skills"),
            workspace.join(".melody/skills"),
        ],
    )
}

#[tauri::command]
pub async fn get_melody_skill_details(
    app: AppHandle,
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    name: String,
    path: String,
) -> Result<SkillDetails, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    let root = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("Skill path is unavailable: {error}"))?;
    let document = run_melody_inspect(&app, &cwd).await?;
    let discovered = document.skills.iter().any(|skill| {
        skill
            .source
            .path
            .as_deref()
            .and_then(inspect_skill_directory)
            .and_then(|directory| directory.canonicalize().ok())
            .is_some_and(|directory| directory == root)
    });
    if !discovered {
        return Err("Skill is no longer present in Melody's runtime catalog".to_string());
    }
    skill_details_from_directory(&root, &name)
}

#[tauri::command]
pub async fn delete_melody_skill(
    app: AppHandle,
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    name: String,
    path: String,
) -> Result<String, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    let root = allowed_skill_path(&cwd, Path::new(&path))?;
    confirm_action(
        &app,
        "确认删除 Melody 技能",
        format!("允许删除技能目录 {} 吗？", root.display()),
    )
    .await?;
    remove_directory(&root, "skill")?;
    Ok(format!("Skill {} was deleted", name.trim()))
}
