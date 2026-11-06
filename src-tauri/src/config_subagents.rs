//! Host-side projection of Melody-build subagent roles and personas.
//!
//! Pi receives only this bounded, data-only manifest.  In particular, prompt
//! file paths are resolved and read by the Host; the worker never gets a path
//! from which it could reach an arbitrary user file.

use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
};

use serde_json::{Map, Value, json};
use tauri::State;

use crate::config_core::{
    MelodyConfigDocument, melody_home, project_melody_root, read_melody_config_inner,
};
use crate::workspace_access::WorkspaceRegistry;

#[path = "config_subagent_prompt_file.rs"]
mod prompt_file;
#[path = "config_subagent_catalog.rs"]
mod source_catalog;
#[path = "config_subagent_markdown.rs"]
mod subagent_markdown;

use self::source_catalog::{AgentDefinitionCatalog, AgentFileDefinition, AgentInventoryEntry};
use self::subagent_markdown::{
    MAX_FILE_BYTES, MAX_MCP_TOOL_GRANTS, MAX_TEXT_BYTES, POLICY_AGENT_FIELDS, SAFE_AGENT_FIELDS,
    apply_agent_tool_ceiling, bounded_text, valid_mcp_tool_name, valid_name,
};

const MAX_POLICY_ENTRIES: usize = 128;
const MAX_DESCRIPTION_BYTES: usize = 2 * 1024;
const MAX_MODEL_BYTES: usize = 256;
const MAX_REASONING_BYTES: usize = 32;

/// Effective agent-definition metadata exposed to capability preflight. The
/// Host keeps instruction bodies and executable details out of this response.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MelodyAgentDefinition {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) scope: String,
    pub(crate) enabled: bool,
    pub(crate) supported: bool,
    pub(crate) unsupported_fields: Vec<String>,
}

struct AgentInventoryConfig {
    globally_enabled: bool,
    toggles: HashMap<String, Value>,
    inline_entries: BTreeMap<String, AgentInventoryEntry>,
}

impl Default for AgentInventoryConfig {
    fn default() -> Self {
        Self {
            globally_enabled: true,
            toggles: HashMap::new(),
            inline_entries: BTreeMap::new(),
        }
    }
}

type Definition = (Value, PathBuf);

fn alias<'a>(object: &'a Map<String, Value>, names: &[&str]) -> Option<&'a Value> {
    names.iter().find_map(|name| object.get(*name))
}

fn object_value(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn merge_scalar_map(target: &mut HashMap<String, Value>, value: Option<&Value>) {
    let Some(object) = value.and_then(Value::as_object) else {
        return;
    };
    for (name, entry) in object {
        if valid_name(name) {
            target.insert(name.trim().to_string(), entry.clone());
        }
    }
}

fn merge_definitions(
    target: &mut BTreeMap<String, Definition>,
    value: Option<&Value>,
    base: &Path,
) {
    let Some(value) = value else {
        return;
    };
    if let Some(entries) = value.as_array() {
        for entry in entries.iter().take(MAX_POLICY_ENTRIES) {
            let Some(object) = object_value(entry) else {
                continue;
            };
            let Some(name) = object.get("name").and_then(Value::as_str) else {
                continue;
            };
            let name = name.trim();
            if valid_name(name) {
                target.insert(name.to_string(), (entry.clone(), base.to_path_buf()));
            }
        }
        return;
    }
    let Some(object) = value.as_object() else {
        return;
    };
    for (name, entry) in object.iter().take(MAX_POLICY_ENTRIES) {
        let name = name.trim();
        if !valid_name(name) || !entry.is_object() {
            continue;
        }
        target.insert(name.to_string(), (entry.clone(), base.to_path_buf()));
    }
}

fn load_definition_files(directory: &Path, target: &mut BTreeMap<String, Definition>) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut paths = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension().and_then(|extension| extension.to_str()) == Some("toml")
                && path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .is_some_and(valid_name)
        })
        .collect::<Vec<_>>();
    paths.sort();
    for path in paths.into_iter().take(MAX_POLICY_ENTRIES) {
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() > MAX_FILE_BYTES
        {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(parsed) = toml::from_str::<toml::Value>(&content) else {
            continue;
        };
        let Ok(mut value) = serde_json::to_value(parsed) else {
            continue;
        };
        let Some(object) = value.as_object_mut() else {
            continue;
        };
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        object
            .entry("name")
            .or_insert_with(|| Value::String(stem.to_string()));
        target.insert(
            stem.to_string(),
            (value, path.parent().unwrap_or(directory).to_path_buf()),
        );
    }
}

fn with_file_instructions(
    object: &Map<String, Value>,
    base: &Path,
    keys: &[&str],
    file_keys: &[&str],
) -> Option<String> {
    let inline = alias(object, keys).and_then(|value| bounded_text(Some(value), MAX_TEXT_BYTES));
    let from_file =
        alias(object, file_keys).and_then(|value| prompt_file::read_prompt_file(base, Some(value)));
    match (inline, from_file) {
        (Some(inline), Some(file)) => Some(format!("{inline}\n\n{file}")),
        (Some(inline), None) => Some(inline),
        (None, Some(file)) => Some(file),
        (None, None) => None,
    }
}

fn normalize_role(name: &str, value: &Value, base: &Path) -> Option<Value> {
    let object = value.as_object()?;
    let mut result = Map::new();
    result.insert("name".to_string(), Value::String(name.to_string()));
    if let Some(description) = bounded_text(object.get("description"), MAX_DESCRIPTION_BYTES) {
        result.insert("description".to_string(), Value::String(description));
    }
    if let Some(instructions) = with_file_instructions(
        object,
        base,
        &["instructions", "prompt"],
        &["prompt_file", "promptFile"],
    ) {
        result.insert("instructions".to_string(), Value::String(instructions));
    }
    if let Some(capability) = alias(
        object,
        &["default_capability_mode", "defaultCapabilityMode"],
    )
    .and_then(|value| bounded_text(Some(value), 32))
    {
        result.insert(
            "defaultCapabilityMode".to_string(),
            Value::String(capability),
        );
    }
    if let Some(model) = alias(object, &["modelId", "model"])
        .and_then(|value| bounded_text(Some(value), MAX_MODEL_BYTES))
    {
        result.insert("modelId".to_string(), Value::String(model));
    }
    if let Some(reasoning) = alias(object, &["reasoningEffort", "reasoning_effort"])
        .and_then(|value| bounded_text(Some(value), MAX_REASONING_BYTES))
    {
        result.insert("reasoningEffort".to_string(), Value::String(reasoning));
    }
    if let Some(isolation) = alias(
        object,
        &["isolation", "defaultIsolation", "default_isolation"],
    )
    .and_then(|value| bounded_text(Some(value), 32))
    {
        result.insert("isolation".to_string(), Value::String(isolation));
    }
    Some(Value::Object(result))
}

fn normalize_persona(name: &str, value: &Value, base: &Path) -> Option<Value> {
    let object = value.as_object()?;
    let instructions = with_file_instructions(
        object,
        base,
        &["instructions", "prompt"],
        &["instructions_file", "instructionsFile"],
    )?;
    if instructions.is_empty() {
        return None;
    }
    let mut result = Map::new();
    result.insert("name".to_string(), Value::String(name.to_string()));
    result.insert("instructions".to_string(), Value::String(instructions));
    if let Some(description) = bounded_text(object.get("description"), MAX_DESCRIPTION_BYTES) {
        result.insert("description".to_string(), Value::String(description));
    }
    if let Some(model) = alias(object, &["modelId", "model"])
        .and_then(|value| bounded_text(Some(value), MAX_MODEL_BYTES))
    {
        result.insert("modelId".to_string(), Value::String(model));
    }
    if let Some(reasoning) = alias(object, &["reasoningEffort", "reasoning_effort"])
        .and_then(|value| bounded_text(Some(value), MAX_REASONING_BYTES))
    {
        result.insert("reasoningEffort".to_string(), Value::String(reasoning));
    }
    if let Some(isolation) = alias(
        object,
        &["isolation", "defaultIsolation", "default_isolation"],
    )
    .and_then(|value| bounded_text(Some(value), 32))
    {
        result.insert("isolation".to_string(), Value::String(isolation));
    }
    Some(Value::Object(result))
}

fn normalize_agent(name: &str, definition: &AgentFileDefinition) -> Option<Value> {
    if !definition.unsupported_fields.is_empty() {
        return None;
    }
    let object = definition.value.as_object()?;
    let mut result = Map::new();
    result.insert("name".to_string(), Value::String(name.to_string()));
    if let Some(description) = bounded_text(object.get("description"), MAX_DESCRIPTION_BYTES) {
        result.insert("description".to_string(), Value::String(description));
    }
    if let Some(instructions) = with_file_instructions(
        object,
        &definition.base,
        &["instructions", "prompt"],
        &["prompt_file", "promptFile"],
    ) {
        result.insert("instructions".to_string(), Value::String(instructions));
    }
    if let Some(capability) =
        alias(object, &["defaultCapabilityMode"]).and_then(|value| bounded_text(Some(value), 32))
    {
        result.insert(
            "defaultCapabilityMode".to_string(),
            Value::String(capability),
        );
    }
    if let Some(permission) =
        alias(object, &["permissionMode"]).and_then(|value| bounded_text(Some(value), 32))
    {
        result.insert("permissionMode".to_string(), Value::String(permission));
    }
    if let Some(model) =
        alias(object, &["modelId"]).and_then(|value| bounded_text(Some(value), MAX_MODEL_BYTES))
    {
        result.insert("modelId".to_string(), Value::String(model));
    }
    if let Some(reasoning) = alias(object, &["reasoningEffort"])
        .and_then(|value| bounded_text(Some(value), MAX_REASONING_BYTES))
    {
        result.insert("reasoningEffort".to_string(), Value::String(reasoning));
    }
    if let Some(isolation) =
        alias(object, &["isolation"]).and_then(|value| bounded_text(Some(value), 32))
    {
        result.insert("isolation".to_string(), Value::String(isolation));
    }
    if let Some(mcp_tools) = object.get("mcpTools").and_then(Value::as_array) {
        let grants = mcp_tools
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|tool| valid_mcp_tool_name(tool))
            .take(MAX_MCP_TOOL_GRANTS)
            .map(|tool| Value::String(tool.to_string()))
            .collect::<Vec<_>>();
        if !grants.is_empty() {
            result.insert("mcpTools".to_string(), Value::Array(grants));
        }
    }
    Some(Value::Object(result))
}

/// Resolve an inline definition into its bounded policy form and report the
/// policy fields Pi cannot represent.
///
/// Unknown keys are deliberately ignored: Melody's `AgentDefinition` has no
/// `deny_unknown_fields`, so a key the engine does not declare cannot change
/// the child's policy and must not force the session onto ACP.
fn normalize_agent_definition(value: Value) -> (Value, Vec<String>) {
    let mut value = value;
    let mut fields = Vec::new();
    if let Some(object) = value.as_object_mut() {
        apply_agent_tool_ceiling(object, &mut fields);
        fields.extend(
            object
                .keys()
                .filter(|key| {
                    POLICY_AGENT_FIELDS.contains(&key.as_str())
                        && !SAFE_AGENT_FIELDS.contains(&key.as_str())
                })
                .cloned(),
        );
    } else {
        fields.push("<definition>".to_string());
    }
    fields.sort();
    fields.dedup();
    (value, fields)
}

fn unsupported_agent_fields(value: &Value) -> Vec<String> {
    normalize_agent_definition(value.clone()).1
}

fn merge_agent_inventory_config(
    cwd: &str,
    document: &MelodyConfigDocument,
    inventory: &mut AgentInventoryConfig,
) -> Result<(), String> {
    let scope = document.scope.as_str();
    if let Some(error) = document.parse_error.as_ref() {
        return Err(format!("无法解析 {scope} Melody 配置：{error}"));
    }
    let Some(subagents) = document.values.get("subagents").and_then(Value::as_object) else {
        return Ok(());
    };
    if let Some(value) = subagents.get("enabled").and_then(Value::as_bool) {
        inventory.globally_enabled = value;
    }
    merge_scalar_map(&mut inventory.toggles, subagents.get("toggle"));
    let Some(value) = subagents.get("agents") else {
        return Ok(());
    };

    let mut inline = BTreeMap::new();
    merge_definitions(&mut inline, Some(value), Path::new(cwd));
    for (name, (definition, _base)) in inline {
        let unsupported_fields = unsupported_agent_fields(&definition);
        inventory.inline_entries.insert(
            name,
            AgentInventoryEntry {
                path: PathBuf::from(&document.path),
                scope: scope.to_string(),
                supported: unsupported_fields.is_empty(),
                unsupported_fields,
            },
        );
    }
    Ok(())
}

fn set_agent_definition(
    name: String,
    value: Value,
    base: PathBuf,
    supported: &mut BTreeMap<String, AgentFileDefinition>,
    unsupported: &mut BTreeMap<String, Vec<String>>,
) {
    supported.remove(&name);
    unsupported.remove(&name);
    let (value, fields) = normalize_agent_definition(value);
    if fields.is_empty() {
        supported.insert(
            name,
            AgentFileDefinition {
                value,
                base,
                unsupported_fields: fields,
            },
        );
    } else {
        unsupported.insert(name, fields);
    }
}

fn scope_base(scope: &str, cwd: &str) -> Result<PathBuf, String> {
    match scope {
        "user" => melody_home(),
        "project" => Ok(PathBuf::from(cwd)),
        _ => Err(format!("Unsupported Melody config scope: {scope}")),
    }
}

fn apply_environment_subagent_overrides(mut enabled: bool) -> bool {
    for variable in ["MELODY_SUBAGENTS", "MELODY_PI_SUBAGENTS"] {
        if let Ok(raw) = std::env::var(variable) {
            match raw.trim().to_ascii_lowercase().as_str() {
                "0" | "false" | "no" | "off" => enabled = false,
                "1" | "true" | "yes" | "on" => enabled = true,
                _ => {}
            }
        }
    }
    enabled
}

/// Build the Pi-facing subagent policy manifest. Project settings and files
/// override user settings; inline config entries override file definitions.
pub(crate) fn pi_subagent_policy_manifest(cwd: &str) -> Result<Value, String> {
    let mut enabled = true;
    let mut models = HashMap::new();
    let mut toggle = HashMap::new();
    let mut roles = BTreeMap::new();
    let mut personas = BTreeMap::new();
    let mut agents = BTreeMap::new();
    let mut unsupported_agents = BTreeMap::<String, Vec<String>>::new();
    let agent_roots = AgentDefinitionCatalog::native_roots(cwd)?;
    let mut agent_catalog = AgentDefinitionCatalog::default();
    agent_catalog.load_native_roots(&agent_roots);
    agent_catalog.merge_native_policy(&mut agents, &mut unsupported_agents);
    for scope in ["user", "project"] {
        let base = scope_base(scope, cwd)?;
        let definition_root = if scope == "user" {
            melody_home()?
        } else {
            project_melody_root(cwd)?
        };
        load_definition_files(&definition_root.join("roles"), &mut roles);
        load_definition_files(&definition_root.join("personas"), &mut personas);
        let document = read_melody_config_inner(scope.to_string(), cwd.to_string())?;
        if let Some(error) = document.parse_error {
            return Err(format!("无法解析 {scope} Melody 配置：{error}"));
        }
        let Some(subagents) = document.values.get("subagents").and_then(Value::as_object) else {
            continue;
        };
        if let Some(value) = subagents.get("enabled").and_then(Value::as_bool) {
            enabled = value;
        }
        merge_scalar_map(&mut models, subagents.get("models"));
        merge_scalar_map(&mut toggle, subagents.get("toggle"));
        merge_definitions(&mut roles, subagents.get("roles"), &base);
        merge_definitions(&mut personas, subagents.get("personas"), &base);
        if let Some(value) = subagents.get("agents") {
            let mut inline = BTreeMap::new();
            merge_definitions(&mut inline, Some(value), &base);
            for (name, (definition, definition_base)) in inline {
                set_agent_definition(
                    name,
                    definition,
                    definition_base,
                    &mut agents,
                    &mut unsupported_agents,
                );
            }
        }
    }
    enabled = apply_environment_subagent_overrides(enabled);
    // Plugin agents are the least specific source: they are added after native
    // files and inline config so an existing definition keeps its bare name,
    // while the qualified `<plugin>:<agent>` name stays reachable.
    agent_catalog.load_plugins(cwd)?;
    agent_catalog.merge_plugin_policy(&mut agents, &mut unsupported_agents);
    let role_names = roles
        .keys()
        .chain(personas.keys())
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    agents.retain(|name, _| !role_names.contains(name));
    unsupported_agents.retain(|name, _| !role_names.contains(name));
    let normalized_models = models
        .into_iter()
        .filter_map(|(name, value)| {
            bounded_text(Some(&value), MAX_MODEL_BYTES).map(|value| (name, Value::String(value)))
        })
        .collect::<Map<_, _>>();
    let normalized_toggle = toggle
        .into_iter()
        .filter_map(|(name, value)| value.as_bool().map(|value| (name, Value::Bool(value))))
        .collect::<Map<_, _>>();
    let normalized_roles = roles
        .into_iter()
        .take(MAX_POLICY_ENTRIES)
        .filter_map(|(name, (value, base))| normalize_role(&name, &value, &base))
        .collect::<Vec<_>>();
    let normalized_personas = personas
        .into_iter()
        .take(MAX_POLICY_ENTRIES)
        .filter_map(|(name, (value, base))| normalize_persona(&name, &value, &base))
        .collect::<Vec<_>>();
    let normalized_agents = agents
        .into_iter()
        .take(MAX_POLICY_ENTRIES)
        .filter_map(|(name, definition)| normalize_agent(&name, &definition))
        .collect::<Vec<_>>();
    let unsupported_agents = unsupported_agents
        .into_iter()
        .take(MAX_POLICY_ENTRIES)
        .map(|(name, _fields)| Value::String(name))
        .collect::<Vec<_>>();
    Ok(json!({
        "enabled": enabled,
        "models": normalized_models,
        "toggle": normalized_toggle,
        "roles": normalized_roles,
        "personas": normalized_personas,
        "agents": normalized_agents,
        "unsupportedAgents": unsupported_agents,
    }))
}

/// Return the effective agent-definition files/config entries for capability
/// preflight. Definitions are merged with the same low-to-high precedence as
/// `pi_subagent_policy_manifest`; a project or inline definition therefore
/// replaces a user definition with the same name instead of emitting a stale
/// inventory entry for the shadowed file.
pub(crate) fn list_melody_agent_definitions(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
) -> Result<Vec<MelodyAgentDefinition>, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    let roots = AgentDefinitionCatalog::native_roots(&cwd)?;
    let mut inventory_config = AgentInventoryConfig::default();
    // Read each config once. The settings inventory needs only enablement and
    // inline-agent metadata; building the Pi manifest here would rescan all
    // native/plugin definitions and normalize roles/personas that this view
    // never returns.
    for scope in ["user", "project"] {
        let document = read_melody_config_inner(scope.to_string(), cwd.clone())?;
        merge_agent_inventory_config(&cwd, &document, &mut inventory_config)?;
    }
    inventory_config.globally_enabled =
        apply_environment_subagent_overrides(inventory_config.globally_enabled);

    let mut agent_catalog = AgentDefinitionCatalog::default();
    agent_catalog.load_native_roots(&roots);
    agent_catalog.load_plugins(&cwd)?;
    let mut entries = BTreeMap::new();
    agent_catalog.project_native_inventory(&mut entries);
    agent_catalog.project_plugin_inventory(&mut entries);
    // Inline definitions are more specific than files in either scope, so
    // apply them last in user → project order.
    entries.extend(inventory_config.inline_entries);

    Ok(entries
        .into_iter()
        .map(|(name, entry)| MelodyAgentDefinition {
            enabled: inventory_config.globally_enabled
                && inventory_config
                    .toggles
                    .get(&name)
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
            name,
            path: entry.path.to_string_lossy().into_owned(),
            scope: entry.scope,
            supported: entry.supported,
            unsupported_fields: entry.unsupported_fields,
        })
        .collect())
}
