//! Host-owned codebase navigation for the Pi worker.
//!
//! Melody-build ships a tree-sitter powered code graph. Pi does not expose a
//! workspace index itself, so the worker uses this deliberately small Host
//! bridge instead. The index is read-only, bounded, gitignore-aware and kept
//! per authorized workspace. It supports the same high-value navigation
//! primitives agents use most often: definitions, references, document
//! symbols and workspace symbols.
//!
//! This is not an ambient language-server or shell escape. The Host owns the
//! parser, file walk and cache; the worker receives only a bounded JSON
//! result. LSP remains available for language-server-specific semantics when
//! a project configures a trusted server.

use std::path::Path;

use serde_json::{Value, json};

use crate::{
    config_core::read_melody_config_inner,
    pi_tool_gateway::{self, success_for_request, tool_request_arguments},
};

#[path = "pi_codebase_runtime/index.rs"]
mod index;
#[path = "pi_codebase_runtime/parser.rs"]
mod parser;
#[path = "pi_codebase_runtime/request.rs"]
mod request;
use self::index::with_index;
use self::request::{CodebaseOperation, parse_request};

pub(crate) const CODEBASE_TOOL: &str = "codebase_navigation";

const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_INDEX_PATTERNS: usize = 64;
const MAX_INDEX_PATTERN_BYTES: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
enum CodebaseIndexingPolicy {
    Enabled(bool),
    Patterns(Vec<String>),
}

impl Default for CodebaseIndexingPolicy {
    fn default() -> Self {
        Self::Enabled(true)
    }
}

impl CodebaseIndexingPolicy {
    /// Match Melody-build's `features.codebase_indexing` semantics. Patterns
    /// are evaluated against the canonical repository/workspace path; a
    /// leading `!` excludes a match, and an empty include set means "all".
    fn should_index(&self, root: &Path) -> Result<bool, String> {
        match self {
            Self::Enabled(enabled) => Ok(*enabled),
            Self::Patterns(patterns) => {
                let path = root.to_string_lossy().replace('\\', "/");
                let mut includes = Vec::new();
                let mut excludes = Vec::new();
                for raw in patterns {
                    let (exclude, pattern) = raw
                        .strip_prefix('!')
                        .map_or((false, raw.as_str()), |value| (true, value));
                    let pattern = pattern.trim();
                    if pattern.is_empty() {
                        return Err("codebase_indexing 的路径 glob 不能为空。".to_string());
                    }
                    let pattern = pattern.replace('\\', "/");
                    let matcher = glob::Pattern::new(&pattern)
                        .map_err(|error| format!("codebase_indexing 路径 glob 无效：{error}"))?;
                    if exclude {
                        excludes.push(matcher);
                    } else {
                        includes.push(matcher);
                    }
                }
                let included =
                    includes.is_empty() || includes.iter().any(|glob| glob.matches(&path));
                let excluded = excludes.iter().any(|glob| glob.matches(&path));
                Ok(included && !excluded)
            }
        }
    }
}

fn parse_codebase_indexing_value(value: &Value) -> Result<CodebaseIndexingPolicy, String> {
    match value {
        Value::Bool(enabled) => Ok(CodebaseIndexingPolicy::Enabled(*enabled)),
        Value::Array(values) => {
            if values.len() > MAX_INDEX_PATTERNS {
                return Err(format!(
                    "codebase_indexing 路径 glob 不能超过 {MAX_INDEX_PATTERNS} 项。"
                ));
            }
            let mut patterns = Vec::with_capacity(values.len());
            for value in values {
                let Some(pattern) = value.as_str() else {
                    return Err("codebase_indexing 路径 glob 必须是字符串。".to_string());
                };
                let pattern = pattern.trim();
                if pattern.is_empty() || pattern.len() > MAX_INDEX_PATTERN_BYTES {
                    return Err(format!(
                        "codebase_indexing 路径 glob 必须为 1-{MAX_INDEX_PATTERN_BYTES} 个字节。"
                    ));
                }
                // Compile during parsing so malformed config cannot be
                // accepted and fail later after an index has been built.
                let matcher = pattern
                    .strip_prefix('!')
                    .unwrap_or(pattern)
                    .replace('\\', "/");
                if matcher.trim().is_empty() {
                    return Err("codebase_indexing 的路径 glob 不能为空。".to_string());
                }
                glob::Pattern::new(&matcher)
                    .map_err(|error| format!("codebase_indexing 路径 glob 无效：{error}"))?;
                patterns.push(pattern.to_string());
            }
            Ok(CodebaseIndexingPolicy::Patterns(patterns))
        }
        _ => Err("features.codebase_indexing 必须是布尔值或字符串数组。".to_string()),
    }
}

/// Read the effective codebase-indexing policy with the same precedence as
/// the other Host projections: project values override user values. A parse
/// failure is fatal here so Pi never silently indexes a workspace under an
/// unknown policy.
fn codebase_indexing_policy(root: &Path) -> Result<CodebaseIndexingPolicy, String> {
    let mut policy = CodebaseIndexingPolicy::default();
    let root = root.to_string_lossy().into_owned();
    for scope in ["user", "project"] {
        let document = read_melody_config_inner(scope.to_string(), root.clone())?;
        if let Some(error) = document.parse_error {
            return Err(format!("无法解析 {scope} Melody 配置：{error}"));
        }
        if let Some(value) = document
            .values
            .get("features")
            .and_then(Value::as_object)
            .and_then(|features| features.get("codebase_indexing"))
        {
            policy = parse_codebase_indexing_value(value)?;
        }
    }
    Ok(policy)
}

fn bounded_text(value: String) -> String {
    if value.len() <= MAX_OUTPUT_BYTES {
        return value;
    }
    const SUFFIX: &str = "\n[output truncated]";
    let mut end = MAX_OUTPUT_BYTES.saturating_sub(SUFFIX.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    let mut output = value[..end].to_string();
    output.push_str(SUFFIX);
    output
}

/// Return the codebase operation represented by a worker tool request.
pub(crate) fn codebase_tool_kind(value: &Value) -> Option<&'static str> {
    let (_, _, _, tool_name, _, _) = pi_tool_gateway::event_context(value).ok()?;
    (tool_name == CODEBASE_TOOL).then_some("request")
}

/// Resolve a codebase navigation request through the Host-owned index.
pub(crate) fn resolve_request(root: &Path, value: &Value) -> Value {
    let (tool_name, arguments) = match tool_request_arguments(value) {
        Ok((tool_name, arguments)) => (tool_name, arguments),
        Err(error) => {
            return pi_tool_gateway::fail_for_request(value, "pi.invalid_tool_request", error);
        }
    };
    if tool_name != CODEBASE_TOOL {
        return pi_tool_gateway::fail_for_request(
            value,
            "pi.tool_not_allowed",
            "不是代码库导航工具请求。".to_string(),
        );
    }
    let request = match parse_request(root, arguments) {
        Ok(request) => request,
        Err(error) => {
            return pi_tool_gateway::fail_for_request(value, "pi.codebase_tool_failed", error);
        }
    };
    let root = request.workspace_root;
    let operation = request.operation;
    let file_path = request.file_path;
    let line = request.line;
    let character = request.character;
    let query = request.query;
    let include_definition = request.include_definition;
    let indexing_policy = match codebase_indexing_policy(&root) {
        Ok(policy) => policy,
        Err(error) => {
            return pi_tool_gateway::fail_for_request(value, "pi.codebase_tool_failed", error);
        }
    };
    match indexing_policy.should_index(&root) {
        Ok(true) => {}
        Ok(false) => {
            let output = json!({
                "operation": operation.output_name(),
                "enabled": false,
                "reason": "disabled_by_config",
                "locations": [],
            });
            let output = match serde_json::to_string(&output) {
                Ok(output) => bounded_text(output),
                Err(error) => {
                    return pi_tool_gateway::fail_for_request(
                        value,
                        "pi.codebase_tool_failed",
                        format!("代码索引结果序列化失败：{error}"),
                    );
                }
            };
            return success_for_request(value, output);
        }
        Err(error) => {
            return pi_tool_gateway::fail_for_request(value, "pi.codebase_tool_failed", error);
        }
    }
    let output = match with_index(&root, operation == CodebaseOperation::Rebuild, |index| {
        match operation {
            CodebaseOperation::Status | CodebaseOperation::Rebuild | CodebaseOperation::Refresh => {
                json!({
                    "operation": match operation {
                        CodebaseOperation::Rebuild => "rebuild",
                        CodebaseOperation::Refresh => "refresh",
                        _ => "status",
                    },
                    "index": index.status(),
                })
            }
            CodebaseOperation::Definition => {
                let path = file_path.expect("file path is required above");
                let symbol = line
                    .and_then(|line| {
                        character.map(|character| index.symbol_at(&path, line, character))
                    })
                    .flatten();
                let locations = symbol
                    .as_deref()
                    .map(|symbol| index.locations_for_symbol(symbol, false, true))
                    .unwrap_or_default();
                json!({ "operation": "definition", "symbol": symbol, "locations": locations, "index": index.status() })
            }
            CodebaseOperation::References => {
                let path = file_path.expect("file path is required above");
                let symbol = line
                    .and_then(|line| {
                        character.map(|character| index.symbol_at(&path, line, character))
                    })
                    .flatten();
                let locations = symbol
                    .as_deref()
                    .map(|symbol| index.locations_for_symbol(symbol, true, include_definition))
                    .unwrap_or_default();
                json!({ "operation": "references", "symbol": symbol, "includeDefinition": include_definition, "locations": locations, "index": index.status() })
            }
            CodebaseOperation::DocumentSymbols => {
                let path = file_path.expect("file path is required above");
                json!({ "operation": "documentSymbols", "locations": index.document_locations(&path), "index": index.status() })
            }
            CodebaseOperation::WorkspaceSymbols => {
                let query = query.unwrap_or_default();
                json!({ "operation": "workspaceSymbols", "query": query, "locations": index.workspace_locations(&query), "index": index.status() })
            }
        }
    }) {
        Ok(output) => output,
        Err(error) => {
            return pi_tool_gateway::fail_for_request(value, "pi.codebase_tool_failed", error);
        }
    };
    let output = match serde_json::to_string(&output) {
        Ok(output) => bounded_text(output),
        Err(error) => {
            return pi_tool_gateway::fail_for_request(
                value,
                "pi.codebase_tool_failed",
                format!("代码索引结果序列化失败：{error}"),
            );
        }
    };
    success_for_request(value, output)
}
