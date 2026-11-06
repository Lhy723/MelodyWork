//! Bounded loading and preflight projection for trusted command-hook definitions.
//!
//! Unsupported events and fields remain visible to capability preflight so the
//! Host never silently drops an enabled hook surface.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde_json::{Map, Value};

use crate::config_core::{melody_home, project_melody_root};

const MAX_HOOK_FILES: usize = 64;
const MAX_HOOKS_PER_FILE: usize = 128;
const MAX_HOOKS_TOTAL: usize = 256;
const MAX_HOOK_FILE_BYTES: u64 = 1024 * 1024;
const MAX_HOOK_COMMAND_BYTES: usize = 4096;
const MAX_HOOK_MATCHER_BYTES: usize = 512;
const MAX_HOOK_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_HOOK_TIMEOUT_MS: u64 = 5_000;

/// Events that the Host can execute without changing Pi's model context or
/// pretending that a late lifecycle decision can rewind a completed turn.
const SUPPORTED_EVENTS: &[&str] = &[
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionDenied",
    "SessionStart",
    "SessionEnd",
    "PreCompact",
    "PostCompact",
    "SubagentStart",
    "SubagentStop",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct HookSpec {
    pub(super) event: String,
    pub(super) matcher: Option<String>,
    pub(super) command: String,
    pub(super) timeout_ms: u64,
    pub(super) source: PathBuf,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MelodyHookSnapshot {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) scope: String,
    pub(crate) enabled: bool,
    pub(crate) supported: bool,
    pub(crate) unsupported_fields: Vec<String>,
}

#[derive(Clone, Debug)]
struct ParsedHookFile {
    specs: Vec<HookSpec>,
    unsupported_fields: Vec<String>,
}

fn bounded_text(value: Option<&Value>, max: usize) -> Option<String> {
    let value = value?.as_str()?.trim();
    if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return None;
    }
    Some(value.to_string())
}

fn valid_matcher(value: &str) -> bool {
    value.len() <= MAX_HOOK_MATCHER_BYTES
        && !value.chars().any(char::is_control)
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ":_./*-|, ".contains(character))
}

fn parse_timeout(object: &Map<String, Value>) -> Result<u64, String> {
    let raw = object.get("timeoutMs").or_else(|| object.get("timeout_ms"));
    let Some(raw) = raw else {
        return Ok(DEFAULT_HOOK_TIMEOUT_MS);
    };
    let value = raw
        .as_u64()
        .ok_or_else(|| "timeoutMs must be a positive integer".to_string())?;
    if !(1..=MAX_HOOK_TIMEOUT_MS).contains(&value) {
        return Err(format!(
            "timeoutMs must be between 1 and {MAX_HOOK_TIMEOUT_MS}"
        ));
    }
    Ok(value)
}

fn parse_hook_entry(
    event: &str,
    raw: &Value,
    source: &Path,
    index: usize,
    specs: &mut Vec<HookSpec>,
    unsupported: &mut Vec<String>,
) {
    let Some(object) = raw.as_object() else {
        unsupported.push(format!("{event}[{index}]"));
        return;
    };
    for key in object.keys() {
        if key != "matcher" && key != "hooks" {
            unsupported.push(format!("{event}[{index}].{key}"));
        }
    }
    if let Some(matcher) = object.get("matcher") {
        let Some(matcher) = matcher.as_str() else {
            unsupported.push(format!("{event}[{index}].matcher"));
            return;
        };
        if !valid_matcher(matcher) {
            unsupported.push(format!("{event}[{index}].matcher"));
            return;
        }
    }
    let Some(hooks) = object.get("hooks").and_then(Value::as_array) else {
        unsupported.push(format!("{event}[{index}].hooks"));
        return;
    };
    for (hook_index, raw_hook) in hooks.iter().take(MAX_HOOKS_PER_FILE).enumerate() {
        let Some(hook) = raw_hook.as_object() else {
            unsupported.push(format!("{event}[{index}].hooks[{hook_index}]"));
            continue;
        };
        for key in hook.keys() {
            if !matches!(
                key.as_str(),
                "type" | "command" | "timeoutMs" | "timeout_ms"
            ) {
                unsupported.push(format!("{event}[{index}].hooks[{hook_index}].{key}"));
            }
        }
        if hook.get("type").and_then(Value::as_str) != Some("command") {
            unsupported.push(format!("{event}[{index}].hooks[{hook_index}].type"));
            continue;
        }
        let Some(command) = bounded_text(hook.get("command"), MAX_HOOK_COMMAND_BYTES) else {
            unsupported.push(format!("{event}[{index}].hooks[{hook_index}].command"));
            continue;
        };
        let timeout_ms = match parse_timeout(hook) {
            Ok(value) => value,
            Err(_) => {
                unsupported.push(format!("{event}[{index}].hooks[{hook_index}].timeoutMs"));
                continue;
            }
        };
        specs.push(HookSpec {
            event: event.to_string(),
            matcher: object
                .get("matcher")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            command,
            timeout_ms,
            source: source.to_path_buf(),
        });
    }
}

fn parse_hook_file(path: &Path) -> Result<ParsedHookFile, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("hook definition is not a regular file".to_string());
    }
    if metadata.len() > MAX_HOOK_FILE_BYTES {
        return Err("hook definition exceeds 1 MB".to_string());
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let value: Value = serde_json::from_str(&content).map_err(|error| error.to_string())?;
    let root = value.get("hooks").unwrap_or(&value);
    let Some(root) = root.as_object() else {
        return Err("hooks must be an object".to_string());
    };
    let mut specs = Vec::new();
    let mut unsupported_fields = Vec::new();
    for (event, raw_entries) in root {
        if !SUPPORTED_EVENTS.contains(&event.as_str()) {
            unsupported_fields.push(event.clone());
            continue;
        }
        let Some(entries) = raw_entries.as_array() else {
            unsupported_fields.push(event.clone());
            continue;
        };
        for (index, raw) in entries.iter().take(MAX_HOOKS_PER_FILE).enumerate() {
            parse_hook_entry(event, raw, path, index, &mut specs, &mut unsupported_fields);
        }
        if entries.len() > MAX_HOOKS_PER_FILE {
            unsupported_fields.push(format!("{event}[overflow]"));
        }
    }
    unsupported_fields.sort();
    unsupported_fields.dedup();
    Ok(ParsedHookFile {
        specs,
        unsupported_fields,
    })
}

fn hook_roots(cwd: &str) -> Result<Vec<(PathBuf, String)>, String> {
    let cwd = PathBuf::from(cwd);
    if !cwd.is_dir() {
        return Err(format!("Workspace does not exist: {}", cwd.display()));
    }
    Ok(vec![
        (
            project_melody_root(cwd.to_string_lossy().as_ref())?.join("hooks"),
            "project".to_string(),
        ),
        (melody_home()?.join("hooks"), "user".to_string()),
    ])
}

fn hook_files(cwd: &str) -> Result<Vec<(PathBuf, String)>, String> {
    let mut files = Vec::new();
    for (root, scope) in hook_roots(cwd)? {
        let Ok(root_metadata) = fs::symlink_metadata(&root) else {
            continue;
        };
        if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
            continue;
        }
        let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        let mut entries = entries.flatten().collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if files.len() >= MAX_HOOK_FILES {
                break;
            }
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                continue;
            }
            let canonical = match path.canonicalize() {
                Ok(path) if path.parent().is_some_and(|parent| parent == canonical_root) => path,
                _ => continue,
            };
            files.push((canonical, scope.clone()));
        }
    }
    Ok(files)
}

pub(super) fn read_hook_specs(cwd: &str) -> Result<(Vec<HookSpec>, Vec<String>), String> {
    let mut specs = Vec::new();
    let mut warnings = Vec::new();
    for (path, _scope) in hook_files(cwd)? {
        match parse_hook_file(&path) {
            Ok(parsed) => {
                specs.extend(parsed.specs);
                warnings.extend(
                    parsed
                        .unsupported_fields
                        .into_iter()
                        .map(|field| format!("{}: {field}", path.display())),
                );
            }
            Err(error) => warnings.push(format!("{}: {error}", path.display())),
        }
        if specs.len() >= MAX_HOOKS_TOTAL {
            break;
        }
    }
    specs.truncate(MAX_HOOKS_TOTAL);
    Ok((specs, warnings))
}

/// Return the files that can be safely executed by the Pi Host hook runner.
/// A file with any unsupported field is marked unsupported so capability
/// preflight can route the whole workspace to ACP rather than partially
/// applying the hook graph.
pub(crate) fn list_melody_hooks(cwd: &str) -> Result<Vec<MelodyHookSnapshot>, String> {
    let mut result = Vec::new();
    for (path, scope) in hook_files(cwd)? {
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("hook.json")
            .to_string();
        let (supported, unsupported_fields) = match parse_hook_file(&path) {
            Ok(parsed) => (
                parsed.unsupported_fields.is_empty(),
                parsed.unsupported_fields,
            ),
            Err(error) => (false, vec![error]),
        };
        result.push(MelodyHookSnapshot {
            name,
            path: path.to_string_lossy().into_owned(),
            scope,
            enabled: true,
            supported,
            unsupported_fields,
        });
    }

    // Legacy Melody/Claude installations often keep shell/JS hook files next
    // to JSON definitions. They cannot be executed by this restricted
    // runner, but must still be reported so capability preflight does not
    // silently drop them. Directories are included for the same reason:
    // arbitrary hook bundles remain ACP-backed until a safe manifest exists.
    for (root, scope) in hook_roots(cwd)? {
        let Ok(root_metadata) = fs::symlink_metadata(&root) else {
            continue;
        };
        if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
            continue;
        }
        let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        let mut entries = entries.flatten().collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if result.len() >= MAX_HOOK_FILES {
                break;
            }
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) == Some("json") {
                continue;
            }
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            let Ok(canonical) = path.canonicalize() else {
                continue;
            };
            if canonical.parent() != Some(canonical_root.as_path()) {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("hook")
                .to_string();
            result.push(MelodyHookSnapshot {
                name,
                path: canonical.to_string_lossy().into_owned(),
                scope: scope.clone(),
                enabled: true,
                supported: false,
                unsupported_fields: vec!["fileExtension".to_string()],
            });
        }
    }
    Ok(result)
}
