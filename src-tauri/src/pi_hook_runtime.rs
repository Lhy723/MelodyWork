//! Host-owned compatibility runner for the declarative command-hook subset.
//!
//! Melody/Claude hooks are normally arbitrary extension code.  Pi must not
//! load that code in the worker, so this module accepts only the standard JSON
//! command-hook shape from trusted `.melody/hooks` roots and executes the
//! command in the Host with a clean, bounded environment.  Unsupported hook
//! types/events are reported to capability preflight and keep the session on
//! ACP instead of being silently ignored.

use std::{
    env, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde_json::{Map, Value};

use crate::config_runtime::{melody_home, project_melody_root};

const MAX_HOOK_FILES: usize = 64;
const MAX_HOOKS_PER_FILE: usize = 128;
const MAX_HOOKS_TOTAL: usize = 256;
const MAX_HOOK_FILE_BYTES: u64 = 1024 * 1024;
const MAX_HOOK_COMMAND_BYTES: usize = 4096;
const MAX_HOOK_MATCHER_BYTES: usize = 512;
const MAX_HOOK_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_HOOK_TIMEOUT_MS: u64 = 5_000;
const MAX_HOOK_INPUT_BYTES: usize = 256 * 1024;
const MAX_HOOK_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_HOOK_REASON_BYTES: usize = 4 * 1024;

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
pub(crate) struct HookSpec {
    pub(crate) event: String,
    pub(crate) matcher: Option<String>,
    pub(crate) command: String,
    pub(crate) timeout_ms: u64,
    pub(crate) source: PathBuf,
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

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct HookRunResult {
    pub(crate) blocked: bool,
    pub(crate) reason: Option<String>,
    pub(crate) warnings: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HookEvent {
    PreToolUse,
    PostToolUse,
    PostToolUseFailure,
    PermissionDenied,
    SessionStart,
    SessionEnd,
    PreCompact,
    PostCompact,
    SubagentStart,
    SubagentStop,
}

impl HookEvent {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::PreToolUse => "PreToolUse",
            Self::PostToolUse => "PostToolUse",
            Self::PostToolUseFailure => "PostToolUseFailure",
            Self::PermissionDenied => "PermissionDenied",
            Self::SessionStart => "SessionStart",
            Self::SessionEnd => "SessionEnd",
            Self::PreCompact => "PreCompact",
            Self::PostCompact => "PostCompact",
            Self::SubagentStart => "SubagentStart",
            Self::SubagentStop => "SubagentStop",
        }
    }
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

fn read_hook_specs(cwd: &str) -> Result<(Vec<HookSpec>, Vec<String>), String> {
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

fn glob_match(pattern: &str, value: &str) -> bool {
    if !pattern.contains('*') {
        return pattern == value;
    }
    let mut remainder = value;
    for (index, segment) in pattern.split('*').enumerate() {
        if segment.is_empty() {
            continue;
        }
        if index == 0 && !pattern.starts_with('*') {
            if !remainder.starts_with(segment) {
                return false;
            }
            remainder = &remainder[segment.len()..];
        } else if index == pattern.split('*').count() - 1 && !pattern.ends_with('*') {
            return remainder.ends_with(segment);
        } else if let Some(offset) = remainder.find(segment) {
            remainder = &remainder[offset + segment.len()..];
        } else {
            return false;
        }
    }
    true
}

fn matcher_matches(matcher: Option<&str>, value: Option<&str>) -> bool {
    let Some(matcher) = matcher.filter(|value| !value.trim().is_empty()) else {
        return true;
    };
    let Some(value) = value else {
        return false;
    };
    matcher
        .split(['|', ','])
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .any(|part| part == "*" || glob_match(part, value))
}

fn bounded_output(mut bytes: Vec<u8>) -> String {
    bytes.truncate(MAX_HOOK_OUTPUT_BYTES);
    String::from_utf8_lossy(&bytes).trim().to_string()
}

fn read_pipe(pipe: impl Read + Send + 'static) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = pipe
            .take((MAX_HOOK_OUTPUT_BYTES + 1) as u64)
            .read_to_end(&mut bytes);
        bytes
    })
}

fn write_stdin(mut stdin: ChildStdin, payload: &[u8]) {
    let _ = stdin.write_all(payload);
}

fn reap_child(child: &mut Child, timeout_ms: u64) -> Result<(bool, String, String), String> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "hook stdout pipe unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "hook stderr pipe unavailable".to_string())?;
    let stdout_thread = read_pipe(stdout);
    let stderr_thread = read_pipe(stderr);
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut timed_out = false;
    loop {
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            break;
        }
        if Instant::now() >= deadline {
            timed_out = true;
            let _ = child.kill();
            let _ = child.wait();
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    let status = child.try_wait().ok().flatten();
    let stdout = bounded_output(stdout_thread.join().unwrap_or_default());
    let stderr = bounded_output(stderr_thread.join().unwrap_or_default());
    Ok((
        !timed_out && status.is_some_and(|status| status.success()),
        stdout,
        stderr,
    ))
}

fn run_hook_command(
    root: &Path,
    spec: &HookSpec,
    payload: &Value,
) -> Result<(bool, String, String), String> {
    let mut process = if cfg!(windows) {
        let mut command = Command::new("cmd");
        command.args(["/C", &spec.command]);
        command
    } else {
        let mut command = Command::new("/bin/sh");
        command.args(["-lc", &spec.command]);
        command
    };
    let input = serde_json::to_vec(payload).map_err(|error| error.to_string())?;
    if input.len() > MAX_HOOK_INPUT_BYTES {
        return Err("hook payload exceeds 256 KiB".to_string());
    }
    let mut child = process
        .current_dir(root)
        .env_clear()
        .env("PATH", env::var_os("PATH").unwrap_or_default())
        .env("MELODY_HOOK_EVENT", &spec.event)
        .env("MELODY_HOOK_SOURCE", spec.source.to_string_lossy().as_ref())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("cannot start hook command: {error}"))?;
    if let Some(stdin) = child.stdin.take() {
        let input = input.clone();
        thread::spawn(move || write_stdin(stdin, &input));
    }
    reap_child(&mut child, spec.timeout_ms)
}

fn event_name(payload: &Value) -> Option<&str> {
    payload
        .get("toolName")
        .or_else(|| payload.get("name"))
        .or_else(|| payload.get("taskId"))
        .or_else(|| {
            payload
                .get("event")
                .and_then(Value::as_object)
                .and_then(|event| event.get("type"))
        })
        .and_then(Value::as_str)
}

fn decision_from_output(output: &str) -> Option<(bool, Option<String>)> {
    let value: Value = serde_json::from_str(output).ok()?;
    let decision = value.get("decision").and_then(Value::as_str)?;
    let blocked = matches!(decision.to_ascii_lowercase().as_str(), "deny" | "block");
    let reason = value.get("reason").and_then(Value::as_str).map(|reason| {
        reason
            .chars()
            .take(MAX_HOOK_REASON_BYTES)
            .collect::<String>()
    });
    Some((blocked, reason))
}

fn payload_for_request(request: &Value, resolution: Option<&Value>, event: HookEvent) -> Value {
    let event_object = request.get("event").and_then(Value::as_object);
    let mut payload = Map::new();
    payload.insert(
        "event".to_string(),
        Value::String(event.as_str().to_string()),
    );
    for key in ["sessionId", "runId"] {
        if let Some(value) = request.get(key).and_then(Value::as_str) {
            payload.insert(key.to_string(), Value::String(value.to_string()));
        }
    }
    for key in ["toolCallId", "toolName"] {
        if let Some(value) = event_object
            .and_then(|object| object.get(key))
            .and_then(Value::as_str)
        {
            payload.insert(key.to_string(), Value::String(value.to_string()));
        }
    }
    if let Some(arguments) = event_object
        .and_then(|object| object.get("activity"))
        .and_then(Value::as_object)
        .and_then(|activity| activity.get("arguments"))
    {
        payload.insert("arguments".to_string(), arguments.clone());
    }
    if let Some(resolution) = resolution {
        payload.insert("resolution".to_string(), resolution.clone());
    }
    Value::Object(payload)
}

/// Run all matching command hooks for one normalized tool request. Pre-tool
/// decisions can block the request; post/failure hooks are observational.
fn run_hooks(root: &Path, event: HookEvent, payload: &Value) -> HookRunResult {
    let cwd = root.to_string_lossy().into_owned();
    let (specs, parse_warnings) = match read_hook_specs(&cwd) {
        Ok(value) => value,
        Err(error) => {
            return HookRunResult {
                warnings: vec![error],
                ..HookRunResult::default()
            };
        }
    };
    let name = event_name(payload);
    let mut result = HookRunResult {
        warnings: parse_warnings,
        ..HookRunResult::default()
    };
    for spec in specs.iter().filter(|spec| {
        spec.event == event.as_str() && matcher_matches(spec.matcher.as_deref(), name)
    }) {
        match run_hook_command(root, spec, payload) {
            Ok((success, stdout, stderr)) => {
                if !success {
                    result.warnings.push(format!(
                        "{} hook failed{}{}",
                        spec.source.display(),
                        if stderr.is_empty() { "" } else { ": " },
                        stderr
                    ));
                }
                if event == HookEvent::PreToolUse {
                    if let Some((blocked, reason)) = decision_from_output(&stdout) {
                        if blocked {
                            result.blocked = true;
                            result.reason =
                                reason.or_else(|| Some("Hook denied this tool call.".to_string()));
                            break;
                        }
                    }
                }
            }
            Err(error) => result
                .warnings
                .push(format!("{} hook skipped: {error}", spec.source.display())),
        }
    }
    result
}

pub(crate) fn run_tool_hooks(
    root: &Path,
    event: HookEvent,
    request: &Value,
    resolution: Option<&Value>,
) -> HookRunResult {
    let payload = payload_for_request(request, resolution, event);
    run_hooks(root, event, &payload)
}

/// Run a non-tool lifecycle hook with the normalized event payload. Lifecycle
/// hooks are observational in Pi; only `PreToolUse` is allowed to block a
/// model tool call because later events cannot safely rewind a completed turn.
pub(crate) fn run_event_hooks(root: &Path, event: HookEvent, payload: &Value) -> HookRunResult {
    run_hooks(root, event, payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_pipe_and_wildcard_matchers() {
        assert!(matcher_matches(Some("Bash|Edit"), Some("Edit")));
        assert!(matcher_matches(Some("mcp__*"), Some("mcp__github")));
        assert!(!matcher_matches(Some("Bash|Edit"), Some("Read")));
        assert!(!matcher_matches(Some("Bash"), Some("BashExtra")));
        assert!(matcher_matches(None, Some("Read")));
    }

    #[test]
    fn parses_standard_command_hooks_and_rejects_dynamic_events() {
        let root = std::env::temp_dir().join(format!("melody-pi-hooks-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".melody/hooks")).unwrap();
        let path = root.join(".melody/hooks/standard.json");
        fs::write(
            &path,
            serde_json::json!({
                "hooks": {
                    "PreToolUse": [{"matcher": "Bash|Edit", "hooks": [{"type": "command", "command": "printf ok"}]}],
                    "Stop": [{"hooks": [{"type": "command", "command": "printf nope"}]}]
                }
            })
            .to_string(),
        )
        .unwrap();
        unsafe {
            std::env::set_var("MELODY_HOME", root.join("user-home"));
        }
        let snapshots = list_melody_hooks(root.to_str().unwrap()).unwrap();
        assert_eq!(snapshots.len(), 1);
        assert!(!snapshots[0].supported);
        assert!(
            snapshots[0]
                .unsupported_fields
                .iter()
                .any(|field| field == "Stop")
        );
        let parsed = parse_hook_file(&path).unwrap();
        assert_eq!(parsed.specs.len(), 1);
        assert_eq!(parsed.specs[0].event, "PreToolUse");
        unsafe {
            std::env::remove_var("MELODY_HOME");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn pre_tool_command_can_block_with_structured_decision() {
        let root =
            std::env::temp_dir().join(format!("melody-pi-hook-run-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".melody/hooks")).unwrap();
        fs::write(
            root.join(".melody/hooks/deny.json"),
            serde_json::json!({
                "hooks": {"PreToolUse": [{"hooks": [{"type": "command", "command": "printf '%s' '{\"decision\":\"deny\",\"reason\":\"nope\"}'"}]}]}
            })
            .to_string(),
        )
        .unwrap();
        unsafe {
            std::env::set_var("MELODY_HOME", root.join("user-home"));
        }
        let request = serde_json::json!({
            "sessionId": "session",
            "event": {"toolCallId": "call", "toolName": "workspace_write_file", "activity": {"arguments": {"path": "a.txt"}}}
        });
        let result = run_tool_hooks(&root, HookEvent::PreToolUse, &request, None);
        assert!(result.blocked);
        assert_eq!(result.reason.as_deref(), Some("nope"));
        unsafe {
            std::env::remove_var("MELODY_HOME");
        }
        fs::remove_dir_all(root).unwrap();
    }
}
