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

use super::config_core::{melody_home, project_melody_root, read_melody_config_inner, user_home};
use super::config_extensions::pi_plugin_agent_roots;
use crate::workspace_access::WorkspaceRegistry;

const MAX_POLICY_ENTRIES: usize = 128;
const MAX_NAME_BYTES: usize = 128;
const MAX_TEXT_BYTES: usize = 32 * 1024;
const MAX_DESCRIPTION_BYTES: usize = 2 * 1024;
const MAX_MODEL_BYTES: usize = 256;
const MAX_REASONING_BYTES: usize = 32;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_AGENT_DEFINITION_FILES: usize = 128;
/// Must match the worker's `MAX_MCP_TOOLS` bound so an over-long grant list
/// fails the Host preflight instead of the session.
const MAX_MCP_TOOL_GRANTS: usize = 64;

/// Top-level fields that can be represented without giving Pi a dynamic
/// executable tool graph.
const SAFE_AGENT_FIELDS: &[&str] = &[
    "name",
    "description",
    "model",
    "modelId",
    "model_id",
    "effort",
    "reasoningEffort",
    "reasoning_effort",
    "capabilityMode",
    "capability_mode",
    "defaultCapabilityMode",
    "default_capability_mode",
    "isolation",
    "defaultIsolation",
    "default_isolation",
    "permissionMode",
    "permission_mode",
    "instructions",
    "prompt",
    "prompt_file",
    "promptFile",
];

/// Every field Melody-build's `AgentDefinition` declares.
///
/// The legacy engine deserializes agent frontmatter into that struct, which
/// does not use `deny_unknown_fields`; an unrecognized key is therefore inert
/// metadata and must not be reported as an unsupported capability. Only a key
/// that Melody itself would act on can change the tool graph, the model, the
/// trust boundary or the completion contract, and every such key has to be
/// either representable ([`SAFE_AGENT_FIELDS`]) or reported as ACP-only.
const POLICY_AGENT_FIELDS: &[&str] = &[
    // Representable subset.
    "name",
    "description",
    "model",
    "effort",
    "capabilityMode",
    "capability_mode",
    "defaultCapabilityMode",
    "default_capability_mode",
    "isolation",
    "defaultIsolation",
    "default_isolation",
    "permissionMode",
    "permission_mode",
    "prompt_file",
    "promptFile",
    // Dynamic or unrepresentable policy surfaces.
    "tools",
    "disallowedTools",
    "toolConfig",
    "promptMode",
    "skills",
    "discoverSkills",
    "inheritSkills",
    "agentsMd",
    "injectDefaultTools",
    "maxTurns",
    "background",
    "initialPrompt",
    "mcpServers",
    "mcpInheritance",
    "hooks",
    "memory",
];

/// List-valued policy fields whose entries bound the child's capabilities.
const TOOL_LIST_FIELDS: &[&str] = &["tools", "disallowedTools"];

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

#[derive(Clone, Debug)]
struct AgentInventoryEntry {
    path: PathBuf,
    scope: String,
    supported: bool,
    unsupported_fields: Vec<String>,
}

#[derive(Clone, Debug)]
struct AgentFileDefinition {
    value: Value,
    base: PathBuf,
    unsupported_fields: Vec<String>,
}

type Definition = (Value, PathBuf);

fn valid_name(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= MAX_NAME_BYTES
        && !value.chars().any(|character| character.is_control())
}

fn bounded_text(value: Option<&Value>, max: usize) -> Option<String> {
    let value = value?.as_str()?.trim();
    if value.is_empty() || value.len() > max || value.chars().any(|c| c.is_control()) {
        return None;
    }
    Some(value.to_string())
}

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

fn parse_agent_scalar(raw: &str) -> Option<String> {
    let value = raw.trim();
    if value.is_empty() || value.starts_with('[') || value.starts_with('{') {
        return None;
    }
    if value.starts_with('"') && value.ends_with('"') && value.len() >= 2 {
        return serde_json::from_str(value).ok();
    }
    if value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2 {
        return Some(value[1..value.len() - 1].replace("''", "'"));
    }
    Some(value.to_string())
}

/// Net `[` minus `]` count, used to detect a YAML flow sequence that continues
/// on the next line.
fn bracket_balance(text: &str) -> i32 {
    text.chars().fold(0, |balance, character| match character {
        '[' => balance + 1,
        ']' => balance - 1,
        _ => balance,
    })
}

/// Parse a tool list written either inline (`["Read", "Bash"]`, `[Read, Bash]`,
/// `Read, Bash`) or as a YAML block list (`- Read`).
fn parse_agent_list(raw: &str) -> Vec<String> {
    let value = raw.trim();
    if value.is_empty() {
        return Vec::new();
    }
    if value.starts_with('[') && value.ends_with(']') {
        // YAML inline lists are not required to be JSON: they commonly appear as
        // `[Read, Grep]` with unquoted plain scalars.
        if let Ok(parsed) = serde_json::from_str::<Vec<Value>>(value) {
            return parsed
                .iter()
                .filter_map(Value::as_str)
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty() && item.len() <= MAX_NAME_BYTES)
                .collect();
        }
        let inner = value[1..value.len() - 1].trim();
        if inner.is_empty() {
            return Vec::new();
        }
        return inner
            .split(',')
            .map(|item| item.trim().trim_matches(['"', '\'']).trim().to_string())
            .filter(|item| !item.is_empty() && item.len() <= MAX_NAME_BYTES)
            .collect();
    }
    value
        .split(',')
        .map(|item| item.trim().trim_matches(['"', '\'']).trim().to_string())
        .filter(|item| !item.is_empty() && item.len() <= MAX_NAME_BYTES)
        .collect()
}

/// Capability classes a Melody tool name can require.
#[derive(Clone, Copy, PartialEq, Eq)]
enum AgentToolClass {
    Read,
    Write,
    Execute,
    McpCall,
}

/// Classify one Melody/Claude tool name. `None` means the Host cannot bound
/// what that tool is allowed to do, so the definition stays on ACP rather than
/// silently receiving a wider or narrower ceiling.
fn classify_agent_tool(name: &str) -> Option<AgentToolClass> {
    let trimmed = name.trim();
    let normalized = trimmed.to_ascii_lowercase().replace(['-', ' ', '_'], "");
    if trimmed.starts_with("mcp__") || trimmed.contains("__") {
        return Some(AgentToolClass::McpCall);
    }
    match normalized.as_str() {
        "read"
        | "readfile"
        | "notebookread"
        | "grep"
        | "glob"
        | "ls"
        | "list"
        | "listdir"
        | "listdirectory"
        | "search"
        | "workspacereadfile"
        | "workspacereadtooloutput"
        | "workspacesearch"
        | "workspacelistdirectory"
        | "webfetch"
        | "websearch"
        | "lsp"
        | "codebasenavigation"
        | "todowrite"
        | "updateplan"
        | "askuserquestion"
        | "task"
        | "agent"
        | "getcommandorsubagentoutput"
        | "waitcommandsorsubagents"
        | "killcommandorsubagent"
        | "memorysearch"
        | "memoryget"
        | "gettaskoutput"
        | "waittasks"
        | "killtask"
        | "bashoutput"
        | "killshell"
        | "mcp" => Some(AgentToolClass::Read),
        "write"
        | "writefile"
        | "workspacewritefile"
        | "edit"
        | "multiedit"
        | "notebookedit"
        | "strreplace"
        | "applypatch"
        | "workspaceedit"
        | "workspaceapplypatch"
        | "memoryremember" => Some(AgentToolClass::Write),
        "bash" | "terminal" | "shell" | "runterminalcommand" | "execute" => {
            Some(AgentToolClass::Execute)
        }
        _ => None,
    }
}

/// Translate an `AgentDefinition`-style tool allowlist into the narrowest Pi
/// capability ceiling that still covers every tool the definition asked for.
///
/// Melody filters the child's tool set with this list; Pi only has capability
/// ceilings plus exact MCP grants, so an allowlist has to be widened to the
/// smallest ceiling that contains it and its MCP entries carried verbatim.
/// A list that cannot be expressed (an unknown tool, or a denylist that would
/// require subtracting from "everything") keeps the definition on ACP instead
/// of granting a different capability set.
fn capability_ceiling_for_tools(
    tools: &[String],
    has_denylist: bool,
) -> Option<(String, Vec<String>)> {
    if has_denylist {
        return None;
    }
    let mut allows_write = false;
    let mut allows_execute = false;
    let mut mcp_tools = Vec::new();
    for tool in tools {
        match classify_agent_tool(tool)? {
            AgentToolClass::Read => {}
            AgentToolClass::Write => allows_write = true,
            AgentToolClass::Execute => allows_execute = true,
            AgentToolClass::McpCall => {
                if !valid_mcp_tool_name(tool.trim()) {
                    return None;
                }
                mcp_tools.push(tool.trim().to_string());
            }
        }
    }
    if mcp_tools.len() > MAX_MCP_TOOL_GRANTS {
        return None;
    }
    mcp_tools.sort();
    mcp_tools.dedup();
    let ceiling = match (allows_write, allows_execute) {
        (true, true) => "read-write-execute",
        (true, false) => "read-write",
        (false, true) => "execute",
        (false, false) => "read-only",
    };
    Some((ceiling.to_string(), mcp_tools))
}

/// `mcp__<server>__<tool>`, matching the worker's validator so a grant the
/// worker would reject never reaches a session.
fn valid_mcp_tool_name(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("mcp__") else {
        return false;
    };
    let Some((server, tool)) = rest.split_once("__") else {
        return false;
    };
    let bounded = |part: &str, max: usize| {
        !part.is_empty()
            && part.len() <= max
            && part
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "_.-".contains(character))
    };
    bounded(server, 64) && bounded(tool, 96)
}

/// Resolve `tools`/`disallowedTools` into a capability ceiling plus exact MCP
/// grants, and drop the raw lists so the worker only sees bounded policy.
fn apply_agent_tool_ceiling(object: &mut Map<String, Value>, unsupported: &mut Vec<String>) {
    let tools = object
        .get("tools")
        .map(agent_tool_list_value)
        .unwrap_or_default();
    let has_denylist = ["disallowedTools", "disallowed_tools"]
        .iter()
        .any(|key| object.get(*key).is_some());
    object.remove("tools");
    object.remove("disallowedTools");
    object.remove("disallowed_tools");
    if tools.is_empty() && !has_denylist {
        // Melody treats an absent or empty allowlist as "inherit everything".
        return;
    }
    match capability_ceiling_for_tools(&tools, has_denylist) {
        Some((ceiling, mcp_tools)) => {
            object
                .entry("defaultCapabilityMode".to_string())
                .or_insert(Value::String(ceiling));
            if !mcp_tools.is_empty() {
                object.insert(
                    "mcpTools".to_string(),
                    Value::Array(mcp_tools.into_iter().map(Value::String).collect()),
                );
            }
        }
        None => unsupported.push("tools".to_string()),
    }
}

fn agent_tool_list_value(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty() && item.len() <= MAX_NAME_BYTES)
            .collect(),
        Value::String(raw) => parse_agent_list(raw),
        _ => Vec::new(),
    }
}

/// Record one parsed `tools`/`disallowedTools` entry on the definition object so
/// the shared ceiling resolver can see it.
fn record_agent_tool_list(
    key: &str,
    items: Vec<String>,
    object: &mut Map<String, Value>,
    unsupported: &mut Vec<String>,
) {
    if !TOOL_LIST_FIELDS.contains(&key) {
        unsupported.push(key.to_string());
        return;
    }
    object.insert(
        key.to_string(),
        Value::Array(items.into_iter().map(Value::String).collect()),
    );
}

fn canonical_agent_field(key: &str) -> Option<&'static str> {
    match key.trim() {
        "name" => Some("name"),
        "description" => Some("description"),
        "model" | "modelId" | "model_id" => Some("modelId"),
        "effort" | "reasoningEffort" | "reasoning_effort" => Some("reasoningEffort"),
        "capabilityMode"
        | "capability_mode"
        | "defaultCapabilityMode"
        | "default_capability_mode" => Some("defaultCapabilityMode"),
        "isolation" | "defaultIsolation" | "default_isolation" => Some("isolation"),
        "permissionMode" | "permission_mode" => Some("permissionMode"),
        "instructions" | "prompt" => Some("instructions"),
        "prompt_file" | "promptFile" => Some("promptFile"),
        _ => None,
    }
}

fn parse_agent_markdown(path: &Path) -> Result<(String, Value, Vec<String>), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("agent definition is not a regular file".to_string());
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err("agent definition exceeds 1 MB".to_string());
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return Err("missing frontmatter delimiters".to_string());
    }
    let after_opening = &trimmed[3..];
    let closing = after_opening
        .find("\n---")
        .ok_or_else(|| "missing closing frontmatter delimiter".to_string())?;
    let frontmatter = &after_opening[..closing];
    let after_closing = &after_opening[closing + 4..];
    let body_start = after_closing.find('\n').map(|index| index + 1).unwrap_or(0);
    let body = after_closing[body_start..].trim();
    if body.len() > MAX_TEXT_BYTES
        || body
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err("agent instructions exceed the bounded text policy".to_string());
    }

    let mut object = Map::new();
    let mut unsupported_fields = Vec::new();
    let mut pending_list = String::new();
    let mut pending_items: Vec<String> = Vec::new();
    // A YAML flow sequence may continue on later lines; keep collecting until
    // the brackets balance so `tools: ["Read", "Write",` … `"Bash"]` is read as
    // one list instead of an unclassifiable fragment.
    let mut open_inline: Option<(String, String)> = None;
    for line in frontmatter.lines() {
        let line = line.trim_end();
        let trimmed_line = line.trim();
        if trimmed_line.is_empty() || trimmed_line.starts_with('#') {
            continue;
        }
        if let Some((key, buffer)) = open_inline.take() {
            let mut buffer = format!("{buffer} {trimmed_line}");
            if bracket_balance(&buffer) > 0 {
                if buffer.len() > MAX_TEXT_BYTES {
                    unsupported_fields.push(key);
                } else {
                    open_inline = Some((key, buffer));
                }
                continue;
            }
            buffer.truncate(buffer.len());
            let items = parse_agent_list(&buffer);
            record_agent_tool_list(&key, items, &mut object, &mut unsupported_fields);
            continue;
        }
        // Block-list continuation (`- Read`) belongs to the previous key.
        if let Some(item) = trimmed_line.strip_prefix('-') {
            if !pending_list.is_empty() {
                let item = item.trim().trim_matches(['"', '\'']).trim();
                if !item.is_empty() && item.len() <= MAX_NAME_BYTES {
                    pending_items.push(item.to_string());
                }
                continue;
            }
        }
        let Some((raw_key, raw_value)) = trimmed_line.split_once(':') else {
            // Free-form prose inside the frontmatter (definition files embed
            // example blocks in their description). Melody's parser would
            // reject the file, but the Host keeps the representable fields and
            // ignores prose rather than declaring a capability missing.
            continue;
        };
        let key = raw_key.trim();
        if !POLICY_AGENT_FIELDS.contains(&key) {
            // Inert metadata: Melody's `AgentDefinition` ignores unknown keys,
            // so Color/Tags/prose lines can never change policy.
            continue;
        }
        if TOOL_LIST_FIELDS.contains(&key) {
            if bracket_balance(raw_value) > 0 {
                open_inline = Some((key.to_string(), raw_value.trim().to_string()));
                continue;
            }
            let inline = parse_agent_list(raw_value);
            if inline.is_empty() && parse_agent_scalar(raw_value).is_none() {
                pending_list = key.to_string();
                pending_items.clear();
                continue;
            }
            record_agent_tool_list(key, inline, &mut object, &mut unsupported_fields);
            continue;
        }
        let Some(canonical) = canonical_agent_field(key) else {
            unsupported_fields.push(key.to_string());
            continue;
        };
        let Some(value) = parse_agent_scalar(raw_value) else {
            unsupported_fields.push(key.to_string());
            continue;
        };
        if value.len() > MAX_TEXT_BYTES || value.chars().any(|character| character.is_control()) {
            unsupported_fields.push(key.to_string());
            continue;
        }
        object.insert(canonical.to_string(), Value::String(value));
    }
    if !pending_list.is_empty() {
        let items = std::mem::take(&mut pending_items);
        record_agent_tool_list(&pending_list, items, &mut object, &mut unsupported_fields);
    }
    if let Some((key, _)) = open_inline {
        unsupported_fields.push(key);
    }
    apply_agent_tool_ceiling(&mut object, &mut unsupported_fields);
    if !body.is_empty() {
        object.insert("instructions".to_string(), Value::String(body.to_string()));
    }
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "agent definition filename is not valid UTF-8".to_string())?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| valid_name(value))
        .unwrap_or(stem)
        .to_string();
    if !valid_name(&name) {
        return Err("agent definition name is invalid".to_string());
    }
    object.insert("name".to_string(), Value::String(name.clone()));
    unsupported_fields.sort();
    unsupported_fields.dedup();
    Ok((name, Value::Object(object), unsupported_fields))
}

fn agent_definition_roots(cwd: &str) -> Result<Vec<(PathBuf, String)>, String> {
    let cwd_path = PathBuf::from(cwd);
    if !cwd_path.is_dir() {
        return Err(format!("Workspace does not exist: {}", cwd_path.display()));
    }
    let mut roots = Vec::new();
    let mut current = cwd_path;
    let mut found_repository_marker = false;
    loop {
        for directory in [".melody", ".agents", ".claude", ".cursor"] {
            roots.push((
                current.join(directory).join("agents"),
                "project".to_string(),
            ));
        }
        if current.join(".git").exists() {
            found_repository_marker = true;
            break;
        }
        let Some(parent) = current.parent() else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent.to_path_buf();
    }
    if !found_repository_marker {
        roots.truncate(4);
    }
    roots.push((melody_home()?.join("agents"), "user".to_string()));
    let home = user_home()?;
    for directory in [".agents", ".claude", ".cursor"] {
        roots.push((home.join(directory).join("agents"), "user".to_string()));
    }
    Ok(roots)
}

/// A parsed Markdown agent definition before name qualification.
struct ParsedAgentDefinition {
    name: String,
    value: Value,
    unsupported_fields: Vec<String>,
    base: PathBuf,
}

/// Ordinary `*.md` files in an agent directory, in deterministic order.
fn agent_definition_paths(directory: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut paths = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension().and_then(|extension| extension.to_str()) == Some("md")
                && path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .is_some_and(valid_name)
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths.truncate(MAX_AGENT_DEFINITION_FILES);
    paths
}

fn parse_agent_definition_entry(path: &Path, directory: &Path) -> ParsedAgentDefinition {
    let fallback_name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string();
    match parse_agent_markdown(path) {
        Ok((name, value, unsupported_fields)) => ParsedAgentDefinition {
            name,
            value,
            unsupported_fields,
            base: path.parent().unwrap_or(directory).to_path_buf(),
        },
        Err(reason) => ParsedAgentDefinition {
            name: fallback_name,
            value: Value::Object(Map::new()),
            unsupported_fields: vec![reason],
            base: directory.to_path_buf(),
        },
    }
}

fn load_agent_definition_files(
    roots: &[(PathBuf, String)],
    supported: &mut BTreeMap<String, AgentFileDefinition>,
    unsupported: &mut BTreeMap<String, Vec<String>>,
) {
    for (directory, _scope) in roots {
        for path in agent_definition_paths(directory) {
            let entry = parse_agent_definition_entry(&path, directory);
            set_parsed_agent_definition(entry, supported, unsupported);
        }
    }
}

/// Register one parsed file definition. The parse step already decided which
/// fields are representable, so a definition carrying reported unsupported
/// fields (or a load error) must never be re-evaluated from its filtered value.
fn set_parsed_agent_definition(
    entry: ParsedAgentDefinition,
    agents: &mut BTreeMap<String, AgentFileDefinition>,
    unsupported: &mut BTreeMap<String, Vec<String>>,
) {
    let ParsedAgentDefinition {
        name,
        value,
        unsupported_fields,
        base,
    } = entry;
    agents.remove(&name);
    unsupported.remove(&name);
    if unsupported_fields.is_empty() {
        agents.insert(
            name,
            AgentFileDefinition {
                value,
                base,
                unsupported_fields,
            },
        );
    } else {
        unsupported.insert(name, unsupported_fields);
    }
}

/// Declarative agent definitions contributed by enabled Markdown-only plugins.
///
/// Melody keeps a plugin's agents addressable as `<plugin>:<agent>` while
/// native definitions win bare-name resolution, so the qualified name is
/// always registered and the bare name only when nothing else claims it.
fn load_plugin_agent_definitions(
    cwd: &str,
    agents: &mut BTreeMap<String, AgentFileDefinition>,
    unsupported_agents: &mut BTreeMap<String, Vec<String>>,
) -> Result<(), String> {
    for (directory, _scope, plugin) in pi_plugin_agent_roots(cwd)? {
        for path in agent_definition_paths(&directory) {
            let entry = parse_agent_definition_entry(&path, &directory);
            let qualified = format!("{plugin}:{}", entry.name);
            let bare_name_is_free =
                !agents.contains_key(&entry.name) && !unsupported_agents.contains_key(&entry.name);
            if bare_name_is_free {
                set_parsed_agent_definition(
                    ParsedAgentDefinition {
                        name: entry.name.clone(),
                        value: entry.value.clone(),
                        unsupported_fields: entry.unsupported_fields.clone(),
                        base: entry.base.clone(),
                    },
                    agents,
                    unsupported_agents,
                );
            }
            set_parsed_agent_definition(
                ParsedAgentDefinition {
                    name: qualified,
                    value: entry.value,
                    unsupported_fields: entry.unsupported_fields,
                    base: entry.base,
                },
                agents,
                unsupported_agents,
            );
        }
    }
    Ok(())
}

/// Inventory entries for the same plugin agent definitions, keyed by the
/// qualified name so Settings never confuses a plugin agent with a native or
/// inline definition of the same file name.
fn collect_plugin_agent_definition_inventory(
    cwd: &str,
    target: &mut BTreeMap<String, AgentInventoryEntry>,
) -> Result<(), String> {
    for (directory, scope, plugin) in pi_plugin_agent_roots(cwd)? {
        for path in agent_definition_paths(&directory) {
            let entry = parse_agent_definition_entry(&path, &directory);
            let qualified = format!("{plugin}:{}", entry.name);
            target.insert(
                qualified,
                AgentInventoryEntry {
                    path,
                    scope: scope.clone(),
                    supported: entry.unsupported_fields.is_empty(),
                    unsupported_fields: entry.unsupported_fields,
                },
            );
        }
    }
    Ok(())
}

fn collect_agent_definition_inventory(
    roots: &[(PathBuf, String)],
    target: &mut BTreeMap<String, AgentInventoryEntry>,
) {
    for (directory, scope) in roots {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        let mut paths = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension().and_then(|extension| extension.to_str()) == Some("md")
                    && path
                        .file_stem()
                        .and_then(|stem| stem.to_str())
                        .is_some_and(valid_name)
            })
            .collect::<Vec<_>>();
        paths.sort();
        for path in paths.into_iter().take(MAX_AGENT_DEFINITION_FILES) {
            let fallback_name = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string();
            match parse_agent_markdown(&path) {
                Ok((name, _value, unsupported_fields)) => {
                    target.insert(
                        name,
                        AgentInventoryEntry {
                            path: path.clone(),
                            scope: scope.clone(),
                            supported: unsupported_fields.is_empty(),
                            unsupported_fields,
                        },
                    );
                }
                Err(reason) => {
                    target.insert(
                        fallback_name,
                        AgentInventoryEntry {
                            path: path.clone(),
                            scope: scope.clone(),
                            supported: false,
                            unsupported_fields: vec![reason],
                        },
                    );
                }
            }
        }
    }
}

fn read_prompt_file(base: &Path, raw: Option<&Value>) -> Option<String> {
    let reference = bounded_text(raw, 4_096)?;
    let path = Path::new(&reference);
    if path.is_absolute() || reference.contains('\0') {
        return None;
    }
    let candidate = base.join(path);
    let canonical_base = base.canonicalize().ok()?;
    let canonical_candidate = candidate.canonicalize().ok()?;
    if canonical_candidate != canonical_base && !canonical_candidate.starts_with(&canonical_base) {
        return None;
    }
    let metadata = fs::symlink_metadata(&canonical_candidate).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return None;
    }
    let content = fs::read_to_string(canonical_candidate).ok()?;
    if content.len() > MAX_TEXT_BYTES
        || content
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t' && c != '\r')
    {
        return None;
    }
    Some(content.trim().to_string())
}

fn with_file_instructions(
    object: &Map<String, Value>,
    base: &Path,
    keys: &[&str],
    file_keys: &[&str],
) -> Option<String> {
    let inline = alias(object, keys).and_then(|value| bounded_text(Some(value), MAX_TEXT_BYTES));
    let from_file = alias(object, file_keys).and_then(|value| read_prompt_file(base, Some(value)));
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
    let mut agent_roots = agent_definition_roots(cwd)?;
    // Merge from the least-specific source to the most-specific one so a
    // project definition wins over user defaults and a nested project wins
    // over an ancestor definition, matching Melody's discovery order.
    agent_roots.reverse();
    load_agent_definition_files(&agent_roots, &mut agents, &mut unsupported_agents);
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
    for variable in ["MELODY_SUBAGENTS", "MELODY_PI_SUBAGENTS"] {
        if let Ok(raw) = std::env::var(variable) {
            match raw.trim().to_ascii_lowercase().as_str() {
                "0" | "false" | "no" | "off" => enabled = false,
                "1" | "true" | "yes" | "on" => enabled = true,
                _ => {}
            }
        }
    }
    // Plugin agents are the least specific source: they are added after native
    // files and inline config so an existing definition keeps its bare name,
    // while the qualified `<plugin>:<agent>` name stays reachable.
    load_plugin_agent_definitions(cwd, &mut agents, &mut unsupported_agents)?;
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
/// replaces a user definition with the same name instead of producing a false
/// ACP fallback for a shadowed file.
pub(crate) fn list_melody_agent_definitions(
    registry: State<'_, WorkspaceRegistry>,
    cwd: String,
) -> Result<Vec<MelodyAgentDefinition>, String> {
    let cwd = registry.authorize(&cwd)?.to_string_lossy().into_owned();
    let manifest = pi_subagent_policy_manifest(&cwd)?;
    let globally_enabled = manifest
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let toggles = manifest
        .get("toggle")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut roots = agent_definition_roots(&cwd)?;
    roots.reverse();
    let mut entries = BTreeMap::new();
    collect_agent_definition_inventory(&roots, &mut entries);
    collect_plugin_agent_definition_inventory(&cwd, &mut entries)?;

    // Inline definitions are more specific than files in either scope, so
    // apply them last in user → project order.
    for scope in ["user", "project"] {
        let document = read_melody_config_inner(scope.to_string(), cwd.clone())?;
        if document.parse_error.is_some() {
            continue;
        }
        let Some(subagents) = document.values.get("subagents").and_then(Value::as_object) else {
            continue;
        };
        let Some(value) = subagents.get("agents") else {
            continue;
        };
        let mut inline = BTreeMap::new();
        merge_definitions(&mut inline, Some(value), Path::new(&cwd));
        for (name, (definition, _base)) in inline {
            let unsupported_fields = unsupported_agent_fields(&definition);
            entries.insert(
                name,
                AgentInventoryEntry {
                    path: PathBuf::from(&document.path),
                    scope: scope.to_string(),
                    supported: unsupported_fields.is_empty(),
                    unsupported_fields,
                },
            );
        }
    }

    Ok(entries
        .into_iter()
        .map(|(name, entry)| MelodyAgentDefinition {
            enabled: globally_enabled
                && toggles.get(&name).and_then(Value::as_bool).unwrap_or(true),
            name,
            path: entry.path.to_string_lossy().into_owned(),
            scope: entry.scope,
            supported: entry.supported,
            unsupported_fields: entry.unsupported_fields,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_document_level_tables_from_toml_agent_definitions() {
        let root = std::env::temp_dir().join(format!("melody-agent-toml-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("reviewer.toml"),
            "[agent]\nname = \"reviewer\"\ndescription = \"Review changes\"\n",
        )
        .unwrap();

        let mut definitions = BTreeMap::new();
        load_definition_files(&root, &mut definitions);
        let definition = definitions.get("reviewer").map(|(value, _)| value.clone());
        fs::remove_dir_all(&root).unwrap();

        let definition = definition.expect("valid TOML definition should be loaded");
        assert_eq!(definition["agent"]["name"], "reviewer");
        assert_eq!(definition["name"], "reviewer");
    }

    #[test]
    fn merges_inline_role_and_persona_with_project_precedence() {
        let cwd = std::env::temp_dir().join(format!("melody-subagents-{}", uuid::Uuid::new_v4()));
        let melody = cwd.join(".melody");
        fs::create_dir_all(&melody).unwrap();
        fs::write(
            melody.join("config.toml"),
            r#"
[subagents]
enabled = true
[subagents.toggle]
explore = false
[subagents.models]
explore = "provider/explore"
[subagents.roles.reviewer]
description = "Review code"
default_capability_mode = "read-only"
instructions = "Review carefully."
[subagents.personas.concise]
instructions = "Be concise."
"#,
        )
        .unwrap();
        unsafe {
            std::env::set_var("MELODY_HOME", cwd.join("user-home"));
        }
        let manifest = pi_subagent_policy_manifest(cwd.to_str().unwrap()).unwrap();
        assert_eq!(manifest["enabled"], true);
        assert_eq!(manifest["toggle"]["explore"], false);
        assert_eq!(manifest["roles"][0]["name"], "reviewer");
        assert_eq!(manifest["personas"][0]["instructions"], "Be concise.");
        unsafe {
            std::env::remove_var("MELODY_HOME");
        }
        fs::remove_dir_all(cwd).unwrap();
    }

    #[test]
    fn parses_safe_markdown_agent_definitions_and_rejects_dynamic_fields() {
        let root = std::env::temp_dir().join(format!("melody-agent-def-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".melody/agents")).unwrap();
        let safe = root.join(".melody/agents/reviewer.md");
        fs::write(
            &safe,
            "---\nname: reviewer\ndescription: Review changes\nmodel: provider/reviewer\neffort: high\ncapability_mode: read-only\npermission_mode: auto\nisolation: worktree\n---\nReview the change carefully.\n",
        )
        .unwrap();
        let (name, value, unsupported) = parse_agent_markdown(&safe).unwrap();
        assert_eq!(name, "reviewer");
        assert!(unsupported.is_empty());
        assert_eq!(value["instructions"], "Review the change carefully.");
        assert_eq!(value["reasoningEffort"], "high");
        assert_eq!(value["permissionMode"], "auto");

        let dynamic = root.join(".melody/agents/with-tools.md");
        fs::write(
            &dynamic,
            "---\nname: with-tools\ndescription: Dynamic\ntools: [workspace_write_file]\n---\nDo work.\n",
        )
        .unwrap();
        let (_, value, unsupported) = parse_agent_markdown(&dynamic).unwrap();
        assert!(
            unsupported.is_empty(),
            "a write-only tool list has an exact Pi ceiling"
        );
        assert_eq!(value["defaultCapabilityMode"], "read-write");

        let shell = root.join(".melody/agents/with-shell.md");
        fs::write(
            &shell,
            "---\nname: with-shell\ndescription: Shell\ntools: [\"Read\", \"Grep\", \"Bash\"]\n---\nRun checks.\n",
        )
        .unwrap();
        let (_, value, unsupported) = parse_agent_markdown(&shell).unwrap();
        assert!(unsupported.is_empty());
        assert_eq!(value["defaultCapabilityMode"], "execute");

        // An MCP allowlist is carried as exact grants instead of blocking, so a
        // definition like `literature-reviewer` keeps its Zotero tools.
        let mcp = root.join(".melody/agents/with-mcp.md");
        fs::write(
            &mcp,
            "---\nname: with-mcp\ndescription: Mcp\ntools: [\"Read\", \"Grep\", \"mcp__zotero__zotero_search_items\"]\n---\nSearch.\n",
        )
        .unwrap();
        let (_, value, unsupported) = parse_agent_markdown(&mcp).unwrap();
        assert!(unsupported.is_empty());
        assert_eq!(value["defaultCapabilityMode"], "read-only");
        assert_eq!(
            value["mcpTools"],
            serde_json::json!(["mcp__zotero__zotero_search_items"])
        );

        // A malformed MCP name and a denylist cannot be bounded, so they stay
        // on the compatibility engine instead of widening the child.
        for (file, body) in [
            (
                "with-bad-mcp.md",
                "---\nname: with-bad-mcp\ndescription: Bad\ntools: [\"Read\", \"mcp__zotero\"]\n---\nRead.\n",
            ),
            (
                "with-denylist.md",
                "---\nname: with-denylist\ndescription: Deny\ntools: [\"Read\"]\ndisallowedTools: [\"Bash\"]\n---\nRead.\n",
            ),
        ] {
            let path = root.join(".melody/agents").join(file);
            fs::write(&path, body).unwrap();
            let (_, _, unsupported) = parse_agent_markdown(&path).unwrap();
            assert_eq!(unsupported, vec!["tools"], "{file} must stay on ACP");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn projects_agent_definitions_into_pi_manifest() {
        let cwd =
            std::env::temp_dir().join(format!("melody-agent-manifest-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(cwd.join(".melody/agents")).unwrap();
        fs::write(
            cwd.join(".melody/agents/reviewer.md"),
            "---\nname: reviewer\nmodel: provider/reviewer\ncapability_mode: read-only\n---\nReview.\n",
        )
        .unwrap();
        fs::write(
            cwd.join(".melody/agents/plugin-agent.md"),
            "---\nname: plugin-agent\nhooks: {PreToolUse: []}\n---\nDynamic.\n",
        )
        .unwrap();
        unsafe {
            std::env::set_var("MELODY_HOME", cwd.join("user-home"));
        }
        let manifest = pi_subagent_policy_manifest(cwd.to_str().unwrap()).unwrap();
        assert!(
            manifest["agents"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["name"] == "reviewer")
        );
        assert!(
            manifest["unsupportedAgents"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry == "plugin-agent")
        );
        unsafe {
            std::env::remove_var("MELODY_HOME");
        }
        fs::remove_dir_all(cwd).unwrap();
    }

    #[test]
    fn tolerates_real_world_frontmatter_and_maps_tool_lists() {
        let root = std::env::temp_dir().join(format!("melody-agent-real-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".melody/agents")).unwrap();
        // A Claude-style definition: multi-line flow list, an example block with
        // colon-bearing prose lines, and cosmetic metadata.
        let path = root.join(".melody/agents/miner.md");
        fs::write(
            &path,
            "---\nname: miner\ndescription: Use this agent when mining. Examples:\n\n<example>\nContext: User asks\nuser: \"mine\"\nassistant: \"ok\"\n</example>\nmodel: inherit\ncolor: blue\ntools: [\"Read\", \"Write\", \"Grep\",\n  \"Bash\", \"TodoWrite\"]\n---\nMine carefully.\n",
        )
        .unwrap();
        let (name, value, unsupported) = parse_agent_markdown(&path).unwrap();
        assert_eq!(name, "miner");
        assert!(
            unsupported.is_empty(),
            "inert prose and a mapped tool list are not ACP-only: {unsupported:?}"
        );
        assert_eq!(value["defaultCapabilityMode"], "read-write-execute");
        assert_eq!(value["modelId"], "inherit");
        assert!(
            value.get("color").is_none(),
            "unknown keys never reach the policy"
        );
        assert_eq!(value["instructions"], "Mine carefully.");

        // A block list is read the same way.
        let block = root.join(".melody/agents/reader.md");
        fs::write(
            &block,
            "---\nname: reader\ndescription: Reads\ntools:\n  - Read\n  - Grep\n---\nRead.\n",
        )
        .unwrap();
        let (_, value, unsupported) = parse_agent_markdown(&block).unwrap();
        assert!(unsupported.is_empty());
        assert_eq!(value["defaultCapabilityMode"], "read-only");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn projects_plugin_agents_with_a_qualified_name() {
        let cwd =
            std::env::temp_dir().join(format!("melody-plugin-agents-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(cwd.join(".melody/plugins/tools/agents")).unwrap();
        fs::write(
            cwd.join(".melody/plugins/tools/agents/helper.md"),
            "---\nname: helper\ndescription: Helps\ntools: [\"Read\", \"Grep\"]\n---\nHelp.\n",
        )
        .unwrap();
        // The plugin also needs a conventional component root and explicit
        // enablement, matching Melody's plugin activation rules.
        fs::create_dir_all(cwd.join(".melody/plugins/tools/skills")).unwrap();
        fs::write(
            cwd.join(".melody/config.toml"),
            "[plugins]\nenabled = [\"tools\"]\ndisabled = []\n",
        )
        .unwrap();
        unsafe {
            std::env::set_var("MELODY_HOME", cwd.join("user-home"));
        }
        let manifest = pi_subagent_policy_manifest(cwd.to_str().unwrap()).unwrap();
        let names = manifest["agents"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|entry| entry["name"].as_str())
            .collect::<Vec<_>>();
        assert!(
            names.contains(&"tools:helper"),
            "a plugin agent stays reachable under its qualified name: {names:?}"
        );
        assert!(
            names.contains(&"helper"),
            "a free bare name is registered too: {names:?}"
        );
        unsafe {
            std::env::remove_var("MELODY_HOME");
        }
        fs::remove_dir_all(cwd).unwrap();
    }
}
