//! Host command-hook execution and event payload projection.
//!
//! Commands run only after Host routing selects an authorized workspace; their
//! environment, input, output, and execution time remain explicitly bounded.

use std::{
    env,
    io::{Read, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde_json::{Map, Value};

use super::hook_config::{self, HookSpec};

const MAX_HOOK_INPUT_BYTES: usize = 256 * 1024;
const MAX_HOOK_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_HOOK_REASON_BYTES: usize = 4 * 1024;

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
    let (specs, parse_warnings) = match hook_config::read_hook_specs(&cwd) {
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
