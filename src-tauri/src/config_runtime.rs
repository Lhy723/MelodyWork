use std::{
    collections::HashSet,
    env, fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use toml_edit::{Array, ArrayOfTables, DocumentMut, Item, Table, Value};

use crate::capability_lifecycle::{CapabilityKind, capability_name, change_capability_state};
use crate::config_io::{TextFileStore, remove_directory};
use crate::melody_command::MelodyCommandRunner;
use crate::workspace_access::{WorkspaceRegistry, confirm_action};

const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MelodyConfigDocument {
    scope: String,
    path: String,
    exists: bool,
    content: String,
    values: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    parse_error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MelodyConfigPatch {
    path: Vec<String>,
    value: serde_json::Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MelodyExtension {
    kind: String,
    name: String,
    path: String,
    scope: String,
    provider: String,
    managed: bool,
    enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    plugin_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_invocable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    compatibility_status: Option<String>,
    #[serde(default)]
    deletable: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceSource {
    name: String,
    kind: String,
    location: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallResult {
    source: String,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplacePlugin {
    name: String,
    marketplace: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    installed_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    skill_count: usize,
    has_hooks: bool,
    has_agents: bool,
    has_mcp: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginComponentGroup {
    kind: String,
    items: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDetails {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    homepage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    repository: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    license: Option<String>,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    manifest_path: Option<String>,
    components: Vec<PluginComponentGroup>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetails {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    license: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    compatibility: Option<String>,
    path: String,
    skill_path: String,
    files: Vec<String>,
    content: String,
}

#[derive(Clone, Debug, Deserialize)]
struct InstalledPluginEntry {
    status: String,
    name: String,
    path: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MelodyInspectDocument {
    #[serde(default)]
    skills: Vec<MelodyInspectSkill>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MelodyInspectSkill {
    name: String,
    #[serde(default)]
    description: Option<String>,
    source: MelodyInspectSkillSource,
    #[serde(default)]
    user_invocable: Option<bool>,
    #[serde(default)]
    vendor: Option<String>,
    #[serde(default)]
    disabled: bool,
    #[serde(default)]
    compatibility_status: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MelodyInspectSkillSource {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    path: Option<PathBuf>,
    #[serde(default)]
    plugin_name: Option<String>,
}

fn user_home() -> Result<PathBuf, String> {
    let home = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .ok_or_else(|| "Could not locate the user home directory".to_string())?;
    Ok(PathBuf::from(home))
}

fn melody_home() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("MELODY_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    Ok(user_home()?.join(".melody"))
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

fn config_document(
    scope: String,
    path: PathBuf,
    exists: bool,
    content: String,
) -> MelodyConfigDocument {
    let parsed = toml::from_str::<toml::Value>(&content);
    let (values, parse_error) = match parsed {
        Ok(value) => (
            serde_json::to_value(value).unwrap_or_else(|_| serde_json::json!({})),
            None,
        ),
        Err(_error) if content.trim().is_empty() => (serde_json::json!({}), None),
        Err(error) => (serde_json::json!({}), Some(error.to_string())),
    };
    MelodyConfigDocument {
        scope,
        path: path.to_string_lossy().into_owned(),
        exists,
        content,
        values,
        parse_error,
    }
}

#[tauri::command]
pub fn read_melody_config(
    registry: State<'_, WorkspaceRegistry>,
    scope: String,
    cwd: String,
) -> Result<MelodyConfigDocument, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    read_melody_config_inner(scope, cwd)
}

fn read_melody_config_inner(scope: String, cwd: String) -> Result<MelodyConfigDocument, String> {
    let path = config_path(&scope, &cwd)?;
    let store =
        TextFileStore::with_limit_description(&path, MAX_CONFIG_BYTES, "the 1 MB editor limit");
    let exists = store.exists();
    let content = store.read_text("Melody config")?.unwrap_or_default();
    Ok(config_document(scope, path, exists, content))
}

fn json_to_item(value: &serde_json::Value) -> Result<Item, String> {
    match value {
        serde_json::Value::Bool(value) => Ok(toml_edit::value(*value)),
        serde_json::Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                Ok(toml_edit::value(value))
            } else if let Some(value) = value.as_f64() {
                Ok(toml_edit::value(value))
            } else {
                Err("Configuration number is outside the supported range".to_string())
            }
        }
        serde_json::Value::String(value) => Ok(toml_edit::value(value)),
        serde_json::Value::Array(values) => {
            let mut array = Array::new();
            for value in values {
                match value {
                    serde_json::Value::Bool(value) => array.push(*value),
                    serde_json::Value::Number(value) if value.is_i64() => {
                        array.push(value.as_i64().unwrap())
                    }
                    serde_json::Value::Number(value) => {
                        array.push(value.as_f64().ok_or_else(|| {
                            "Configuration number is outside the supported range".to_string()
                        })?)
                    }
                    serde_json::Value::String(value) => array.push(value.as_str()),
                    _ => {
                        return Err(
                            "Only scalar values are supported in configuration arrays".to_string()
                        );
                    }
                }
            }
            Ok(Item::Value(Value::Array(array)))
        }
        serde_json::Value::Object(values) => {
            let mut table = Table::new();
            for (key, value) in values {
                if !value.is_null() {
                    table.insert(key, json_to_item(value)?);
                }
            }
            Ok(Item::Table(table))
        }
        serde_json::Value::Null => Ok(Item::None),
    }
}

fn apply_patch(document: &mut DocumentMut, patch: &MelodyConfigPatch) -> Result<(), String> {
    let Some((leaf, parents)) = patch.path.split_last() else {
        return Err("Configuration patch path cannot be empty".to_string());
    };
    let mut table = document.as_table_mut();
    for key in parents {
        if !table.contains_key(key) {
            table.insert(key, Item::Table(Table::new()));
        }
        table = table
            .get_mut(key)
            .and_then(Item::as_table_mut)
            .ok_or_else(|| format!("Configuration path '{}' is not a table", key))?;
    }
    if patch.value.is_null() {
        table.remove(leaf);
    } else {
        table.insert(leaf, json_to_item(&patch.value)?);
    }
    Ok(())
}

#[tauri::command]
pub async fn update_melody_config(
    app: AppHandle,
    registry: State<'_, WorkspaceRegistry>,
    scope: String,
    cwd: String,
    patches: Vec<MelodyConfigPatch>,
) -> Result<MelodyConfigDocument, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    let path = config_path(&scope, &cwd)?;
    if !registry.config_write_approved(&path)? {
        confirm_action(
            &app,
            "确认修改 Melody 配置",
            format!(
                "允许修改 {} 范围的 Melody 配置吗？本次确认后，当前运行期间后续设置修改将不再重复询问。",
                scope
            ),
        )
        .await?;
        registry.approve_config_write(path)?;
    }
    update_melody_config_inner(scope, cwd, patches)
}

fn update_melody_config_inner(
    scope: String,
    cwd: String,
    patches: Vec<MelodyConfigPatch>,
) -> Result<MelodyConfigDocument, String> {
    let path = config_path(&scope, &cwd)?;
    let store =
        TextFileStore::with_limit_description(&path, MAX_CONFIG_BYTES, "the 1 MB editor limit");
    let content = store.read_text("Melody config")?.unwrap_or_default();
    let mut document = if content.trim().is_empty() {
        DocumentMut::new()
    } else {
        content
            .parse::<DocumentMut>()
            .map_err(|error| format!("Melody config contains invalid TOML: {error}"))?
    };
    for patch in &patches {
        apply_patch(&mut document, patch)?;
    }
    let updated_content = document.to_string();
    if updated_content.len() as u64 > MAX_CONFIG_BYTES {
        return Err("Melody config is larger than the 1 MB editor limit".to_string());
    }
    store.write_text(&updated_content, "Melody config")?;
    Ok(config_document(scope, path, true, updated_content))
}

fn scan_kind(
    root: &Path,
    scope: &str,
    kind: &str,
    provider: &str,
    disabled: &HashSet<String>,
    extensions: &mut Vec<MelodyExtension>,
) {
    let directory = root.join(kind);
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let valid = if kind == "hooks" {
            file_type.is_file() || file_type.is_dir()
        } else if kind == "skills" {
            file_type.is_dir() && path.join("SKILL.md").is_file()
        } else {
            file_type.is_dir()
        };
        if !valid {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let enabled = !disabled.contains(&name);
        extensions.push(MelodyExtension {
            kind: kind.to_string(),
            name,
            path: path.to_string_lossy().into_owned(),
            scope: scope.to_string(),
            provider: provider.to_string(),
            managed: false,
            enabled,
            description: None,
            source: None,
            plugin_name: None,
            user_invocable: None,
            compatibility_status: None,
            deletable: false,
        });
    }
}

fn extension_config_names(
    scope: &str,
    cwd: &str,
    kind: &str,
    field: &str,
) -> Result<HashSet<String>, String> {
    let document = read_melody_config_inner(scope.to_string(), cwd.to_string())?;
    Ok(document
        .values
        .get(kind)
        .and_then(serde_json::Value::as_object)
        .and_then(|section| section.get(field))
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_string)
        .collect())
}

#[tauri::command]
pub async fn set_melody_extension_enabled(
    app: AppHandle,
    registry: State<'_, WorkspaceRegistry>,
    scope: String,
    cwd: String,
    kind: String,
    name: String,
    enabled: bool,
) -> Result<MelodyConfigDocument, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    let kind = CapabilityKind::parse(&kind)?;
    let name = capability_name(&name)?;
    confirm_action(
        &app,
        "确认修改扩展状态",
        format!(
            "允许{}扩展 {} 吗？",
            if enabled { "启用" } else { "停用" },
            name
        ),
    )
    .await?;
    let config_key = kind.config_key();
    let disabled = extension_config_names(&scope, &cwd, config_key, "disabled")?;
    let explicitly_enabled = if kind == CapabilityKind::Plugin {
        extension_config_names(&scope, &cwd, config_key, "enabled")?
    } else {
        HashSet::new()
    };
    let update = change_capability_state(kind, name, enabled, disabled, explicitly_enabled);
    let mut patches = Vec::with_capacity(if kind == CapabilityKind::Plugin { 2 } else { 1 });
    patches.push(MelodyConfigPatch {
        path: vec![config_key.to_string(), "disabled".to_string()],
        value: serde_json::json!(update.disabled),
    });
    if let Some(explicitly_enabled) = update.explicitly_enabled {
        patches.push(MelodyConfigPatch {
            path: vec![config_key.to_string(), "enabled".to_string()],
            value: serde_json::json!(explicitly_enabled),
        });
    }
    update_melody_config_inner(scope, cwd, patches)
}

#[tauri::command]
pub fn list_melody_extensions(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
) -> Result<Vec<MelodyExtension>, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    let user_root = melody_home()?;
    let project_root = project_melody_root(&cwd)?;
    let mut extensions = Vec::new();
    for (scope, root) in [("user", user_root), ("project", project_root)] {
        for kind in ["skills", "plugins", "hooks"] {
            let disabled = if matches!(kind, "skills" | "plugins") {
                extension_config_names(scope, &cwd, kind, "disabled")?
            } else {
                HashSet::new()
            };
            scan_kind(&root, scope, kind, "melody", &disabled, &mut extensions);
        }
    }
    let user_claude_root = user_home()?.join(".claude");
    let project_claude_root = PathBuf::from(&cwd).join(".claude");
    for (scope, root) in [("user", user_claude_root), ("project", project_claude_root)] {
        let disabled = extension_config_names(scope, &cwd, "plugins", "disabled")?;
        scan_kind(
            &root,
            scope,
            "plugins",
            "claude",
            &disabled,
            &mut extensions,
        );
    }
    extensions.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then(left.name.cmp(&right.name))
            .then(left.scope.cmp(&right.scope))
            .then(left.provider.cmp(&right.provider))
    });
    Ok(extensions)
}

async fn run_melody_inspect(app: &AppHandle, cwd: &str) -> Result<MelodyInspectDocument, String> {
    let mut command =
        MelodyCommandRunner::new(app).command(&["inspect", "--json"], Some(Path::new(cwd)))?;
    let output = command
        .output()
        .await
        .map_err(|error| format!("Failed to inspect Melody skills: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("Melody inspection failed with status {}", output.status)
        } else {
            stderr
        });
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Melody returned an invalid inspection document: {error}"))
}

fn inspect_skill_directory(path: &Path) -> Option<PathBuf> {
    if path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md") {
        path.parent().map(Path::to_path_buf)
    } else if path.join("SKILL.md").is_file() {
        Some(path.to_path_buf())
    } else {
        None
    }
}

fn inspect_skill_provider(skill: &MelodyInspectSkill, directory: &Path) -> String {
    if let Some(vendor) = skill.vendor.as_deref() {
        return vendor.to_string();
    }
    if skill.source.kind == "plugin" {
        return "plugin".to_string();
    }
    let path = directory.to_string_lossy();
    if path.contains("/.agents/") || path.contains("\\.agents\\") {
        "agents".to_string()
    } else if path.contains("/.claude/") || path.contains("\\.claude\\") {
        "claude".to_string()
    } else if path.contains("/.cursor/") || path.contains("\\.cursor\\") {
        "cursor".to_string()
    } else {
        "melody".to_string()
    }
}

fn melody_skill_extensions(cwd: &str, document: MelodyInspectDocument) -> Vec<MelodyExtension> {
    let project = PathBuf::from(cwd).canonicalize().ok();
    document
        .skills
        .into_iter()
        .filter_map(|skill| {
            let source_path = skill.source.path.as_deref()?;
            let directory = inspect_skill_directory(source_path)?;
            let canonical = directory
                .canonicalize()
                .unwrap_or_else(|_| directory.clone());
            let scope = if matches!(skill.source.kind.as_str(), "local" | "repo" | "project")
                || project
                    .as_ref()
                    .is_some_and(|root| canonical.starts_with(root))
            {
                "project"
            } else {
                "user"
            };
            let compatibility_disabled = skill.compatibility_status.as_deref() == Some("disabled");
            let provider = inspect_skill_provider(&skill, &canonical);
            Some(MelodyExtension {
                kind: "skills".to_string(),
                name: skill.name,
                path: canonical.to_string_lossy().into_owned(),
                scope: scope.to_string(),
                provider,
                managed: matches!(skill.source.kind.as_str(), "plugin" | "server" | "bundled"),
                enabled: !skill.disabled && !compatibility_disabled,
                description: skill.description,
                source: Some(skill.source.kind),
                plugin_name: skill.source.plugin_name,
                user_invocable: skill.user_invocable,
                compatibility_status: skill.compatibility_status,
                deletable: allowed_skill_path(cwd, &canonical).is_ok(),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn list_melody_skills(
    app: AppHandle,
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
) -> Result<Vec<MelodyExtension>, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    let document = run_melody_inspect(&app, &cwd).await?;
    Ok(melody_skill_extensions(&cwd, document))
}

fn read_user_config_document() -> Result<(PathBuf, DocumentMut), String> {
    let path = melody_home()?.join("config.toml");
    let content =
        TextFileStore::with_limit_description(&path, MAX_CONFIG_BYTES, "the 1 MB editor limit")
            .read_text("Melody config")?
            .unwrap_or_default();
    let document = if content.trim().is_empty() {
        DocumentMut::new()
    } else {
        content
            .parse::<DocumentMut>()
            .map_err(|error| format!("Melody config contains invalid TOML: {error}"))?
    };
    Ok((path, document))
}

fn marketplace_sources(document: &DocumentMut) -> Result<Vec<MarketplaceSource>, String> {
    let Some(marketplace) = document.get("marketplace") else {
        return Ok(Vec::new());
    };
    let marketplace = marketplace
        .as_table()
        .ok_or_else(|| "[marketplace] must be a table".to_string())?;
    let Some(sources) = marketplace.get("sources") else {
        return Ok(Vec::new());
    };
    let sources = sources
        .as_array_of_tables()
        .ok_or_else(|| "[[marketplace.sources]] must be an array of tables".to_string())?;
    Ok(sources
        .iter()
        .filter_map(|entry| {
            let name = entry.get("name")?.as_str()?.to_string();
            if let Some(location) = entry.get("git").and_then(Item::as_str) {
                Some(MarketplaceSource {
                    name,
                    kind: "git".to_string(),
                    location: location.to_string(),
                    branch: entry
                        .get("branch")
                        .and_then(Item::as_str)
                        .map(str::to_string),
                })
            } else {
                entry
                    .get("path")
                    .and_then(Item::as_str)
                    .map(|location| MarketplaceSource {
                        name,
                        kind: "local".to_string(),
                        location: location.to_string(),
                        branch: None,
                    })
            }
        })
        .collect())
}

fn marketplace_sources_mut(document: &mut DocumentMut) -> Result<&mut ArrayOfTables, String> {
    let marketplace = document
        .entry("marketplace")
        .or_insert_with(|| Item::Table(Table::new()))
        .as_table_mut()
        .ok_or_else(|| "[marketplace] must be a table".to_string())?;
    marketplace
        .entry("sources")
        .or_insert_with(|| Item::ArrayOfTables(ArrayOfTables::new()))
        .as_array_of_tables_mut()
        .ok_or_else(|| "[[marketplace.sources]] must be an array of tables".to_string())
}

fn write_user_config(path: &Path, document: &DocumentMut) -> Result<(), String> {
    let content = document.to_string();
    TextFileStore::with_limit_description(path, MAX_CONFIG_BYTES, "the 1 MB editor limit")
        .write_text(&content, "Melody config")
}

fn validate_marketplace_source(source: &mut MarketplaceSource) -> Result<(), String> {
    source.name = source.name.trim().to_string();
    source.location = source.location.trim().to_string();
    source.branch = source
        .branch
        .take()
        .map(|branch| branch.trim().to_string())
        .filter(|branch| !branch.is_empty());
    if source.name.is_empty() {
        return Err("Marketplace name cannot be empty".to_string());
    }
    if source.location.is_empty() {
        return Err("Marketplace source cannot be empty".to_string());
    }
    if source.kind != "git" && source.kind != "local" {
        return Err("Marketplace kind must be git or local".to_string());
    }
    if source.kind == "local" {
        source.branch = None;
    }
    Ok(())
}

fn marketplace_source_from_input(input: &str) -> Result<MarketplaceSource, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("Marketplace link or path cannot be empty".to_string());
    }

    let windows_path = input
        .as_bytes()
        .get(1)
        .is_some_and(|separator| *separator == b':');
    let local = input.starts_with('/')
        || input.starts_with("./")
        || input.starts_with("../")
        || input.starts_with("~/")
        || input.starts_with('\\')
        || windows_path;

    let mut branch = None;
    let location = if local {
        input.to_string()
    } else if !input.contains("://")
        && !input.starts_with("git@")
        && input.matches('/').count() == 1
    {
        let (repository, parsed_branch) = input
            .rsplit_once('@')
            .map_or((input, None), |(repository, branch)| {
                (repository, (!branch.is_empty()).then_some(branch))
            });
        branch = parsed_branch.map(str::to_string);
        format!(
            "https://github.com/{}.git",
            repository.trim_end_matches(".git")
        )
    } else {
        input.to_string()
    };

    let name = location
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .rsplit(['/', '\\', ':'])
        .next()
        .unwrap_or_default()
        .trim()
        .to_string();
    if name.is_empty() {
        return Err("Could not infer a Marketplace name from this source".to_string());
    }

    Ok(MarketplaceSource {
        name,
        kind: if local { "local" } else { "git" }.to_string(),
        location,
        branch,
    })
}

#[tauri::command]
pub fn list_marketplace_sources() -> Result<Vec<MarketplaceSource>, String> {
    let (_, document) = read_user_config_document()?;
    marketplace_sources(&document)
}

#[tauri::command]
pub async fn add_marketplace_source(
    app: AppHandle,
    input: String,
) -> Result<Vec<MarketplaceSource>, String> {
    let source = marketplace_source_from_input(&input)?;
    confirm_action(
        &app,
        "确认添加 Marketplace",
        format!("允许将以下来源写入 Melody 配置吗？\n{}", source.location),
    )
    .await?;
    save_marketplace_source_inner(None, source)
}

#[tauri::command]
pub async fn save_marketplace_source(
    app: AppHandle,
    original_name: Option<String>,
    mut source: MarketplaceSource,
) -> Result<Vec<MarketplaceSource>, String> {
    validate_marketplace_source(&mut source)?;
    confirm_action(
        &app,
        "确认保存 Marketplace",
        format!("允许将 Marketplace {} 写入 Melody 配置吗？", source.name),
    )
    .await?;
    save_marketplace_source_inner(original_name, source)
}

fn save_marketplace_source_inner(
    original_name: Option<String>,
    mut source: MarketplaceSource,
) -> Result<Vec<MarketplaceSource>, String> {
    validate_marketplace_source(&mut source)?;
    let (path, mut document) = read_user_config_document()?;
    let sources = marketplace_sources_mut(&mut document)?;
    if sources.iter().any(|entry| {
        entry.get("name").and_then(Item::as_str) == Some(source.name.as_str())
            && original_name.as_deref() != Some(source.name.as_str())
    }) {
        return Err(format!(
            "A marketplace named '{}' already exists",
            source.name
        ));
    }
    let existing = original_name.as_deref().and_then(|name| {
        sources
            .iter()
            .position(|entry| entry.get("name").and_then(Item::as_str) == Some(name))
    });
    let mut entry = Table::new();
    entry["name"] = toml_edit::value(&source.name);
    match source.kind.as_str() {
        "git" => {
            entry["git"] = toml_edit::value(&source.location);
            if let Some(branch) = &source.branch {
                entry["branch"] = toml_edit::value(branch);
            }
        }
        "local" => entry["path"] = toml_edit::value(&source.location),
        _ => unreachable!("validated marketplace kind"),
    }
    if let Some(index) = existing {
        let existing_entry = sources
            .iter_mut()
            .nth(index)
            .expect("marketplace index came from this collection");
        *existing_entry = entry;
    } else {
        sources.push(entry);
    }
    write_user_config(&path, &document)?;
    marketplace_sources(&document)
}

#[tauri::command]
pub async fn delete_marketplace_source(
    app: AppHandle,
    name: String,
) -> Result<Vec<MarketplaceSource>, String> {
    confirm_action(
        &app,
        "确认删除 Marketplace",
        format!("允许从 Melody 配置删除 Marketplace {} 吗？", name.trim()),
    )
    .await?;
    let (path, mut document) = read_user_config_document()?;
    let sources = marketplace_sources_mut(&mut document)?;
    let index = sources
        .iter()
        .position(|entry| entry.get("name").and_then(Item::as_str) == Some(name.as_str()))
        .ok_or_else(|| format!("Marketplace '{}' was not found", name))?;
    sources.remove(index);
    write_user_config(&path, &document)?;
    marketplace_sources(&document)
}

#[tauri::command]
pub async fn install_melody_plugin(
    app: AppHandle,
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    source: String,
) -> Result<PluginInstallResult, String> {
    let source = source.trim();
    if source.is_empty() {
        return Err("Plugin source cannot be empty".to_string());
    }
    if source.len() > 4096 {
        return Err("Plugin source is too long".to_string());
    }
    let workspace = registry.authorize(&cwd)?;
    confirm_action(
        &app,
        "确认安装 Melody 插件",
        format!(
            "允许在 {} 以信任模式安装以下插件来源吗？\n{}",
            workspace.display(),
            source
        ),
    )
    .await?;
    let mut command = MelodyCommandRunner::new(&app)
        .command(&["plugin", "install", source, "--trust"], Some(&workspace))?;
    let output = command
        .output()
        .await
        .map_err(|error| format!("Failed to start Melody plugin installer: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(if stderr.is_empty() {
            if stdout.is_empty() {
                format!("Plugin installation failed with status {}", output.status)
            } else {
                stdout
            }
        } else {
            stderr
        });
    }
    let message = if stdout.is_empty() {
        format!("Plugin installed from {source}")
    } else {
        stdout
    };
    Ok(PluginInstallResult {
        source: source.to_string(),
        message,
    })
}

async fn run_plugin_command(app: &AppHandle, cwd: &str, args: &[&str]) -> Result<String, String> {
    let workspace = PathBuf::from(cwd);
    if !workspace.is_dir() {
        return Err(format!("Workspace does not exist: {}", workspace.display()));
    }
    let mut command = MelodyCommandRunner::new(app).command(args, Some(&workspace))?;
    let output = command
        .output()
        .await
        .map_err(|error| format!("Failed to run Melody plugin command: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(if stderr.is_empty() {
            if stdout.is_empty() {
                format!("Plugin command failed with status {}", output.status)
            } else {
                stdout
            }
        } else {
            stderr
        });
    }
    Ok(stdout)
}

#[tauri::command]
pub async fn scan_marketplace_plugins(
    app: AppHandle,
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    refresh: bool,
) -> Result<Vec<MarketplacePlugin>, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    if refresh {
        // Refreshing the catalog only reads the configured sources and
        // updates their local index; it is a routine settings action.
        run_plugin_command(&app, &cwd, &["plugin", "marketplace", "update"]).await?;
    }
    let output =
        run_plugin_command(&app, &cwd, &["plugin", "list", "--json", "--available"]).await?;
    marketplace_plugins_from_json(&output)
}

fn marketplace_plugins_from_json(output: &str) -> Result<Vec<MarketplacePlugin>, String> {
    let entries = serde_json::from_str::<Vec<serde_json::Value>>(output)
        .map_err(|error| format!("Melody returned an invalid Marketplace catalog: {error}"))?;
    Ok(entries
        .into_iter()
        .filter_map(|entry| {
            let status = entry.get("status")?.as_str()?;
            let marketplace = entry.get("marketplace")?.as_str()?.to_string();
            let name = entry.get("name")?.as_str()?.to_string();
            let version = entry
                .get("version")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            match status {
                "installed" => Some(MarketplacePlugin {
                    name,
                    marketplace,
                    status: "installed".to_string(),
                    version: None,
                    installed_version: version,
                    description: None,
                    skill_count: 0,
                    has_hooks: false,
                    has_agents: false,
                    has_mcp: false,
                }),
                "available" => Some(MarketplacePlugin {
                    name,
                    marketplace,
                    status: "available".to_string(),
                    version,
                    installed_version: None,
                    description: entry
                        .get("description")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string),
                    skill_count: entry
                        .get("skill_count")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0) as usize,
                    has_hooks: entry
                        .get("has_hooks")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                    has_agents: entry
                        .get("has_agents")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                    has_mcp: entry
                        .get("has_mcp")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                }),
                _ => None,
            }
        })
        .collect())
}

#[tauri::command]
pub async fn update_melody_plugin(
    app: AppHandle,
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    name: String,
) -> Result<PluginInstallResult, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Plugin name cannot be empty".to_string());
    }
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    confirm_action(
        &app,
        "确认更新 Melody 插件",
        format!("允许在 {} 更新插件 {} 吗？", cwd, name),
    )
    .await?;
    let message = run_plugin_command(&app, &cwd, &["plugin", "update", name]).await?;
    Ok(PluginInstallResult {
        source: name.to_string(),
        message: if message.is_empty() {
            format!("Plugin {name} is already up to date")
        } else {
            message
        },
    })
}

#[tauri::command]
pub async fn list_installed_melody_plugins(
    app: AppHandle,
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
) -> Result<Vec<MelodyExtension>, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    let mut command =
        MelodyCommandRunner::new(&app).command(&["plugin", "list", "--json"], None)?;
    let output = command
        .output()
        .await
        .map_err(|error| format!("Failed to list installed Melody plugins: {error}"))?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if error.is_empty() {
            format!("Plugin listing failed with status {}", output.status)
        } else {
            error
        });
    }
    let entries: Vec<InstalledPluginEntry> = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Melody returned an invalid plugin list: {error}"))?;
    let disabled = extension_config_names("user", &cwd, "plugins", "disabled")?;
    Ok(entries
        .into_iter()
        .filter(|entry| entry.status == "installed")
        .map(|entry| {
            let enabled = !disabled.contains(&entry.name);
            MelodyExtension {
                kind: "plugins".to_string(),
                name: entry.name,
                path: entry.path.to_string_lossy().into_owned(),
                scope: "user".to_string(),
                provider: "melody".to_string(),
                managed: true,
                enabled,
                description: None,
                source: Some("plugin".to_string()),
                plugin_name: None,
                user_invocable: None,
                compatibility_status: None,
                deletable: false,
            }
        })
        .collect())
}

#[tauri::command]
pub async fn uninstall_melody_plugin(
    app: AppHandle,
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
    name: String,
    keep_data: bool,
) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Plugin name cannot be empty".to_string());
    }
    let workspace = registry.authorize(&cwd)?;
    confirm_action(
        &app,
        "确认卸载 Melody 插件",
        format!(
            "允许从 {} 卸载插件 {} 吗？{}",
            workspace.display(),
            name,
            if keep_data {
                "（保留插件数据）"
            } else {
                ""
            }
        ),
    )
    .await?;
    let mut command = MelodyCommandRunner::new(&app).command(
        &["plugin", "uninstall", name, "--confirm"],
        Some(&workspace),
    )?;
    if keep_data {
        command.arg("--keep-data");
    }
    let output = command
        .output()
        .await
        .map_err(|error| format!("Failed to start Melody plugin uninstaller: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(if stderr.is_empty() {
            if stdout.is_empty() {
                format!("Plugin removal failed with status {}", output.status)
            } else {
                stdout
            }
        } else {
            stderr
        });
    }
    Ok(if stdout.is_empty() {
        format!("Plugin {name} was removed")
    } else {
        stdout
    })
}

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

fn plugin_details_from_directory(root: &Path, expected_name: &str) -> PluginDetails {
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

fn skill_details_from_directory(root: &Path, expected_name: &str) -> Result<SkillDetails, String> {
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

fn allowed_skill_path_in_roots(path: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
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

fn allowed_skill_path(cwd: &str, path: &Path) -> Result<PathBuf, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_supported_extension_directories() {
        let root = env::temp_dir().join(format!("melody-work-config-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("skills/review")).unwrap();
        fs::create_dir_all(root.join("plugins/git-tools")).unwrap();
        fs::create_dir_all(root.join("hooks")).unwrap();
        fs::write(root.join("skills/review/SKILL.md"), "# Review").unwrap();
        fs::write(root.join("hooks/after-tool.sh"), "#!/bin/sh").unwrap();

        let mut extensions = Vec::new();
        let disabled = HashSet::new();
        for kind in ["skills", "plugins", "hooks"] {
            scan_kind(&root, "project", kind, "melody", &disabled, &mut extensions);
        }

        assert_eq!(extensions.len(), 3);
        assert!(extensions.iter().any(|item| item.name == "review"));
        assert!(extensions.iter().any(|item| item.name == "git-tools"));
        assert!(extensions.iter().any(|item| item.name == "after-tool.sh"));
        assert!(extensions.iter().all(|item| item.provider == "melody"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scans_claude_compatible_plugins() {
        let root = env::temp_dir().join(format!("melody-work-claude-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("plugins/review-tools")).unwrap();

        let mut extensions = Vec::new();
        let disabled = HashSet::from(["review-tools".to_string()]);
        scan_kind(
            &root,
            "project",
            "plugins",
            "claude",
            &disabled,
            &mut extensions,
        );

        assert_eq!(extensions.len(), 1);
        assert_eq!(extensions[0].name, "review-tools");
        assert_eq!(extensions[0].provider, "claude");
        assert!(!extensions[0].enabled);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_git_and_local_marketplace_sources() {
        let document = r#"
[[marketplace.sources]]
name = "Team"
git = "https://example.com/plugins.git"
branch = "stable"

[[marketplace.sources]]
name = "Local"
path = "~/dev/plugins"
"#
        .parse::<DocumentMut>()
        .unwrap();

        let sources = marketplace_sources(&document).unwrap();

        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].kind, "git");
        assert_eq!(sources[0].branch.as_deref(), Some("stable"));
        assert_eq!(sources[1].kind, "local");
        assert_eq!(sources[1].location, "~/dev/plugins");
    }

    #[test]
    fn creates_marketplace_source_array_without_replacing_other_settings() {
        let mut document = "[marketplace]\nrequire_sha = true\n"
            .parse::<DocumentMut>()
            .unwrap();
        let sources = marketplace_sources_mut(&mut document).unwrap();
        let mut entry = Table::new();
        entry["name"] = toml_edit::value("Team");
        entry["git"] = toml_edit::value("https://example.com/plugins.git");
        sources.push(entry);

        let output = document.to_string();
        assert!(output.contains("require_sha = true"));
        assert!(output.contains("[[marketplace.sources]]"));
        assert!(output.contains("name = \"Team\""));
    }

    #[test]
    fn infers_marketplace_source_from_common_inputs() {
        let shorthand = marketplace_source_from_input("acme/team-plugins@stable").unwrap();
        assert_eq!(shorthand.name, "team-plugins");
        assert_eq!(shorthand.kind, "git");
        assert_eq!(
            shorthand.location,
            "https://github.com/acme/team-plugins.git"
        );
        assert_eq!(shorthand.branch.as_deref(), Some("stable"));

        let git = marketplace_source_from_input("https://example.com/acme/tools.git").unwrap();
        assert_eq!(git.name, "tools");
        assert_eq!(git.kind, "git");

        let local = marketplace_source_from_input("~/dev/plugins").unwrap();
        assert_eq!(local.name, "plugins");
        assert_eq!(local.kind, "local");
    }

    #[test]
    fn reads_plugin_metadata_and_component_inventory() {
        let root = env::temp_dir().join(format!("melody-work-plugin-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".claude-plugin")).unwrap();
        fs::create_dir_all(root.join("skills/review")).unwrap();
        fs::create_dir_all(root.join("commands")).unwrap();
        fs::create_dir_all(root.join("agents")).unwrap();
        fs::write(root.join("skills/review/SKILL.md"), "# Review").unwrap();
        fs::write(root.join("commands/check.md"), "# Check").unwrap();
        fs::write(root.join("agents/reviewer.md"), "# Reviewer").unwrap();
        fs::write(
            root.join(".claude-plugin/plugin.json"),
            serde_json::json!({
                "name": "team-tools",
                "version": "1.2.3",
                "description": "Team utilities",
                "author": { "name": "Acme" },
                "hooks": { "PreToolUse": [] },
                "mcpServers": { "github": { "command": "server" } },
                "lspServers": { "rust": { "command": "rust-analyzer" } }
            })
            .to_string(),
        )
        .unwrap();

        let details = plugin_details_from_directory(&root, "team-tools");

        assert_eq!(details.name, "team-tools");
        assert_eq!(details.version.as_deref(), Some("1.2.3"));
        assert_eq!(details.author.as_deref(), Some("Acme"));
        assert_eq!(details.components[0].items, ["review"]);
        assert_eq!(details.components[1].items, ["check"]);
        assert_eq!(details.components[2].items, ["reviewer"]);
        assert_eq!(details.components[3].items, ["PreToolUse"]);
        assert_eq!(details.components[4].items, ["github"]);
        assert_eq!(details.components[5].items, ["rust"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_skill_metadata_content_and_files() {
        let root = env::temp_dir().join(format!("melody-work-skill-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("references")).unwrap();
        fs::write(
            root.join("SKILL.md"),
            "---\nname: review\ndescription: Review code safely\nlicense: MIT\ncompatibility: Melody 0.0.1+\n---\n\n# Review\n",
        )
        .unwrap();
        fs::write(root.join("references/checklist.md"), "# Checklist").unwrap();

        let details = skill_details_from_directory(&root, "fallback").unwrap();

        assert_eq!(details.name, "review");
        assert_eq!(details.description.as_deref(), Some("Review code safely"));
        assert_eq!(details.license.as_deref(), Some("MIT"));
        assert_eq!(details.compatibility.as_deref(), Some("Melody 0.0.1+"));
        assert!(details.content.contains("# Review"));
        assert_eq!(details.files, ["SKILL.md", "references/checklist.md"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn maps_runtime_skill_catalog_with_sources_and_status() {
        let root = env::temp_dir().join(format!(
            "melody-work-runtime-skills-{}",
            uuid::Uuid::new_v4()
        ));
        let local = root.join(".melody/skills/review");
        let plugin = root.join(".claude/plugins/cache/team/skills/check");
        fs::create_dir_all(&local).unwrap();
        fs::create_dir_all(&plugin).unwrap();
        fs::write(local.join("SKILL.md"), "# Review").unwrap();
        fs::write(plugin.join("SKILL.md"), "# Check").unwrap();
        let document: MelodyInspectDocument = serde_json::from_value(serde_json::json!({
            "skills": [
                {
                    "name": "review",
                    "description": "Review changes",
                    "source": {
                        "type": "local",
                        "path": local.join("SKILL.md"),
                    },
                    "userInvocable": true
                },
                {
                    "name": "team:check",
                    "source": {
                        "type": "plugin",
                        "plugin_name": "team",
                        "path": plugin.join("SKILL.md"),
                    },
                    "vendor": "claude",
                    "disabled": true,
                    "compatibilityStatus": "disabled"
                }
            ]
        }))
        .unwrap();

        let skills = melody_skill_extensions(root.to_str().unwrap(), document);

        assert_eq!(skills.len(), 2);
        assert_eq!(skills[0].name, "review");
        assert_eq!(skills[0].scope, "project");
        assert_eq!(skills[0].provider, "melody");
        assert!(skills[0].enabled);
        assert!(skills[0].deletable);
        assert_eq!(skills[1].plugin_name.as_deref(), Some("team"));
        assert_eq!(skills[1].provider, "claude");
        assert!(!skills[1].enabled);
        assert!(!skills[1].deletable);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn skill_paths_must_be_direct_children_of_an_allowed_root() {
        let root = env::temp_dir().join(format!("melody-work-skills-{}", uuid::Uuid::new_v4()));
        let allowed = root.join("skills");
        let valid = allowed.join("review");
        let nested = valid.join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::write(valid.join("SKILL.md"), "# Review").unwrap();
        fs::write(nested.join("SKILL.md"), "# Nested").unwrap();

        assert!(allowed_skill_path_in_roots(&valid, &[allowed.clone()]).is_ok());
        assert!(allowed_skill_path_in_roots(&nested, &[allowed]).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn patches_known_values_without_removing_comments_or_unknown_settings() {
        let mut document = r#"# Keep this comment
[models]
default = "old"
future_option = "preserved"
"#
        .parse::<DocumentMut>()
        .unwrap();
        apply_patch(
            &mut document,
            &MelodyConfigPatch {
                path: vec!["models".into(), "default".into()],
                value: serde_json::json!("new"),
            },
        )
        .unwrap();
        apply_patch(
            &mut document,
            &MelodyConfigPatch {
                path: vec!["features".into(), "telemetry".into()],
                value: serde_json::json!(false),
            },
        )
        .unwrap();

        let output = document.to_string();
        assert!(output.contains("# Keep this comment"));
        assert!(output.contains("future_option = \"preserved\""));
        assert!(output.contains("default = \"new\""));
        assert!(output.contains("telemetry = false"));
    }

    #[test]
    fn null_patch_removes_only_the_requested_value() {
        let mut document = "[ui]\nsimple_mode = true\nvim_mode = true\n"
            .parse::<DocumentMut>()
            .unwrap();
        apply_patch(
            &mut document,
            &MelodyConfigPatch {
                path: vec!["ui".into(), "vim_mode".into()],
                value: serde_json::Value::Null,
            },
        )
        .unwrap();

        let output = document.to_string();
        assert!(output.contains("simple_mode = true"));
        assert!(!output.contains("vim_mode"));
    }

    #[test]
    fn parses_available_and_installed_marketplace_plugins() {
        let plugins = marketplace_plugins_from_json(
            r#"[
                {
                    "status": "available",
                    "name": "web-tools",
                    "version": "1.2.0",
                    "description": "Web tools",
                    "marketplace": "Official",
                    "skill_count": 2,
                    "has_hooks": true,
                    "has_agents": false,
                    "has_mcp": true
                },
                {
                    "status": "installed",
                    "name": "reviewer",
                    "version": "0.4.0",
                    "marketplace": "Official"
                },
                {
                    "status": "installed",
                    "name": "direct-install",
                    "version": "1.0.0",
                    "marketplace": null
                }
            ]"#,
        )
        .unwrap();

        assert_eq!(plugins.len(), 2);
        assert_eq!(plugins[0].name, "web-tools");
        assert_eq!(plugins[0].version.as_deref(), Some("1.2.0"));
        assert_eq!(plugins[0].skill_count, 2);
        assert!(plugins[0].has_hooks);
        assert!(plugins[0].has_mcp);
        assert_eq!(plugins[1].status, "installed");
        assert_eq!(plugins[1].installed_version.as_deref(), Some("0.4.0"));
    }
}
