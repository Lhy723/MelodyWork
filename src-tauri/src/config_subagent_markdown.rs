//! Bounded parser for declarative Markdown subagent definitions.
//!
//! This module owns the frontmatter field contract and the capability-ceiling
//! projection for tool allowlists. Directory precedence and manifest assembly
//! remain in the parent config owner.

use std::{fs, path::Path};

use serde_json::{Map, Value};

pub(super) const MAX_NAME_BYTES: usize = 128;
pub(super) const MAX_TEXT_BYTES: usize = 32 * 1024;
pub(super) const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// Must match the worker's `MAX_MCP_TOOLS` bound so an over-long grant list
/// fails the Host preflight instead of the session.
pub(super) const MAX_MCP_TOOL_GRANTS: usize = 64;
pub(super) const MAX_MCP_SERVER_NAME_BYTES: usize = 64;
pub(super) const MAX_MCP_TOOL_NAME_BYTES: usize = 96;
/// The worker also caps the complete `mcp__<server>__<tool>` name at 128 bytes.
pub(super) const MAX_MCP_FULL_NAME_BYTES: usize = 128;

/// Top-level fields that can be represented without giving Pi a dynamic
/// executable tool graph.
pub(super) const SAFE_AGENT_FIELDS: &[&str] = &[
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
pub(super) const POLICY_AGENT_FIELDS: &[&str] = &[
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

pub(super) fn valid_name(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= MAX_NAME_BYTES
        && !value.chars().any(|character| character.is_control())
}

pub(super) fn bounded_text(value: Option<&Value>, max: usize) -> Option<String> {
    let value = value?.as_str()?.trim();
    if value.is_empty() || value.len() > max || value.chars().any(|c| c.is_control()) {
        return None;
    }
    Some(value.to_string())
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
                .filter(|item| !item.is_empty())
                .collect();
        }
        let inner = value[1..value.len() - 1].trim();
        if inner.is_empty() {
            return Vec::new();
        }
        return inner
            .split(',')
            .map(|item| item.trim().trim_matches(['"', '\'']).trim().to_string())
            .filter(|item| !item.is_empty())
            .collect();
    }
    value
        .split(',')
        .map(|item| item.trim().trim_matches(['"', '\'']).trim().to_string())
        .filter(|item| !item.is_empty())
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
        if tool.len() > MAX_NAME_BYTES {
            return None;
        }
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
pub(super) fn valid_mcp_tool_name(value: &str) -> bool {
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
    value.len() <= MAX_MCP_FULL_NAME_BYTES
        && bounded(server, MAX_MCP_SERVER_NAME_BYTES)
        && bounded(tool, MAX_MCP_TOOL_NAME_BYTES)
}

/// Resolve `tools`/`disallowedTools` into a capability ceiling plus exact MCP
/// grants, and drop the raw lists so the worker only sees bounded policy.
pub(super) fn apply_agent_tool_ceiling(
    object: &mut Map<String, Value>,
    unsupported: &mut Vec<String>,
) {
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
            .filter(|item| !item.is_empty())
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

pub(super) fn parse_agent_markdown(path: &Path) -> Result<(String, Value, Vec<String>), String> {
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
                if !item.is_empty() {
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
