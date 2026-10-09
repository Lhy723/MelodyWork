use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use tauri::State;
use toml_edit::Item;

use crate::config_io::remove_directory;
use crate::workspace_access::WorkspaceRegistry;

use super::config_core::*;
use super::config_extensions::pi_skill_catalog_paths;
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
    if let Some((path, value)) = direct_plugin_manifest(root) {
        return Some((path, value));
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

fn direct_plugin_manifest(root: &Path) -> Option<(PathBuf, serde_json::Value)> {
    manifest_candidates(root).into_iter().find_map(|candidate| {
        let relative = candidate.strip_prefix(root).ok()?.to_string_lossy();
        let path = safe_plugin_path(root, &relative, false)?;
        let value = read_json_file(&path)?;
        value.is_object().then_some((path, value))
    })
}

/// Resolve a plugin-owned path without following symlinks or allowing it to
/// escape the plugin root. Plugin manifests are untrusted input: even a
/// read-only inventory must not expose files outside the package to the
/// renderer/worker.
fn safe_plugin_path(root: &Path, relative: &str, directory: bool) -> Option<PathBuf> {
    let relative = relative.trim();
    if relative.is_empty() {
        return None;
    }
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return None;
    }
    let root_metadata = fs::symlink_metadata(root).ok()?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return None;
    }
    let canonical_root = root.canonicalize().ok()?;
    let mut current = root.to_path_buf();
    for component in relative_path.components() {
        // `./` is a harmless relative prefix that plugin manifests commonly
        // use; only components that can escape the plugin root are rejected.
        let Component::Normal(name) = component else {
            continue;
        };
        current.push(name);
        let metadata = fs::symlink_metadata(&current).ok()?;
        if metadata.file_type().is_symlink() {
            return None;
        }
    }
    let metadata = fs::symlink_metadata(&current).ok()?;
    if directory && !metadata.is_dir() {
        return None;
    }
    if !directory && !metadata.is_file() {
        return None;
    }
    let canonical = current.canonicalize().ok()?;
    canonical.starts_with(&canonical_root).then_some(canonical)
}

fn safe_plugin_directory(root: &Path, relative: &str) -> Option<PathBuf> {
    safe_plugin_path(root, relative, true)
}

fn safe_plugin_json(root: &Path, relative: &str) -> Option<serde_json::Value> {
    let path = safe_plugin_path(root, relative, false)?;
    read_json_file(&path)
}

/// Return true when a direct manifest path exists but could not be loaded as a
/// regular JSON object. Such a package is kept on ACP rather than silently
/// projecting only a subset of its resources.
fn has_direct_manifest_file(root: &Path) -> bool {
    manifest_candidates(root)
        .iter()
        .any(|candidate| fs::symlink_metadata(candidate).is_ok())
}

fn manifest_directories_are_safe(root: &Path, value: Option<&serde_json::Value>) -> bool {
    let Some(value) = value else {
        return true;
    };
    match value {
        serde_json::Value::String(path) => safe_plugin_directory(root, path).is_some(),
        serde_json::Value::Array(paths) => paths.iter().all(|path| {
            path.as_str()
                .is_some_and(|path| safe_plugin_directory(root, path).is_some())
        }),
        _ => false,
    }
}

fn manifest_component_paths_are_safe(root: &Path, value: Option<&serde_json::Value>) -> bool {
    match value {
        Some(serde_json::Value::String(path)) => safe_plugin_path(root, path, false).is_some(),
        _ => true,
    }
}

fn has_unsafe_manifest_paths(root: &Path, manifest: &serde_json::Value) -> bool {
    ["skills", "commands", "agents"]
        .iter()
        .any(|field| !manifest_directories_are_safe(root, manifest.get(field)))
        || ["hooks", "mcpServers", "lspServers"]
            .iter()
            .any(|field| !manifest_component_paths_are_safe(root, manifest.get(field)))
}

fn safe_manifest_directories(
    root: &Path,
    value: Option<&serde_json::Value>,
    fallback: &str,
) -> Vec<PathBuf> {
    manifest_paths(value, fallback)
        .into_iter()
        .filter_map(|relative| safe_plugin_directory(root, &relative))
        .collect()
}

fn json_has_entries(value: Option<&serde_json::Value>) -> bool {
    match value {
        Some(serde_json::Value::Array(values)) => !values.is_empty(),
        Some(serde_json::Value::Object(values)) => !values.is_empty(),
        Some(serde_json::Value::String(value)) => !value.trim().is_empty(),
        Some(serde_json::Value::Bool(value)) => *value,
        Some(serde_json::Value::Number(_)) => true,
        _ => false,
    }
}

fn directory_has_entries(path: &Path) -> bool {
    fs::read_dir(path)
        .ok()
        .and_then(|mut entries| entries.next())
        .is_some()
}

fn convention_plugin_root(root: &Path) -> bool {
    [
        "skills",
        "commands",
        "agents",
        "hooks",
        ".mcp.json",
        ".lsp.json",
    ]
    .iter()
    .any(|name| {
        let path = root.join(name);
        fs::symlink_metadata(path)
            .map(|metadata| !metadata.file_type().is_symlink())
            .unwrap_or(false)
    })
}

/// Inspect a plugin directory without recursively searching its parent. This
/// is used by the Host resource scanner so a marketplace/cache directory is
/// never mistaken for a plugin merely because it contains a nested package.
pub(crate) fn plugin_capability_from_directory(
    root: &Path,
    scope: &str,
    enabled: bool,
) -> Option<MelodyPluginCapability> {
    let metadata = fs::symlink_metadata(root).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return None;
    }
    let canonical_root = root.canonicalize().ok()?;
    let direct_manifest = direct_plugin_manifest(root);
    let malformed_manifest = has_direct_manifest_file(root) && direct_manifest.is_none();
    let manifest = direct_manifest
        .map(|(_, value)| value)
        .or_else(|| convention_plugin_root(root).then(|| serde_json::json!({})))
        .or_else(|| malformed_manifest.then(|| serde_json::json!({})))?;

    let skill_directories = safe_manifest_directories(root, manifest.get("skills"), "skills");
    let prompt_directories = safe_manifest_directories(root, manifest.get("commands"), "commands");
    let agent_directories = safe_manifest_directories(root, manifest.get("agents"), "agents");
    let mut dynamic_components = Vec::new();
    if malformed_manifest {
        dynamic_components.push("manifest".to_string());
    } else if has_unsafe_manifest_paths(root, &manifest) {
        dynamic_components.push("resource-path".to_string());
    }
    // Only surfaces the Host would actually execute or spawn keep a plugin on
    // the compatibility engine: hooks run commands, MCP/LSP declarations start
    // processes, and manifest extensions are executable by definition.
    //
    // Everything else a plugin ships is declarative content: `skills/`,
    // `commands/` and `agents/` are Markdown that Pi loads as untrusted
    // material, and a `scripts/` or `bin/` directory is inert on its own --
    // Melody never runs plugin scripts directly, only through a hook that is
    // already detected here. A plugin is therefore projectable whenever it has
    // no hooks, MCP/LSP servers, extensions or unsafe manifest paths, even if
    // it ships helper scripts the model may later choose to run through the
    // permission-gated Host terminal.
    let component_json_fields = [
        ("hooks", "hooks/hooks.json"),
        ("mcpServers", ".mcp.json"),
        ("lspServers", ".lsp.json"),
    ];
    for (field, fallback) in component_json_fields {
        let component = component_json(&canonical_root, &manifest, field, fallback);
        if json_has_entries(component.as_ref()) {
            dynamic_components.push(field.to_string());
        }
    }
    for field in ["extensions", "extension"] {
        if json_has_entries(manifest.get(field)) {
            dynamic_components.push(field.to_string());
        }
    }
    let hooks_directory = canonical_root.join("hooks");
    if fs::symlink_metadata(&hooks_directory)
        .map(|metadata| !metadata.file_type().is_symlink() && metadata.is_dir())
        .unwrap_or(false)
        && directory_has_entries(&hooks_directory)
    {
        dynamic_components.push("hooks".to_string());
    }
    dynamic_components.sort();
    dynamic_components.dedup();

    let name = manifest
        .get("name")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .or_else(|| {
            canonical_root
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_string)
        })?;

    Some(MelodyPluginCapability {
        name,
        path: canonical_root.to_string_lossy().into_owned(),
        scope: scope.to_string(),
        enabled,
        static_resources: dynamic_components.is_empty(),
        dynamic_components,
        skill_roots: skill_directories
            .into_iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
        prompt_roots: prompt_directories
            .into_iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
        agent_roots: agent_directories
            .into_iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
    })
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
        let Some(directory) = safe_plugin_directory(root, &relative) else {
            continue;
        };
        if fs::symlink_metadata(directory.join("SKILL.md"))
            .map(|metadata| metadata.file_type().is_file())
            .unwrap_or(false)
        {
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
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir()
                && fs::symlink_metadata(path.join("SKILL.md"))
                    .map(|metadata| metadata.file_type().is_file())
                    .unwrap_or(false)
            {
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
        let Some(directory) = safe_plugin_directory(root, &relative) else {
            continue;
        };
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_file()
                && path.extension().and_then(|value| value.to_str()) == Some("md")
            {
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
        Some(serde_json::Value::String(relative)) => safe_plugin_json(root, relative),
        _ => safe_plugin_json(root, fallback),
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

pub(crate) fn skill_description_from_directory(root: &Path) -> Option<String> {
    let skill_path = root.join("SKILL.md");
    let metadata = fs::symlink_metadata(&skill_path).ok()?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_CONFIG_BYTES {
        return None;
    }
    let content = fs::read_to_string(skill_path).ok()?;
    skill_frontmatter_value(&content, "description")
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
    let skill_file = canonical.join("SKILL.md");
    if !fs::symlink_metadata(&skill_file)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false)
    {
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
pub fn get_melody_skill_details(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    name: String,
    path: String,
) -> Result<SkillDetails, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    let root = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("Skill path is unavailable: {error}"))?;
    let (active, disabled) = pi_skill_catalog_paths(&cwd)?;
    let discovered = active
        .iter()
        .chain(disabled.iter())
        .any(|directory| directory == &root);
    if !discovered {
        return Err("Skill is no longer present in Pi's skill catalog".to_string());
    }
    skill_details_from_directory(&root, &name)
}

#[tauri::command]
pub async fn delete_melody_skill(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    name: String,
    path: String,
) -> Result<String, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    let root = allowed_skill_path(&cwd, Path::new(&path))?;
    remove_directory(&root, "skill")?;
    Ok(format!("Skill {} was deleted", name.trim()))
}
