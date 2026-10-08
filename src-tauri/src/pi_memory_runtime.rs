//! Host-owned memory search/retrieval for the Pi worker.
//!
//! Melody's memory files remain outside the Pi worker. This bridge reads the
//! same ~/.melody/memory layout as Melody-build, applies a workspace identity
//! boundary, and exposes bounded memory_search, memory_get, and
//! memory_remember requests. The
//! Markdown remains authoritative while a versioned SQLite sidecar is kept in
//! sync and read only after digest, scope, and file-metadata validation. The
//! conservative BM25-style scorer still owns ranking semantics, so a damaged
//! or stale sidecar falls back to freshly loaded Markdown without changing
//! results. Session-end snapshots and first-turn context injection are also
//! kept here so the Pi path does not silently lose the common memory
//! lifecycle. Pi's compaction extension owns the bounded pre-compaction
//! Memory Flush note; embedding ranking and dream/LLM consolidation remain an
//! explicit ACP compatibility fallback.

use std::{
    collections::{HashMap, HashSet},
    env,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::{
    agent_runtime::melody_home,
    config_io::TextFileStore,
    config_runtime::read_melody_config_inner,
    pi_tool_gateway::{self, MEMORY_GET, MEMORY_REMEMBER, MEMORY_SEARCH},
};

const MEMORY_DIR: &str = "memory";
const MAX_QUERY_BYTES: usize = 2_048;
const MAX_RESULTS: usize = 100;
const DEFAULT_RESULTS: usize = 6;
const DEFAULT_MIN_SCORE: f64 = 0.35;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_FILES: usize = 512;
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CHUNK_CHARS: usize = 1_600;
const MAX_SNIPPET_BYTES: usize = 2_000;
const MAX_OUTPUT_BYTES: usize = 512 * 1024;
const MAX_MEMORY_NOTE_BYTES: usize = 16 * 1024;
const MAX_READ_LINES: usize = 10_000;
const DEFAULT_HALF_LIFE_DAYS: f64 = 7.0;
const MAX_SESSION_MESSAGES: usize = 128;
const MAX_SESSION_MESSAGE_BYTES: usize = 16 * 1024;
const MAX_SESSION_TRANSCRIPT_BYTES: usize = 512 * 1024;
const MIN_SESSION_USER_MESSAGES: usize = 3;
const MEMORY_INDEX_SCHEMA_VERSION: &str = "1";
const MEMORY_INDEX_MAX_CHUNKS: usize = MAX_FILES * 64;
const MIN_SESSION_QUERY_BYTES: usize = 50;

/// Serialize append operations across Pi sessions. A read/modify/atomic
/// replace sequence without a shared lock could otherwise lose one of two
/// simultaneous durable notes.
static MEMORY_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Debug)]
struct MemoryPaths {
    root: PathBuf,
    global: PathBuf,
    workspace: PathBuf,
}

#[derive(Clone, Debug)]
struct MemoryFile {
    path: PathBuf,
    source: &'static str,
    modified_at: i64,
}

#[derive(Clone, Debug)]
struct MemoryChunk {
    path: PathBuf,
    source: &'static str,
    start_line: usize,
    end_line: usize,
    text: String,
    modified_at: i64,
}

#[derive(Clone, Debug)]
struct SearchConfig {
    max_results: usize,
    min_score: f64,
    temporal_decay: bool,
    half_life_days: f64,
    source_weights: HashMap<String, f64>,
}

/// Result of synchronizing the Host-owned persistent memory index.
///
/// The index is deliberately a sidecar to the human-readable Markdown files.
/// Its digest lets searches skip a write when no memory file changed, while a
/// damaged or stale sidecar can always be rebuilt from those files.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryIndexSummary {
    pub(crate) path: String,
    pub(crate) chunk_count: usize,
    pub(crate) changed: bool,
    pub(crate) indexed_at: i64,
}

pub(crate) async fn resolve_request(root: &Path, value: &Value) -> Result<String, String> {
    let (tool_name, arguments) = pi_tool_gateway::tool_request_arguments(value)?;
    match tool_name {
        MEMORY_SEARCH => memory_search(root, arguments),
        MEMORY_GET => memory_get(root, arguments),
        MEMORY_REMEMBER => memory_remember(root, arguments),
        _ => Err(format!("Unsupported memory tool: {tool_name}")),
    }
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
    if raw_query.len() > MAX_QUERY_BYTES {
        return Err("initial memory query exceeds the 2 KB limit".to_string());
    }
    let query = if raw_query.is_empty() || raw_query.len() < 20 || is_greeting(raw_query) {
        "project conventions preferences architecture"
    } else {
        raw_query
    };
    let search = search_config(&config)?;
    let min_score = initial
        .and_then(|value| value.get("min_score"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    if !min_score.is_finite() || !(0.0..=1.0).contains(&min_score) {
        return Err("memory.initial_injection.min_score must be between 0 and 1".to_string());
    }
    let paths = memory_paths(root)?;
    let markdown_chunks = load_chunks(&paths)?;
    let chunks = search_chunks(&paths, &markdown_chunks);
    let results = rank_chunks(&chunks, query, &search, search.max_results, min_score);
    if results.is_empty() {
        return Ok(None);
    }
    let output = format_search_output(&results)?;
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
/// shutdown/replay safe. Rich semantic consolidation remains an ACP fallback.
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
    let lock = MEMORY_WRITE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Memory write lock is poisoned".to_string())?;
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
    if let Ok(chunks) = load_chunks(&paths) {
        let _ = sync_memory_index_path(&paths.workspace.join("index.sqlite"), &chunks);
    }
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

fn memory_search(root: &Path, arguments: &Map<String, Value>) -> Result<String, String> {
    let config = merged_config(root)?;
    if !memory_enabled(&config) {
        return Ok("Memory is not enabled. Enable memory in Melody settings first.".to_string());
    }
    let query = arguments
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "query must be a non-empty string".to_string())?;
    if query.len() > MAX_QUERY_BYTES {
        return Err("query exceeds the 2 KB memory search limit".to_string());
    }
    let settings = search_config(&config)?;
    let max_results = arguments
        .get("max_results")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(settings.max_results)
        .clamp(1, MAX_RESULTS);
    let min_score = arguments
        .get("min_score")
        .and_then(Value::as_f64)
        .unwrap_or(settings.min_score);
    if !min_score.is_finite() || !(0.0..=1.0).contains(&min_score) {
        return Err("min_score must be a number between 0 and 1".to_string());
    }
    let paths = memory_paths(root)?;
    let markdown_chunks = load_chunks(&paths)?;
    // The sidecar is only a validated projection.  If it is unavailable,
    // stale, or tampered with, search_chunks returns the freshly loaded
    // Markdown chunks and preserves the previous behavior.
    let chunks = search_chunks(&paths, &markdown_chunks);
    let results = rank_chunks(&chunks, query, &settings, max_results, min_score);
    format_search_output(&results)
}

fn memory_get(root: &Path, arguments: &Map<String, Value>) -> Result<String, String> {
    let config = merged_config(root)?;
    if !memory_enabled(&config) {
        return Ok("Memory is not enabled. Enable memory in Melody settings first.".to_string());
    }
    let requested = arguments
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "path must be a non-empty string".to_string())?;
    let paths = memory_paths(root)?;
    let candidate = if Path::new(requested).is_absolute() {
        PathBuf::from(requested)
    } else {
        paths.root.join(requested)
    };
    let canonical_root = fs::canonicalize(&paths.root)
        .map_err(|error| format!("Memory directory is unavailable: {error}"))?;
    let canonical = safe_memory_file(&candidate, &canonical_root)?;
    let content = read_bounded_utf8(&canonical)?;
    let from = arguments
        .get("from")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(0);
    if from > MAX_READ_LINES * 100 {
        return Err("from is outside the supported memory line range".to_string());
    }
    let lines = arguments
        .get("lines")
        .and_then(Value::as_u64)
        .map(|value| value as usize);
    if lines.is_some_and(|value| value == 0 || value > MAX_READ_LINES) {
        return Err("lines must be between 1 and 10000".to_string());
    }
    let selected = content
        .split('\n')
        .skip(from)
        .take(lines.unwrap_or(MAX_READ_LINES))
        .enumerate()
        .map(|(index, line)| format!("{}→{}", from + index + 1, line))
        .collect::<Vec<_>>()
        .join("\n");
    let total_lines = content.split('\n').count();
    let output = format!(
        "**File:** {}\n**Lines:** {} (from: {}, limit: {})\n\n{}",
        canonical.display(),
        total_lines,
        if from == 0 {
            "start".to_string()
        } else {
            from.to_string()
        },
        lines.map_or_else(|| "all".to_string(), |value| value.to_string()),
        selected
    );
    Ok(bound_text(output, MAX_OUTPUT_BYTES))
}

/// Append one user/model-approved note to the selected Melody memory scope.
///
/// The worker never receives the resulting path and cannot choose an
/// arbitrary file. Scope is reduced to the two long-term stores that
/// Melody-build exposes, and the Host validates every existing path component
/// before creating or replacing the Markdown file.
fn memory_remember(root: &Path, arguments: &Map<String, Value>) -> Result<String, String> {
    let config = merged_config(root)?;
    if !memory_enabled(&config) {
        return Ok("Memory is not enabled. Enable memory in Melody settings first.".to_string());
    }
    let scope = arguments
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("workspace")
        .trim()
        .to_ascii_lowercase();
    if !matches!(scope.as_str(), "workspace" | "global") {
        return Err("scope must be either workspace or global".to_string());
    }
    let raw = arguments
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| "content must be a non-empty string".to_string())?;
    let normalized = normalize_memory_content_checked(raw)?;
    let paths = memory_paths(root)?;
    let target = if scope == "global" {
        paths.global.clone()
    } else {
        paths.workspace.join("MEMORY.md")
    };

    let lock = MEMORY_WRITE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Memory write lock is poisoned".to_string())?;
    // Check before and after directory creation. This closes the ordinary
    // symlink traversal cases while retaining TextFileStore's atomic replace.
    ensure_memory_write_path(&paths.root, &target)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create memory directory: {error}"))?;
    }
    ensure_memory_write_path(&paths.root, &target)?;
    let existing = match fs::symlink_metadata(&target) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err("Refusing to write memory through a symbolic link".to_string());
            }
            if !metadata.is_file() {
                return Err("memory target must be a regular Markdown file".to_string());
            }
            Some(read_bounded_utf8(&target)?)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(format!("Cannot inspect memory target: {error}"));
        }
    };
    let content = append_memory_content(existing.as_deref(), &normalized)?;
    TextFileStore::with_limit_description(&target, MAX_FILE_BYTES, "the 2 MB memory file limit")
        .write_text(&content, "Pi durable memory")?;
    drop(lock);
    // Make a newly remembered note searchable by subsequent Pi turns without
    // requiring an explicit rebuild. Index errors are intentionally best
    // effort because Markdown is the source of truth for memory.
    if let Ok(chunks) = load_chunks(&paths) {
        let _ = sync_memory_index_path(&paths.workspace.join("index.sqlite"), &chunks);
    }

    Ok(format!(
        "Saved a durable memory note to the {scope} scope ({} bytes).",
        normalized.len()
    ))
}

/// Match Melody-build's Markdown normalization while rejecting control bytes
/// and oversized UTF-8 payloads at the Host boundary.
pub(crate) fn normalize_memory_content_checked(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("content must not be empty".to_string());
    }
    if trimmed.len() > MAX_MEMORY_NOTE_BYTES {
        return Err("content exceeds the 16 KB memory note limit".to_string());
    }
    if trimmed.chars().any(|character| {
        character == '\0' || (character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    }) {
        return Err("content contains unsupported control characters".to_string());
    }
    let normalized = normalize_memory_content(trimmed);
    if normalized.len() > MAX_MEMORY_NOTE_BYTES {
        return Err("normalized content exceeds the 16 KB memory note limit".to_string());
    }
    Ok(normalized)
}

/// Pure Markdown normalization used by the durable writer and its tests.
pub(crate) fn normalize_memory_content(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.starts_with('#') {
        return trimmed.to_string();
    }
    match trimmed.find('\n') {
        None => format!("## {trimmed}"),
        Some(position) => {
            let first_line = trimmed[..position].trim();
            let rest = trimmed[position..].trim();
            if first_line.len() <= 80 {
                format!("## {first_line}\n\n{rest}")
            } else {
                format!("## Note\n\n{trimmed}")
            }
        }
    }
}

/// Append with the exact blank-line separator used by Melody-build. Keeping
/// this pure makes the no-truncation and ordering guarantees straightforward
/// to test before touching the user's memory directory.
pub(crate) fn append_memory_content(
    existing: Option<&str>,
    normalized: &str,
) -> Result<String, String> {
    if normalized.trim().is_empty() {
        return Err("content must not be empty".to_string());
    }
    let content = match existing.filter(|value| !value.is_empty()) {
        Some(existing) => format!("{existing}\n\n{normalized}"),
        None => normalized.to_string(),
    };
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err("memory file would exceed the 2 MB limit".to_string());
    }
    Ok(content)
}

/// Reject symlinks (and non-directory intermediate components) on every
/// existing component of a fixed memory path. Missing components are allowed
/// because the caller creates them immediately after this preflight.
fn ensure_memory_write_path(root: &Path, target: &Path) -> Result<(), String> {
    if target.extension().and_then(|value| value.to_str()) != Some("md") {
        return Err("memory target must be a Markdown file".to_string());
    }
    if let Ok(metadata) = fs::symlink_metadata(root)
        && (metadata.file_type().is_symlink() || !metadata.is_dir())
    {
        return Err("Refusing to write memory through a symbolic link".to_string());
    }
    let lexical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let relative = target
        .strip_prefix(&lexical_root)
        .map_err(|_| "memory target is outside Melody memory".to_string())?;
    if relative
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("memory target cannot contain parent traversal".to_string());
    }
    let mut current = lexical_root;
    if let Ok(metadata) = fs::symlink_metadata(&current) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("Refusing to write memory through a symbolic link".to_string());
        }
    }
    for component in relative.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("Refusing to write memory through a symbolic link".to_string());
            }
            Ok(metadata) if current != target && !metadata.is_dir() => {
                return Err("memory path contains a non-directory component".to_string());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(format!("Cannot inspect memory path: {error}")),
        }
    }
    Ok(())
}

fn search_config(config: &Map<String, Value>) -> Result<SearchConfig, String> {
    let memory = config.get("memory").and_then(Value::as_object);
    let search = memory
        .and_then(|value| value.get("search"))
        .and_then(Value::as_object);
    let max_results = search
        .and_then(|value| value.get("max_results"))
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(DEFAULT_RESULTS)
        .clamp(1, MAX_RESULTS);
    let min_score = search
        .and_then(|value| value.get("min_score"))
        .and_then(Value::as_f64)
        .unwrap_or(DEFAULT_MIN_SCORE);
    if !min_score.is_finite() || !(0.0..=1.0).contains(&min_score) {
        return Err("memory.search.min_score must be between 0 and 1".to_string());
    }
    let decay = search
        .and_then(|value| value.get("temporal_decay"))
        .and_then(Value::as_object);
    let temporal_decay = decay
        .and_then(|value| value.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let half_life_days = decay
        .and_then(|value| value.get("half_life_days"))
        .and_then(Value::as_f64)
        .unwrap_or(DEFAULT_HALF_LIFE_DAYS);
    if !half_life_days.is_finite() || half_life_days <= 0.0 {
        return Err("memory.search.temporal_decay.half_life_days must be positive".to_string());
    }
    let mut source_weights = HashMap::new();
    if let Some(weights) = search
        .and_then(|value| value.get("source_weights"))
        .and_then(Value::as_object)
    {
        if weights.len() > 8 {
            return Err("memory source_weights contains too many entries".to_string());
        }
        for (source, value) in weights {
            let Some(weight) = value.as_f64() else {
                return Err(format!("memory source weight {source} must be a number"));
            };
            if !weight.is_finite() || !(0.0..=4.0).contains(&weight) {
                return Err(format!("memory source weight {source} is outside 0..4"));
            }
            source_weights.insert(source.clone(), weight);
        }
    }
    Ok(SearchConfig {
        max_results,
        min_score,
        temporal_decay,
        half_life_days,
        source_weights,
    })
}

fn memory_paths(cwd: &Path) -> Result<MemoryPaths, String> {
    let home = melody_home().ok_or_else(|| "Melody home is unavailable".to_string())?;
    let root = home.join(MEMORY_DIR);
    let identity = workspace_identity(cwd);
    let slug_source = identity
        .split('/')
        .next_back()
        .filter(|value| !value.is_empty())
        .unwrap_or("workspace");
    let slug = slugify(slug_source, 40);
    let slug = if slug.is_empty() { "workspace" } else { &slug };
    let hash = format!("{:x}", Sha256::digest(identity.as_bytes()));
    let workspace = root.join(format!("{slug}-{}", &hash[..8]));
    Ok(MemoryPaths {
        global: root.join("MEMORY.md"),
        root,
        workspace,
    })
}

fn workspace_identity(cwd: &Path) -> String {
    let cwd_string = cwd.to_string_lossy().into_owned();
    let origin = Command::new("git")
        .args([
            "-C",
            cwd_string.as_str(),
            "config",
            "--get",
            "remote.origin.url",
        ])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|value| normalize_remote_url(value.trim()));
    origin.unwrap_or_else(|| {
        fs::canonicalize(cwd)
            .unwrap_or_else(|_| cwd.to_path_buf())
            .to_string_lossy()
            .into_owned()
    })
}

fn normalize_remote_url(value: &str) -> Option<String> {
    let value = value.trim();
    let path = if let Some(position) = value.find(':') {
        let prefix = &value[..position];
        if prefix.contains('@') && !prefix.contains('/') {
            &value[position + 1..]
        } else {
            value.split_once("//")?.1.split_once('/')?.1
        }
    } else {
        value.split_once("//")?.1.split_once('/')?.1
    };
    let path = path
        .trim_start_matches('/')
        .trim_end_matches('/')
        .trim_end_matches(".git");
    (path.contains('/') && !path.is_empty()).then(|| path.to_string())
}

fn slugify(value: &str, max_len: usize) -> String {
    let mut output = String::new();
    let mut previous_dash = false;
    for character in value.chars() {
        let normalized = if character.is_ascii_alphanumeric() {
            character.to_ascii_lowercase()
        } else {
            '-'
        };
        if normalized == '-' {
            if previous_dash {
                continue;
            }
            previous_dash = true;
        } else {
            previous_dash = false;
        }
        output.push(normalized);
        if output.len() >= max_len {
            break;
        }
    }
    output.trim_matches('-').to_string()
}

pub(crate) fn rebuild_memory_index(root: &Path) -> Result<MemoryIndexSummary, String> {
    let config = merged_config(root)?;
    if !memory_enabled(&config) {
        return Err("Memory is not enabled. Enable memory in Melody settings first.".to_string());
    }
    let paths = memory_paths(root)?;
    let index_path = paths.workspace.join("index.sqlite");
    ensure_memory_index_path(&paths.root, &index_path)?;
    let chunks = load_chunks(&paths)?;
    sync_memory_index_path(&index_path, &chunks)
}

fn ensure_memory_index_path(root: &Path, target: &Path) -> Result<(), String> {
    if target.extension().and_then(|value| value.to_str()) != Some("sqlite") {
        return Err("memory index target must be an SQLite file".to_string());
    }
    if let Ok(metadata) = fs::symlink_metadata(root)
        && (metadata.file_type().is_symlink() || !metadata.is_dir())
    {
        return Err("Refusing to create memory index through a symbolic link".to_string());
    }

    let lexical_root = canonicalize_existing_prefix(root);
    let normalized_target = canonicalize_existing_prefix(target);
    let relative = normalized_target
        .strip_prefix(&lexical_root)
        .map_err(|_| "memory index target is outside Melody memory".to_string())?;
    if relative
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("memory index target cannot contain parent traversal".to_string());
    }

    let mut current = lexical_root;
    if let Ok(metadata) = fs::symlink_metadata(&current)
        && (metadata.file_type().is_symlink() || !metadata.is_dir())
    {
        return Err("Refusing to create memory index through a symbolic link".to_string());
    }
    for component in relative.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("Refusing to create memory index through a symbolic link".to_string());
            }
            Ok(metadata) if current != normalized_target && !metadata.is_dir() => {
                return Err("memory index path contains a non-directory component".to_string());
            }
            Ok(metadata) if current == normalized_target && !metadata.is_file() => {
                return Err("memory index target must be a regular file".to_string());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(format!("Cannot inspect memory index path: {error}")),
        }
    }
    Ok(())
}

/// Canonicalize a path while retaining components that do not exist yet.
///
/// macOS commonly exposes `/var` through a symlink to `/private/var`. The
/// memory root is canonicalized for the boundary check, so the target must
/// use the same existing-prefix normalization or a valid path can appear to
/// be outside its own root.
fn canonicalize_existing_prefix(path: &Path) -> PathBuf {
    let mut missing = Vec::new();
    let mut current = path.to_path_buf();
    while !current.exists() {
        if let Some(name) = current.file_name() {
            missing.push(name.to_os_string());
        } else {
            break;
        }
        if !current.pop() {
            break;
        }
    }
    let mut normalized = fs::canonicalize(&current).unwrap_or(current);
    for component in missing.iter().rev() {
        normalized.push(component);
    }
    normalized
}

fn sync_memory_index_path(
    index_path: &Path,
    chunks: &[MemoryChunk],
) -> Result<MemoryIndexSummary, String> {
    if chunks.len() > MEMORY_INDEX_MAX_CHUNKS {
        return Err(format!(
            "memory index contains too many chunks (maximum {})",
            MEMORY_INDEX_MAX_CHUNKS
        ));
    }
    // Preflight before creating anything so a malicious replacement of the
    // workspace directory cannot make create_dir_all follow a symlink.
    if let Some(root) = index_path.parent().and_then(Path::parent) {
        ensure_memory_index_path(root, index_path)?;
    }
    if let Some(parent) = index_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create memory index directory: {error}"))?;
    }
    if let Some(root) = index_path.parent().and_then(Path::parent) {
        ensure_memory_index_path(root, index_path)?;
    }
    if let Ok(metadata) = fs::symlink_metadata(index_path) {
        if metadata.file_type().is_symlink() {
            return Err("Refusing to open memory index through a symbolic link".to_string());
        }
        if !metadata.is_file() {
            return Err("memory index target must be a regular file".to_string());
        }
    }

    let connection = Connection::open(index_path)
        .map_err(|error| format!("Failed to open memory index: {error}"))?;
    connection
        .busy_timeout(std::time::Duration::from_millis(250))
        .map_err(|error| format!("Failed to configure memory index: {error}"))?;
    let has_meta_table: bool = connection
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM sqlite_master
                 WHERE type = 'table' AND name = 'pi_memory_meta'
             )",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to inspect memory index schema: {error}"))?;
    let schema_version = if has_meta_table {
        connection
            .query_row(
                "SELECT value FROM pi_memory_meta WHERE key = 'schema_version'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("Failed to read memory index schema: {error}"))?
    } else {
        None
    };
    if schema_version.as_deref() != Some(MEMORY_INDEX_SCHEMA_VERSION) {
        // A sidecar is disposable derived state. Drop an unknown schema
        // instead of trying to write into a table whose columns may no longer
        // match; Markdown remains the authoritative recovery source.
        connection
            .execute_batch(
                "DROP TABLE IF EXISTS pi_memory_chunks;
                 DROP TABLE IF EXISTS pi_memory_meta;",
            )
            .map_err(|error| format!("Failed to reset memory index schema: {error}"))?;
    }
    initialize_memory_index_schema(&connection)?;

    let digest = memory_index_digest(chunks);
    let existing_digest: Option<String> = connection
        .query_row(
            "SELECT value FROM pi_memory_meta WHERE key = 'source_digest'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Failed to read memory index metadata: {error}"))?;
    let indexed_count: usize = connection
        .query_row("SELECT COUNT(*) FROM pi_memory_chunks", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|error| format!("Failed to read memory index count: {error}"))?
        .max(0) as usize;
    if existing_digest.as_deref() == Some(digest.as_str()) && indexed_count == chunks.len() {
        return Ok(MemoryIndexSummary {
            path: index_path.to_string_lossy().into_owned(),
            chunk_count: indexed_count,
            changed: false,
            indexed_at: memory_index_timestamp(&connection)?,
        });
    }

    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format!("Failed to begin memory index transaction: {error}"))?;
    transaction
        .execute("DELETE FROM pi_memory_chunks", [])
        .map_err(|error| format!("Failed to clear stale memory index rows: {error}"))?;
    for (index, chunk) in chunks.iter().enumerate() {
        let id = format!(
            "{}:{}:{}:{}",
            chunk.path.to_string_lossy(),
            chunk.start_line,
            chunk.end_line,
            index
        );
        let content_hash = format!("{:x}", Sha256::digest(chunk.text.as_bytes()));
        transaction
            .execute(
                "INSERT INTO pi_memory_chunks
                    (id, path, source, start_line, end_line, text, modified_at, content_hash)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    id,
                    chunk.path.to_string_lossy().into_owned(),
                    chunk.source,
                    chunk.start_line as i64,
                    chunk.end_line as i64,
                    chunk.text,
                    chunk.modified_at,
                    content_hash,
                ],
            )
            .map_err(|error| format!("Failed to write memory index row: {error}"))?;
    }
    let indexed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or_default();
    transaction
        .execute(
            "INSERT INTO pi_memory_meta(key, value) VALUES ('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![MEMORY_INDEX_SCHEMA_VERSION],
        )
        .map_err(|error| format!("Failed to write memory index schema: {error}"))?;
    transaction
        .execute(
            "INSERT INTO pi_memory_meta(key, value) VALUES ('source_digest', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![digest],
        )
        .map_err(|error| format!("Failed to write memory index digest: {error}"))?;
    transaction
        .execute(
            "INSERT INTO pi_memory_meta(key, value) VALUES ('indexed_at', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![indexed_at.to_string()],
        )
        .map_err(|error| format!("Failed to write memory index timestamp: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit memory index: {error}"))?;

    Ok(MemoryIndexSummary {
        path: index_path.to_string_lossy().into_owned(),
        chunk_count: chunks.len(),
        changed: true,
        indexed_at,
    })
}

/// Read the persistent index only after proving that it is a current,
/// Host-generated projection of the Markdown memory files.
///
/// SQLite is a disposable cache and may be edited, truncated, or replaced by
/// another process.  A caller must provide the freshly loaded Markdown chunks;
/// their digest and count are compared with both the stored metadata and the
/// rows read from SQLite.  Every row is then checked for a valid source scope,
/// an existing non-symlink Markdown file, and the file's modification
/// timestamp before it can reach the scorer.  Any mismatch is a hard error so
/// the caller can fall back to the authoritative in-memory chunks without
/// exposing an untrusted path or stale text.
fn load_indexed_chunks(
    paths: &MemoryPaths,
    index_path: &Path,
    expected_chunks: &[MemoryChunk],
) -> Result<Vec<MemoryChunk>, String> {
    let expected_digest = memory_index_digest(expected_chunks);
    let expected_count = expected_chunks.len();
    if expected_count > MEMORY_INDEX_MAX_CHUNKS {
        return Err("memory index contains too many chunks".to_string());
    }
    ensure_memory_index_path(&paths.root, index_path)?;
    let connection = Connection::open_with_flags(index_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Failed to open memory index for reading: {error}"))?;
    connection
        .busy_timeout(std::time::Duration::from_millis(100))
        .map_err(|error| format!("Failed to configure memory index reader: {error}"))?;

    let schema: Option<String> = connection
        .query_row(
            "SELECT value FROM pi_memory_meta WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Failed to read memory index schema: {error}"))?;
    if schema.as_deref() != Some(MEMORY_INDEX_SCHEMA_VERSION) {
        return Err("memory index schema is stale".to_string());
    }
    let digest: Option<String> = connection
        .query_row(
            "SELECT value FROM pi_memory_meta WHERE key = 'source_digest'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Failed to read memory index digest: {error}"))?;
    if digest.as_deref() != Some(expected_digest.as_str()) {
        return Err("memory index source digest is stale".to_string());
    }
    let stored_count: usize = connection
        .query_row("SELECT COUNT(*) FROM pi_memory_chunks", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|error| format!("Failed to read memory index count: {error}"))?
        .try_into()
        .map_err(|_| "memory index row count is invalid".to_string())?;
    if stored_count != expected_count {
        return Err("memory index row count is stale".to_string());
    }

    let canonical_root = fs::canonicalize(&paths.root)
        .map_err(|error| format!("Memory directory is unavailable: {error}"))?;
    let canonical_workspace = fs::canonicalize(&paths.workspace)
        .map_err(|error| format!("Memory workspace is unavailable: {error}"))?;
    let canonical_global = fs::canonicalize(&paths.global).ok();
    let canonical_workspace_memory = fs::canonicalize(paths.workspace.join("MEMORY.md")).ok();
    let canonical_sessions = fs::canonicalize(paths.workspace.join("sessions")).ok();

    let mut statement = connection
        .prepare(
            "SELECT path, source, start_line, end_line, text, modified_at
             FROM pi_memory_chunks
             ORDER BY path, start_line, end_line, id",
        )
        .map_err(|error| format!("Failed to prepare memory index query: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(|error| format!("Failed to query memory index rows: {error}"))?;

    let mut chunks = Vec::with_capacity(stored_count);
    for row in rows {
        let (path, source, start_line, end_line, text, modified_at) =
            row.map_err(|error| format!("Failed to decode memory index row: {error}"))?;
        let start_line: usize = start_line
            .try_into()
            .map_err(|_| "memory index start line is invalid".to_string())?;
        let end_line: usize = end_line
            .try_into()
            .map_err(|_| "memory index end line is invalid".to_string())?;
        if end_line <= start_line || end_line.saturating_sub(start_line) > MAX_READ_LINES {
            return Err("memory index line range is invalid".to_string());
        }
        if text.is_empty() || text.len() > MAX_CHUNK_CHARS {
            return Err("memory index chunk text is outside the supported bound".to_string());
        }
        let candidate = PathBuf::from(path);
        if !candidate.is_absolute()
            || candidate.extension().and_then(|value| value.to_str()) != Some("md")
        {
            return Err("memory index row path must be an absolute Markdown file".to_string());
        }
        let metadata = fs::symlink_metadata(&candidate)
            .map_err(|error| format!("Cannot inspect indexed memory file: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("memory index row must reference a regular file".to_string());
        }
        let canonical = fs::canonicalize(&candidate)
            .map_err(|error| format!("Cannot resolve indexed memory file: {error}"))?;
        if !canonical.starts_with(&canonical_root) {
            return Err("memory index row escapes Melody memory".to_string());
        }
        let scope_matches = match source.as_str() {
            "global" => canonical_global
                .as_ref()
                .is_some_and(|value| value == &canonical),
            "workspace" => canonical_workspace_memory
                .as_ref()
                .is_some_and(|value| value == &canonical),
            "session" => canonical_sessions
                .as_ref()
                .is_some_and(|value| canonical.starts_with(value)),
            _ => false,
        };
        if !scope_matches || !canonical.starts_with(&canonical_workspace) && source == "session" {
            return Err("memory index row has an invalid source scope".to_string());
        }
        let actual_modified_at = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_secs() as i64)
            .unwrap_or_default();
        if actual_modified_at != modified_at {
            return Err("memory index row is stale because its file changed".to_string());
        }
        chunks.push(MemoryChunk {
            path: candidate,
            source: match source.as_str() {
                "global" => "global",
                "workspace" => "workspace",
                "session" => "session",
                _ => unreachable!("scope checked above"),
            },
            start_line,
            end_line,
            text,
            modified_at,
        });
    }
    if chunks.len() != expected_count {
        return Err("memory index row count changed while reading".to_string());
    }
    if memory_index_digest(&chunks) != expected_digest {
        return Err("memory index rows differ from the Markdown source".to_string());
    }
    Ok(chunks)
}

fn search_chunks(paths: &MemoryPaths, markdown_chunks: &[MemoryChunk]) -> Vec<MemoryChunk> {
    let index_path = paths.workspace.join("index.sqlite");
    let summary = sync_memory_index_path(&index_path, markdown_chunks).ok();
    if summary.is_some_and(|summary| summary.chunk_count == markdown_chunks.len()) {
        if let Ok(indexed) = load_indexed_chunks(paths, &index_path, markdown_chunks) {
            return indexed;
        }
    }
    markdown_chunks.to_vec()
}

fn memory_index_timestamp(connection: &Connection) -> Result<i64, String> {
    let value: Option<String> = connection
        .query_row(
            "SELECT value FROM pi_memory_meta WHERE key = 'indexed_at'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Failed to read memory index timestamp: {error}"))?;
    Ok(value
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or_default())
}

fn initialize_memory_index_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS pi_memory_meta (
                 key TEXT PRIMARY KEY,
                 value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS pi_memory_chunks (
                 id TEXT PRIMARY KEY,
                 path TEXT NOT NULL,
                 source TEXT NOT NULL,
                 start_line INTEGER NOT NULL,
                 end_line INTEGER NOT NULL,
                 text TEXT NOT NULL,
                 modified_at INTEGER NOT NULL,
                 content_hash TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS pi_memory_chunks_path
                 ON pi_memory_chunks(path);
             CREATE INDEX IF NOT EXISTS pi_memory_chunks_source
                 ON pi_memory_chunks(source);",
        )
        .map_err(|error| format!("Failed to initialize memory index: {error}"))
}

fn memory_index_digest(chunks: &[MemoryChunk]) -> String {
    let mut hasher = Sha256::new();
    for chunk in chunks {
        hasher.update(chunk.path.to_string_lossy().as_bytes());
        hasher.update([0]);
        hasher.update(chunk.source.as_bytes());
        hasher.update([0]);
        hasher.update(chunk.start_line.to_le_bytes());
        hasher.update(chunk.end_line.to_le_bytes());
        hasher.update(chunk.modified_at.to_le_bytes());
        hasher.update([0]);
        hasher.update(chunk.text.as_bytes());
        hasher.update([0]);
    }
    format!("{:x}", hasher.finalize())
}

fn load_chunks(paths: &MemoryPaths) -> Result<Vec<MemoryChunk>, String> {
    let mut files = Vec::new();
    add_memory_file(&mut files, &paths.global, "global");
    add_memory_file(&mut files, &paths.workspace.join("MEMORY.md"), "workspace");
    let sessions = paths.workspace.join("sessions");
    collect_session_files(&sessions, &mut files, 0);
    files.sort_by(|left, right| left.path.cmp(&right.path));
    files.truncate(MAX_FILES);

    let mut total_bytes = 0u64;
    let mut chunks = Vec::new();
    for file in files {
        let metadata = fs::symlink_metadata(&file.path).map_err(|error| {
            format!(
                "Cannot inspect memory file {}: {error}",
                file.path.display()
            )
        })?;
        if metadata.len() > MAX_FILE_BYTES
            || total_bytes.saturating_add(metadata.len()) > MAX_TOTAL_BYTES
        {
            continue;
        }
        total_bytes = total_bytes.saturating_add(metadata.len());
        let content = match read_bounded_utf8(&file.path) {
            Ok(content) => content,
            Err(_) => continue,
        };
        chunks.extend(chunk_markdown(&file, &content));
    }
    Ok(chunks)
}

fn add_memory_file(files: &mut Vec<MemoryFile>, path: &Path, source: &'static str) {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return;
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return;
    }
    if path.extension().and_then(|value| value.to_str()) == Some("md") {
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_secs() as i64)
            .unwrap_or_default();
        files.push(MemoryFile {
            path: path.to_path_buf(),
            source,
            modified_at,
        });
    }
}

fn collect_session_files(directory: &Path, files: &mut Vec<MemoryFile>, depth: usize) {
    if depth > 3 || files.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        if files.len() >= MAX_FILES {
            return;
        }
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            collect_session_files(&path, files, depth + 1);
        } else {
            add_memory_file(files, &path, "session");
        }
    }
}

fn chunk_markdown(file: &MemoryFile, content: &str) -> Vec<MemoryChunk> {
    let lines = content.split('\n').collect::<Vec<_>>();
    let mut chunks = Vec::new();
    let mut start = 0usize;
    let mut length = 0usize;
    for (index, line) in lines.iter().enumerate() {
        let next_length = length.saturating_add(line.len()).saturating_add(1);
        if next_length > MAX_CHUNK_CHARS && index > start {
            push_chunk(&mut chunks, file, &lines, start, index);
            start = index;
            length = 0;
        }
        length = length.saturating_add(line.len()).saturating_add(1);
    }
    if start < lines.len() {
        push_chunk(&mut chunks, file, &lines, start, lines.len());
    }
    chunks
}

fn push_chunk(
    chunks: &mut Vec<MemoryChunk>,
    file: &MemoryFile,
    lines: &[&str],
    start: usize,
    end: usize,
) {
    let text = lines[start..end].join("\n");
    if text.trim().is_empty() || is_scaffold(&text) {
        return;
    }
    chunks.push(MemoryChunk {
        path: file.path.clone(),
        source: file.source,
        start_line: start,
        end_line: end,
        text,
        modified_at: file.modified_at,
    });
}

fn is_scaffold(text: &str) -> bool {
    let mut substantive = false;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("<!--") {
            continue;
        }
        substantive = true;
        break;
    }
    !substantive
}

fn rank_chunks(
    chunks: &[MemoryChunk],
    query: &str,
    config: &SearchConfig,
    max_results: usize,
    min_score: f64,
) -> Vec<(f64, MemoryChunk)> {
    let query_tokens = tokenize(query).into_iter().collect::<HashSet<_>>();
    if query_tokens.is_empty() || chunks.is_empty() {
        return Vec::new();
    }
    let mut document_frequency = HashMap::<String, usize>::new();
    let mut frequencies = Vec::with_capacity(chunks.len());
    let mut total_length = 0usize;
    for chunk in chunks {
        let tokens = tokenize(&chunk.text);
        total_length = total_length.saturating_add(tokens.len());
        let mut counts = HashMap::<String, usize>::new();
        for token in tokens {
            *counts.entry(token).or_default() += 1;
        }
        for token in counts.keys() {
            *document_frequency.entry(token.clone()).or_default() += 1;
        }
        frequencies.push(counts);
    }
    let average_length = (total_length as f64 / chunks.len() as f64).max(1.0);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or_default();
    let mut scored = Vec::new();
    let mut maximum = 0.0f64;
    for (index, chunk) in chunks.iter().enumerate() {
        let length = frequencies[index].values().sum::<usize>() as f64;
        let mut score = 0.0;
        for token in &query_tokens {
            let Some(term_frequency) = frequencies[index].get(token) else {
                continue;
            };
            let document_frequency = document_frequency.get(token).copied().unwrap_or(0) as f64;
            let idf = (((chunks.len() as f64 - document_frequency + 0.5)
                / (document_frequency + 0.5))
                + 1.0)
                .ln();
            let tf = *term_frequency as f64;
            let denominator = tf + 1.2 * (0.25 + 0.75 * (length / average_length));
            score += idf * (tf * 2.2 / denominator.max(0.001));
        }
        if score <= 0.0 {
            continue;
        }
        let source_weight = config
            .source_weights
            .get(chunk.source)
            .copied()
            .unwrap_or(1.0);
        score *= source_weight;
        if config.temporal_decay && chunk.source == "session" {
            let age_days = ((now - chunk.modified_at).max(0) as f64) / 86_400.0;
            score *= (-std::f64::consts::LN_2 * age_days / config.half_life_days).exp();
        }
        maximum = maximum.max(score);
        scored.push((score, chunk.clone()));
    }
    if maximum <= 0.0 {
        return Vec::new();
    }
    let mut normalized = scored
        .into_iter()
        .map(|(score, chunk)| ((score / maximum).clamp(0.0, 1.0), chunk))
        .filter(|(score, _)| *score >= min_score)
        .collect::<Vec<_>>();
    normalized.sort_by(|left, right| {
        right
            .0
            .partial_cmp(&left.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.1.path.cmp(&right.1.path))
            .then_with(|| left.1.start_line.cmp(&right.1.start_line))
    });
    normalized.truncate(max_results);
    normalized
}

fn format_search_output(results: &[(f64, MemoryChunk)]) -> Result<String, String> {
    if results.is_empty() {
        return Ok("No memory results found for query.".to_string());
    }
    let mut output = format!("Found {} memory result(s):\n", results.len());
    for (index, (score, chunk)) in results.iter().enumerate() {
        let snippet = bound_text(chunk.text.trim().to_string(), MAX_SNIPPET_BYTES);
        let staleness = if chunk.source == "session" {
            let age_days = (SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_secs() as i64)
                .unwrap_or_default()
                .saturating_sub(chunk.modified_at)) as f64
                / 86_400.0;
            if age_days > 7.0 {
                format!(
                    "**Stale ({:.0}d):** Verify this is still current.\n",
                    age_days
                )
            } else if age_days > 1.0 {
                format!(
                    "**Note ({:.0}d):** Verify this is still current.\n",
                    age_days
                )
            } else {
                String::new()
            }
        } else {
            String::new()
        };
        output.push_str(&format!(
            "\n### Result {} (score: {:.2}, source: {})\n**File:** {} (lines {}-{})\n{} [snippet]\n{}\n[/snippet]\n",
            index + 1,
            score,
            chunk.source,
            chunk.path.display(),
            chunk.start_line,
            chunk.end_line,
            staleness,
            snippet
        ));
        if output.len() > MAX_OUTPUT_BYTES {
            return Ok(bound_text(output, MAX_OUTPUT_BYTES));
        }
    }
    Ok(output)
}

fn tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for character in text.chars() {
        if character.is_alphanumeric() || character == '_' {
            if character.is_ascii() {
                current.push(character.to_ascii_lowercase());
            } else {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
                tokens.push(character.to_lowercase().collect());
            }
        } else if !current.is_empty() {
            tokens.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn read_bounded_utf8(path: &Path) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Cannot inspect memory file {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("memory path must be a regular file".to_string());
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err("memory file exceeds the 2 MB limit".to_string());
    }
    let mut file = File::open(path).map_err(|error| format!("Cannot read memory file: {error}"))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("Cannot read memory file: {error}"))?;
    String::from_utf8(bytes).map_err(|_| "memory file must be valid UTF-8".to_string())
}

fn safe_memory_file(path: &Path, canonical_root: &Path) -> Result<PathBuf, String> {
    let canonical =
        fs::canonicalize(path).map_err(|error| format!("Cannot resolve memory path: {error}"))?;
    if !canonical.starts_with(canonical_root)
        || canonical.extension().and_then(|value| value.to_str()) != Some("md")
    {
        return Err(
            "memory_get path must be an existing Markdown file inside Melody memory".to_string(),
        );
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Cannot inspect memory path: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("memory_get path must be a regular Markdown file".to_string());
    }
    Ok(canonical)
}

fn truncate_utf8(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }
    let mut end = limit;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

fn bound_text(text: String, limit: usize) -> String {
    if text.len() <= limit {
        return text;
    }
    const SUFFIX: &str = "\n[output truncated]";
    if limit <= SUFFIX.len() {
        return truncate_utf8(&text, limit);
    }
    let mut bounded = truncate_utf8(&text, limit - SUFFIX.len());
    bounded.push_str(SUFFIX);
    bounded
}

#[cfg(test)]
mod tests {
    use super::{
        MemoryChunk, SearchConfig, SessionMemoryMessage, append_memory_content,
        format_session_transcript, memory_enabled, normalize_memory_content,
        normalize_memory_content_checked, normalize_remote_url, rank_chunks, slugify,
        strip_injected_context,
    };
    use serde_json::Map;
    use std::{collections::HashMap, path::PathBuf};

    fn chunk(text: &str, source: &'static str) -> MemoryChunk {
        MemoryChunk {
            path: PathBuf::from("/memory/example.md"),
            source,
            start_line: 0,
            end_line: 1,
            text: text.to_string(),
            modified_at: 1_700_000_000,
        }
    }

    #[test]
    fn normalizes_git_remote_to_shared_identity() {
        assert_eq!(
            normalize_remote_url("git@github.com:acme/widgets.git"),
            Some("acme/widgets".to_string())
        );
        assert_eq!(
            normalize_remote_url("https://github.com/acme/widgets.git"),
            Some("acme/widgets".to_string())
        );
    }

    #[test]
    fn ranks_matching_memory_and_applies_source_weight() {
        let chunks = vec![
            chunk(
                "authentication middleware uses session cookies",
                "workspace",
            ),
            chunk("unrelated release notes", "session"),
        ];
        let result = rank_chunks(
            &chunks,
            "authentication middleware",
            &SearchConfig {
                max_results: 6,
                min_score: 0.0,
                temporal_decay: false,
                half_life_days: 7.0,
                source_weights: HashMap::new(),
            },
            6,
            0.0,
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].1.source, "workspace");
        assert!(result[0].0 > 0.9);
    }

    #[test]
    fn slugify_is_bounded_and_stable() {
        assert_eq!(slugify("Hello World", 20), "hello-world");
        assert!(slugify("a very long name", 8).len() <= 8);
    }

    #[test]
    fn strips_only_the_exact_first_turn_marker() {
        let value = "<melody-memory-context>\ncontext\n</melody-memory-context>\n\nquestion";
        assert_eq!(strip_injected_context(value), "question");
        assert_eq!(
            strip_injected_context("user supplied text"),
            "user supplied text"
        );
        assert_eq!(
            strip_injected_context("<melody-memory-context>\nunterminated"),
            "<melody-memory-context>\nunterminated"
        );
    }

    #[test]
    fn formats_bounded_session_transcript_without_tool_or_unknown_roles() {
        let messages = vec![
            SessionMemoryMessage {
                id: "u1".into(),
                role: "user".into(),
                content: "请记住这个约定".into(),
            },
            SessionMemoryMessage {
                id: "t1".into(),
                role: "tool".into(),
                content: "secret tool output".into(),
            },
            SessionMemoryMessage {
                id: "a1".into(),
                role: "assistant".into(),
                content: "好的".into(),
            },
        ];
        let output = format_session_transcript(&messages);
        assert!(output.starts_with("# Session Transcript"));
        assert!(output.contains("## User"));
        assert!(output.contains("## Assistant"));
        assert!(!output.contains("secret tool output"));
    }

    #[test]
    fn enables_memory_for_non_empty_configuration_without_explicit_flag() {
        let mut config = Map::new();
        config.insert(
            "memory".to_string(),
            serde_json::json!({"search": {"max_results": 6}}),
        );
        assert!(memory_enabled(&config));
        config.insert(
            "memory".to_string(),
            serde_json::json!({"enabled": false, "search": {"max_results": 6}}),
        );
        assert!(!memory_enabled(&config));
    }

    #[test]
    fn bounds_output_without_exceeding_byte_limit() {
        let output = super::bound_text("abcdefghijk".to_string(), 8);
        assert!(output.len() <= 8);
        let output = super::bound_text("你好世界".to_string(), 5);
        assert!(output.len() <= 5);
        assert!(output.is_char_boundary(output.len()));
    }

    #[test]
    fn normalizes_memory_notes_like_melody_build() {
        assert_eq!(normalize_memory_content("Use Swift 6"), "## Use Swift 6");
        assert_eq!(
            normalize_memory_content("Decision\nKeep the bridge Host-owned"),
            "## Decision\n\nKeep the bridge Host-owned"
        );
        assert_eq!(
            normalize_memory_content("# Existing heading\n\nBody"),
            "# Existing heading\n\nBody"
        );
    }

    #[test]
    fn validates_memory_notes_and_appends_with_blank_separator() {
        assert!(normalize_memory_content_checked("  \n").is_err());
        assert!(normalize_memory_content_checked("bad\u{0007}").is_err());
        let normalized = normalize_memory_content_checked("Remember this").unwrap();
        assert_eq!(
            append_memory_content(Some("## Existing"), &normalized).unwrap(),
            "## Existing\n\n## Remember this"
        );
        assert_eq!(
            append_memory_content(None, &normalized).unwrap(),
            "## Remember this"
        );
    }

    #[cfg(unix)]
    #[test]
    fn memory_write_path_rejects_symlink_components() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("melody-pi-memory-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let outside = root.with_file_name(format!(
            "{}-outside",
            root.file_name().unwrap().to_string_lossy()
        ));
        std::fs::create_dir_all(&outside).unwrap();
        let linked = root.join("workspace");
        symlink(&outside, &linked).unwrap();
        assert!(super::ensure_memory_write_path(&root, &linked.join("MEMORY.md")).is_err());
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn memory_index_sync_is_incremental_and_removes_stale_chunks() {
        let root =
            std::env::temp_dir().join(format!("melody-pi-memory-index-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let index_path = root.join("index.sqlite");
        let first_chunks = vec![chunk("first durable fact", "workspace")];

        let first = super::sync_memory_index_path(&index_path, &first_chunks).unwrap();
        assert!(first.changed);
        assert_eq!(first.chunk_count, 1);
        let second = super::sync_memory_index_path(&index_path, &first_chunks).unwrap();
        assert!(!second.changed);
        assert_eq!(second.chunk_count, 1);

        let mut replacement = chunk("replacement fact", "workspace");
        replacement.path = PathBuf::from("/memory/replacement.md");
        let second_chunks = vec![replacement, chunk("new session fact", "session")];
        let third = super::sync_memory_index_path(&index_path, &second_chunks).unwrap();
        assert!(third.changed);
        assert_eq!(third.chunk_count, 2);

        let connection = rusqlite::Connection::open(&index_path).unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM pi_memory_chunks", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 2);
        let stale: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pi_memory_chunks WHERE text = 'first durable fact'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stale, 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn memory_index_schema_mismatch_is_rebuilt_from_markdown_chunks() {
        let root =
            std::env::temp_dir().join(format!("melody-pi-memory-schema-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let index_path = root.join("index.sqlite");
        let connection = rusqlite::Connection::open(&index_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE pi_memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 CREATE TABLE pi_memory_chunks (id TEXT PRIMARY KEY, text TEXT NOT NULL);
                 INSERT INTO pi_memory_meta(key, value) VALUES ('schema_version', '0');
                 INSERT INTO pi_memory_chunks(id, text) VALUES ('old', 'obsolete');",
            )
            .unwrap();
        drop(connection);

        let summary = super::sync_memory_index_path(
            &index_path,
            &[chunk("replacement after schema upgrade", "workspace")],
        )
        .unwrap();
        assert!(summary.changed);

        let connection = rusqlite::Connection::open(&index_path).unwrap();
        let schema: String = connection
            .query_row(
                "SELECT value FROM pi_memory_meta WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(schema, super::MEMORY_INDEX_SCHEMA_VERSION);
        let old_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pi_memory_chunks WHERE text = 'obsolete'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(old_count, 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fresh_memory_index_rows_can_be_loaded_for_search() {
        let root = std::env::temp_dir().join(format!(
            "melody-pi-memory-index-read-{}",
            uuid::Uuid::new_v4()
        ));
        let workspace = root.join("workspace-1234");
        std::fs::create_dir_all(workspace.join("sessions")).unwrap();
        std::fs::write(root.join("MEMORY.md"), "global fact").unwrap();
        std::fs::write(workspace.join("MEMORY.md"), "workspace fact").unwrap();
        let global_modified = std::fs::metadata(root.join("MEMORY.md"))
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let workspace_modified = std::fs::metadata(workspace.join("MEMORY.md"))
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let paths = super::MemoryPaths {
            root: root.clone(),
            global: root.join("MEMORY.md"),
            workspace: workspace.clone(),
        };
        let chunks = vec![
            super::MemoryChunk {
                path: paths.global.clone(),
                source: "global",
                start_line: 0,
                end_line: 1,
                text: "global fact".into(),
                modified_at: global_modified,
            },
            super::MemoryChunk {
                path: paths.workspace.join("MEMORY.md"),
                source: "workspace",
                start_line: 0,
                end_line: 1,
                text: "workspace fact".into(),
                modified_at: workspace_modified,
            },
        ];
        let index_path = workspace.join("index.sqlite");
        super::sync_memory_index_path(&index_path, &chunks).unwrap();
        let indexed = super::load_indexed_chunks(&paths, &index_path, &chunks).unwrap();
        assert_eq!(indexed.len(), chunks.len());
        assert_eq!(indexed[0].source, "global");
        assert_eq!(indexed[1].text, "workspace fact");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn memory_index_read_rejects_stale_digest_and_out_of_scope_rows() {
        let root = std::env::temp_dir().join(format!(
            "melody-pi-memory-index-reject-{}",
            uuid::Uuid::new_v4()
        ));
        let workspace = root.join("workspace-1234");
        std::fs::create_dir_all(workspace.join("sessions")).unwrap();
        std::fs::write(root.join("MEMORY.md"), "global fact").unwrap();
        std::fs::write(workspace.join("MEMORY.md"), "workspace fact").unwrap();
        let paths = super::MemoryPaths {
            root: root.clone(),
            global: root.join("MEMORY.md"),
            workspace: workspace.clone(),
        };
        let chunks = vec![super::MemoryChunk {
            path: paths.workspace.join("MEMORY.md"),
            source: "workspace",
            start_line: 0,
            end_line: 1,
            text: "workspace fact".into(),
            modified_at: std::fs::metadata(workspace.join("MEMORY.md"))
                .unwrap()
                .modified()
                .unwrap()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64,
        }];
        let index_path = workspace.join("index.sqlite");
        super::sync_memory_index_path(&index_path, &chunks).unwrap();
        assert!(
            super::load_indexed_chunks(
                &paths,
                &index_path,
                &[super::MemoryChunk {
                    text: "not-the-current-digest".into(),
                    ..chunks[0].clone()
                }],
            )
            .is_err()
        );

        let connection = rusqlite::Connection::open(&index_path).unwrap();
        connection
            .execute(
                "UPDATE pi_memory_chunks SET path = ?1",
                rusqlite::params![root.join("outside.md").to_string_lossy().to_string()],
            )
            .unwrap();
        assert!(super::load_indexed_chunks(&paths, &index_path, &chunks,).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn memory_index_read_rejects_row_text_tampering_even_when_metadata_is_unchanged() {
        let root = std::env::temp_dir().join(format!(
            "melody-pi-memory-index-tamper-{}",
            uuid::Uuid::new_v4()
        ));
        let workspace = root.join("workspace-1234");
        std::fs::create_dir_all(workspace.join("sessions")).unwrap();
        std::fs::write(workspace.join("MEMORY.md"), "workspace fact").unwrap();
        let paths = super::MemoryPaths {
            root: root.clone(),
            global: root.join("MEMORY.md"),
            workspace: workspace.clone(),
        };
        let chunks = vec![super::MemoryChunk {
            path: paths.workspace.join("MEMORY.md"),
            source: "workspace",
            start_line: 0,
            end_line: 1,
            text: "workspace fact".into(),
            modified_at: std::fs::metadata(workspace.join("MEMORY.md"))
                .unwrap()
                .modified()
                .unwrap()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64,
        }];
        let index_path = workspace.join("index.sqlite");
        super::sync_memory_index_path(&index_path, &chunks).unwrap();
        let connection = rusqlite::Connection::open(&index_path).unwrap();
        connection
            .execute("UPDATE pi_memory_chunks SET text = 'tampered fact'", [])
            .unwrap();
        drop(connection);

        assert!(super::load_indexed_chunks(&paths, &index_path, &chunks).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
