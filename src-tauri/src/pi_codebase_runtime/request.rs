//! Validation for untrusted Pi codebase-navigation requests.
//!
//! This owner turns worker arguments plus the Host-authorized workspace into
//! one normalized request. It does not select the tool route, load project
//! policy, touch the index, or compose the Host resolution envelope.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use super::parser::supports_path;

const MAX_QUERY_BYTES: usize = 256;
const MAX_POSITION: u64 = 100_000;
const MAX_FILE_PATH_BYTES: usize = 4_096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CodebaseOperation {
    Definition,
    References,
    DocumentSymbols,
    WorkspaceSymbols,
    Status,
    Rebuild,
    Refresh,
}

impl CodebaseOperation {
    fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "definition" | "goToDefinition" => Some(Self::Definition),
            "references" | "findReferences" => Some(Self::References),
            "documentSymbol" | "documentSymbols" => Some(Self::DocumentSymbols),
            "workspaceSymbol" | "workspaceSymbols" => Some(Self::WorkspaceSymbols),
            "status" | "indexStatus" => Some(Self::Status),
            "rebuild" => Some(Self::Rebuild),
            "refresh" => Some(Self::Refresh),
            _ => None,
        }
    }

    pub(super) fn requires_file(self) -> bool {
        matches!(
            self,
            Self::Definition | Self::References | Self::DocumentSymbols
        )
    }

    fn requires_position(self) -> bool {
        matches!(self, Self::Definition | Self::References)
    }

    pub(super) fn output_name(self) -> &'static str {
        match self {
            Self::Definition => "definition",
            Self::References => "references",
            Self::DocumentSymbols => "documentSymbols",
            Self::WorkspaceSymbols => "workspaceSymbols",
            Self::Status => "status",
            Self::Rebuild => "rebuild",
            Self::Refresh => "refresh",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ValidatedCodebaseRequest {
    pub(super) workspace_root: PathBuf,
    pub(super) operation: CodebaseOperation,
    pub(super) file_path: Option<PathBuf>,
    pub(super) line: Option<usize>,
    pub(super) character: Option<usize>,
    pub(super) query: Option<String>,
    pub(super) include_definition: bool,
}

/// Parse bounded worker arguments and bind any file path to the canonical
/// workspace. Validation order is part of the existing tool error contract.
pub(super) fn parse_request(
    workspace_root: &Path,
    arguments: &Map<String, Value>,
) -> Result<ValidatedCodebaseRequest, String> {
    let operation = arguments
        .get("operation")
        .and_then(Value::as_str)
        .and_then(CodebaseOperation::parse)
        .ok_or_else(|| "operation 必须是受支持的代码库导航操作。".to_string())?;
    let workspace_root = canonical_workspace(workspace_root)?;
    let file_path = match arguments.get("file_path").and_then(Value::as_str) {
        Some(path) => Some(normalize_file_path(&workspace_root, path)?),
        None if operation.requires_file() => {
            return Err("该代码库导航操作需要 file_path。".to_string());
        }
        None => None,
    };
    let line = parse_position(arguments, "line")?;
    let character = parse_position(arguments, "character")?;
    if operation.requires_position() && (line.is_none() || character.is_none()) {
        return Err("定义和引用查询需要 line 和 character。".to_string());
    }
    let query = parse_query(arguments)?;
    let include_definition = parse_include_definition(arguments)?;

    Ok(ValidatedCodebaseRequest {
        workspace_root,
        operation,
        file_path,
        line,
        character,
        query,
        include_definition,
    })
}

pub(super) fn canonical_workspace(root: &Path) -> Result<PathBuf, String> {
    let canonical = root
        .canonicalize()
        .map_err(|error| format!("无法解析代码库工作区路径：{error}"))?;
    if !canonical.is_dir() {
        return Err("代码库工作区路径不是目录。".to_string());
    }
    if canonical.parent().is_none() {
        return Err("文件系统根目录不能作为代码库工作区。".to_string());
    }
    Ok(canonical)
}

fn normalize_file_path(root: &Path, value: &str) -> Result<PathBuf, String> {
    if value.trim().is_empty() || value.len() > MAX_FILE_PATH_BYTES {
        return Err("file_path 必须是有效的工作区相对路径。".to_string());
    }
    let candidate = PathBuf::from(value);
    if candidate.is_absolute() {
        return Err("file_path 必须是工作区相对路径。".to_string());
    }
    let canonical = root
        .join(candidate)
        .canonicalize()
        .map_err(|error| format!("无法读取代码文件：{error}"))?;
    if !canonical.starts_with(root) || !canonical.is_file() {
        return Err("代码文件必须位于当前工作区内。".to_string());
    }
    if !supports_path(&canonical) {
        return Err("代码库导航暂不支持该文件类型。".to_string());
    }
    Ok(canonical)
}

fn parse_include_definition(arguments: &Map<String, Value>) -> Result<bool, String> {
    match arguments.get("include_definition") {
        None | Some(Value::Null) => Ok(true),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err("include_definition 必须是布尔值。".to_string()),
    }
}

fn parse_position(arguments: &Map<String, Value>, key: &str) -> Result<Option<usize>, String> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => {
            let value = number
                .as_u64()
                .ok_or_else(|| format!("{key} 必须是非负整数。"))?;
            if value > MAX_POSITION {
                return Err(format!("{key} 超过位置上限 {MAX_POSITION}。"));
            }
            usize::try_from(value)
                .map(Some)
                .map_err(|_| format!("{key} 超过当前平台整数上限。"))
        }
        Some(_) => Err(format!("{key} 必须是非负整数。")),
    }
}

fn parse_query(arguments: &Map<String, Value>) -> Result<Option<String>, String> {
    match arguments.get("query") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(query))
            if !query.trim().is_empty() && query.len() <= MAX_QUERY_BYTES =>
        {
            Ok(Some(query.trim().to_string()))
        }
        Some(Value::String(_)) => Err("query 不能为空且不得超过 256 字节。".to_string()),
        Some(_) => Err("query 必须是字符串。".to_string()),
    }
}
