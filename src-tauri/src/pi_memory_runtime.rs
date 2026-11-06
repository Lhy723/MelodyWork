//! Host-owned Pi memory configuration and session lifecycle.
//!
//! This module keeps Host policy for whether memory tools and lifecycle
//! snapshots are enabled, prepares bounded first-turn context, and persists
//! deterministic session transcripts. The sibling `store` module owns the
//! authoritative Markdown files and disposable SQLite lexical index. Pi's
//! compaction extension owns the bounded pre-compaction Memory Flush note;
//! embedding ranking and dream/LLM consolidation remain an explicit ACP
//! compatibility fallback.

use std::{
    env, fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::{
    config_core::read_melody_config_inner,
    config_io::TextFileStore,
    pi_tool_gateway::{self, MEMORY_GET, MEMORY_REMEMBER, MEMORY_SEARCH},
};

#[path = "pi_memory_runtime/store.rs"]
mod store;
pub(crate) use self::store::MemoryIndexSummary;
use self::store::{
    bound_text, ensure_memory_write_path, lock_memory_writes, memory_paths, refresh_index,
};

const MAX_SESSION_MESSAGES: usize = 128;
const MAX_SESSION_MESSAGE_BYTES: usize = 16 * 1024;
const MAX_SESSION_TRANSCRIPT_BYTES: usize = 512 * 1024;
const MIN_SESSION_USER_MESSAGES: usize = 3;
const MIN_SESSION_QUERY_BYTES: usize = 50;

pub(crate) async fn resolve_request(root: &Path, value: &Value) -> Result<String, String> {
    let (tool_name, arguments) = pi_tool_gateway::tool_request_arguments(value)?;
    match tool_name {
        MEMORY_SEARCH | MEMORY_GET | MEMORY_REMEMBER => {
            let config = merged_config(root)?;
            if !memory_enabled(&config) {
                return Ok(
                    "Memory is not enabled. Enable memory in Melody settings first.".to_string(),
                );
            }
            match tool_name {
                MEMORY_SEARCH => store::memory_search(root, arguments, &config),
                MEMORY_GET => store::memory_get(root, arguments),
                MEMORY_REMEMBER => store::memory_remember(root, arguments),
                _ => unreachable!("matched a memory tool above"),
            }
        }
        _ => Err(format!("Unsupported memory tool: {tool_name}")),
    }
}

pub(crate) fn rebuild_memory_index(root: &Path) -> Result<MemoryIndexSummary, String> {
    let config = merged_config(root)?;
    if !memory_enabled(&config) {
        return Err("Memory is not enabled. Enable memory in Melody settings first.".to_string());
    }
    store::rebuild_memory_index(root)
}

fn merged_config(root: &Path) -> Result<Map<String, Value>, String> {
    let cwd = root.to_string_lossy().into_owned();
    let mut merged = Map::new();
    for scope in ["user", "project"] {
        let document = read_melody_config_inner(scope.to_string(), cwd.clone())?;
        if let Some(error) = document.parse_error {
            return Err(format!("无法解析 {scope} Melody 配置：{error}"));
        }
        if let Some(values) = document.values.as_object() {
            merge_json(&mut merged, values);
        }
    }
    Ok(merged)
}

fn merge_json(target: &mut Map<String, Value>, source: &Map<String, Value>) {
    for (key, value) in source {
        if let (Some(Value::Object(existing)), Value::Object(incoming)) =
            (target.get_mut(key), value)
        {
            merge_json(existing, incoming);
        } else {
            target.insert(key.clone(), value.clone());
        }
    }
}

fn memory_enabled(config: &Map<String, Value>) -> bool {
    let memory = config.get("memory");
    if let Some(value) = memory.and_then(Value::as_bool) {
        return value;
    }
    if let Some(explicit) = memory
        .and_then(Value::as_object)
        .and_then(|memory| memory.get("enabled"))
        .and_then(Value::as_bool)
    {
        return explicit;
    }
    if let Ok(value) = env::var("MELODY_MEMORY") {
        match value.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => return true,
            "0" | "false" | "no" | "off" => return false,
            _ => {}
        }
    }
    memory
        .and_then(Value::as_object)
        .is_some_and(|value| !value.is_empty())
}

/// Whether the Host should persist a bounded session snapshot when Pi closes
/// a product session. Melody-build defaults this lifecycle switch to `true`
/// whenever memory itself is enabled; an explicit `false` remains authoritative.
pub(crate) fn save_on_session_end(root: &Path) -> Result<bool, String> {
    let config = merged_config(root)?;
    if !memory_enabled(&config) {
        return Ok(false);
    }
    Ok(config
        .get("memory")
        .and_then(Value::as_object)
        .and_then(|memory| memory.get("session"))
        .and_then(Value::as_object)
        .and_then(|session| session.get("save_on_end"))
        .and_then(Value::as_bool)
        .unwrap_or(true))
}

/// Build a first-turn memory reminder using the same broad greeting fallback
/// as Melody-build. The caller prepends the returned block to the submitted
/// prompt because Pi's public SDK does not expose a per-turn system-reminder
/// mutation API. The worker strips this marker from the product transcript.
pub(crate) fn initial_injection(root: &Path, raw_query: &str) -> Result<Option<String>, String> {
    let config = merged_config(root)?;
    if !memory_enabled(&config) {
        return Ok(None);
    }
    let initial = config
        .get("memory")
        .and_then(Value::as_object)
        .and_then(|memory| memory.get("initial_injection"))
        .and_then(Value::as_object);
    if !initial
        .and_then(|value| value.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
    {
        return Ok(None);
    }
    let raw_query = raw_query.trim();
    if raw_query.len() > store::MAX_QUERY_BYTES {
        return Err("initial memory query exceeds the 2 KB limit".to_string());
    }
    let query = if raw_query.is_empty() || raw_query.len() < 20 || is_greeting(raw_query) {
        "project conventions preferences architecture"
    } else {
        raw_query
    };
    let min_score = initial
        .and_then(|value| value.get("min_score"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    if !min_score.is_finite() || !(0.0..=1.0).contains(&min_score) {
        return Err("memory.initial_injection.min_score must be between 0 and 1".to_string());
    }
    let Some(output) = store::initial_memory_search(root, &config, query, min_score)? else {
        return Ok(None);
    };
    Ok(Some(format!(
        "<melody-memory-context>\n{output}\n</melody-memory-context>"
    )))
}

fn is_greeting(value: &str) -> bool {
    let normalized = value
        .trim()
        .to_ascii_lowercase()
        .trim_end_matches(['.', '!', '?', ','])
        .to_string();
    matches!(
        normalized.as_str(),
        "hi" | "hey"
            | "hello"
            | "howdy"
            | "continue"
            | "start"
            | "begin"
            | "go"
            | "good morning"
            | "good afternoon"
            | "good evening"
            | "what's up"
            | "whats up"
            | "sup"
    )
}

/// A product-level message captured by the Host before a Pi session is
/// closed. Keeping the message id lets replayed completion events replace the
/// previous copy without duplicating content in the eventual memory file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SessionMemoryMessage {
    pub(crate) id: String,
    pub(crate) role: String,
    pub(crate) content: String,
}

/// Persist a deterministic, bounded transcript snapshot for a closed session.
///
/// This intentionally does not call an LLM: the original Melody-build hook
/// already had a no-latency metadata path, and deterministic writes make
/// shutdown/replay safe. Rich semantic consolidation is not implemented in
/// this Pi memory path; configured use is reported as unavailable.
pub(crate) fn save_session_transcript(
    root: &Path,
    session_id: &str,
    messages: &[SessionMemoryMessage],
) -> Result<Option<PathBuf>, String> {
    if messages.is_empty() || !save_on_session_end(root)? {
        return Ok(None);
    }
    let user_messages = messages
        .iter()
        .filter(|message| message.role == "user")
        .collect::<Vec<_>>();
    let user_bytes = user_messages
        .iter()
        .map(|message| message.content.len())
        .sum::<usize>();
    if user_messages.len() < MIN_SESSION_USER_MESSAGES || user_bytes < MIN_SESSION_QUERY_BYTES {
        return Ok(None);
    }
    let paths = memory_paths(root)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default();
    let digest = format!("{:x}", Sha256::digest(session_id.as_bytes()));
    let filename = format!("session-{timestamp}-{}.md", &digest[..12]);
    let path = paths.workspace.join("sessions").join(filename);
    let content = format_session_transcript(messages);
    let lock = lock_memory_writes()?;
    // Session snapshots use a generated filename, but still pass through the
    // same symlink/non-directory preflight as model-facing memory_remember.
    // The check is repeated after creating the parent to close the ordinary
    // TOCTOU window while keeping TextFileStore's atomic replacement.
    ensure_memory_write_path(&paths.root, &path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create memory directory: {error}"))?;
    }
    ensure_memory_write_path(&paths.root, &path)?;
    TextFileStore::with_limit_description(
        &path,
        MAX_SESSION_TRANSCRIPT_BYTES as u64,
        "the 512 KB memory transcript limit",
    )
    .write_text(&content, "Pi memory session transcript")?;
    drop(lock);
    // Keep the persistent sidecar warm after a session snapshot is written.
    // The Markdown transcript remains authoritative; a locked/broken SQLite
    // file must not make session shutdown fail.
    refresh_index(&paths);
    Ok(Some(path))
}

fn format_session_transcript(messages: &[SessionMemoryMessage]) -> String {
    let mut output = String::from("# Session Transcript\n\n");
    for message in messages.iter().take(MAX_SESSION_MESSAGES) {
        let role = match message.role.as_str() {
            "user" => "User",
            "assistant" => "Assistant",
            _ => continue,
        };
        let content = bound_text(message.content.clone(), MAX_SESSION_MESSAGE_BYTES);
        let section = format!("## {role}\n\n{content}\n\n");
        if output.len().saturating_add(section.len()) > MAX_SESSION_TRANSCRIPT_BYTES {
            output.push_str("[transcript truncated]\n");
            break;
        }
        output.push_str(&section);
    }
    output
}

/// Remove the internal first-turn marker before a transcript is persisted or
/// exposed as a product message. The marker is intentionally simple and
/// exact so a user's own similarly named text is not broadly rewritten.
pub(crate) fn strip_injected_context(value: &str) -> String {
    let marker = "</melody-memory-context>";
    let Some(start) = value.strip_prefix("<melody-memory-context>\n") else {
        return value.to_string();
    };
    let Some(end) = start.find(marker) else {
        return value.to_string();
    };
    let remainder = &start[end + marker.len()..];
    remainder
        .strip_prefix("\n\n")
        .unwrap_or(remainder)
        .to_string()
}
