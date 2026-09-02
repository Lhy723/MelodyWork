use std::{env, path::PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;
use toml_edit::{Array, DocumentMut, Item, Table, Value};

use crate::config_io::TextFileStore;
use crate::workspace_access::WorkspaceRegistry;

pub(crate) const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MelodyConfigDocument {
    pub(crate) scope: String,
    pub(crate) path: String,
    pub(crate) exists: bool,
    pub(crate) content: String,
    pub(crate) values: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) parse_error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MelodyConfigPatch {
    pub(crate) path: Vec<String>,
    pub(crate) value: serde_json::Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MelodyExtension {
    pub(crate) kind: String,
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) scope: String,
    pub(crate) provider: String,
    pub(crate) managed: bool,
    pub(crate) enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) plugin_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) user_invocable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) compatibility_status: Option<String>,
    #[serde(default)]
    pub(crate) deletable: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceSource {
    pub(crate) name: String,
    pub(crate) kind: String,
    pub(crate) location: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) branch: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallResult {
    pub(crate) source: String,
    pub(crate) message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplacePlugin {
    pub(crate) name: String,
    pub(crate) marketplace: String,
    pub(crate) status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) installed_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
    pub(crate) skill_count: usize,
    pub(crate) has_hooks: bool,
    pub(crate) has_agents: bool,
    pub(crate) has_mcp: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginComponentGroup {
    pub(crate) kind: String,
    pub(crate) items: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDetails {
    pub(crate) name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) homepage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) repository: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) license: Option<String>,
    pub(crate) path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) manifest_path: Option<String>,
    pub(crate) components: Vec<PluginComponentGroup>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetails {
    pub(crate) name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) license: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) compatibility: Option<String>,
    pub(crate) path: String,
    pub(crate) skill_path: String,
    pub(crate) files: Vec<String>,
    pub(crate) content: String,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct InstalledPluginEntry {
    pub(crate) status: String,
    pub(crate) name: String,
    pub(crate) path: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MelodyInspectDocument {
    #[serde(default)]
    pub(crate) skills: Vec<MelodyInspectSkill>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MelodyInspectSkill {
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) description: Option<String>,
    pub(crate) source: MelodyInspectSkillSource,
    #[serde(default)]
    pub(crate) user_invocable: Option<bool>,
    #[serde(default)]
    pub(crate) vendor: Option<String>,
    #[serde(default)]
    pub(crate) disabled: bool,
    #[serde(default)]
    pub(crate) compatibility_status: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct MelodyInspectSkillSource {
    #[serde(rename = "type")]
    pub(crate) kind: String,
    #[serde(default)]
    pub(crate) path: Option<PathBuf>,
    #[serde(default)]
    pub(crate) plugin_name: Option<String>,
}

pub(crate) fn user_home() -> Result<PathBuf, String> {
    let home = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .ok_or_else(|| "Could not locate the user home directory".to_string())?;
    Ok(PathBuf::from(home))
}

pub(crate) fn melody_home() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("MELODY_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    Ok(user_home()?.join(".melody"))
}

pub(crate) fn project_melody_root(cwd: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(cwd);
    if !root.is_dir() {
        return Err(format!("Workspace does not exist: {}", root.display()));
    }
    Ok(root.join(".melody"))
}

pub(crate) fn config_path(scope: &str, cwd: &str) -> Result<PathBuf, String> {
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

pub(crate) fn read_melody_config_inner(
    scope: String,
    cwd: String,
) -> Result<MelodyConfigDocument, String> {
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

pub(crate) fn apply_patch(
    document: &mut DocumentMut,
    patch: &MelodyConfigPatch,
) -> Result<(), String> {
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
    registry: State<'_, WorkspaceRegistry>,
    scope: String,
    cwd: String,
    patches: Vec<MelodyConfigPatch>,
) -> Result<MelodyConfigDocument, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    update_melody_config_inner(scope, cwd, patches)
}

pub(crate) fn update_melody_config_inner(
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
