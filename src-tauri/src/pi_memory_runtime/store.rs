//! Host-owned Markdown memory store.
//!
//! Markdown files remain authoritative. This module owns scoped file paths,
//! bounded reads/writes, and memory tool operations. The child `search_index`
//! module owns the disposable lexical index; session transcript policy and worker
//! lifecycle remain in the parent runtime.

use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, MutexGuard, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::{agent_runtime::melody_home, config_io::TextFileStore};

#[path = "store/search_index.rs"]
mod search_index;
pub(crate) use self::search_index::MemoryIndexSummary;
pub(super) use self::search_index::{rebuild_memory_index, sync_memory_index_path};

const MEMORY_DIR: &str = "memory";
pub(super) const MAX_QUERY_BYTES: usize = 2_048;
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

/// Serialize append operations across Pi sessions. A read/modify/atomic
/// replace sequence without a shared lock could otherwise lose one of two
/// simultaneous durable notes.
static MEMORY_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(super) fn lock_memory_writes() -> Result<MutexGuard<'static, ()>, String> {
    MEMORY_WRITE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Memory write lock is poisoned".to_string())
}

pub(super) fn refresh_index(paths: &MemoryPaths) {
    if let Ok(chunks) = load_chunks(paths) {
        let _ = sync_memory_index_path(&paths.workspace.join("index.sqlite"), &chunks);
    }
}

#[derive(Clone, Debug)]
pub(super) struct MemoryPaths {
    pub(super) root: PathBuf,
    pub(super) global: PathBuf,
    pub(super) workspace: PathBuf,
}

#[derive(Clone, Debug)]
struct MemoryFile {
    path: PathBuf,
    source: &'static str,
    modified_at: i64,
}

#[derive(Clone, Debug)]
pub(super) struct MemoryChunk {
    pub(super) path: PathBuf,
    pub(super) source: &'static str,
    pub(super) start_line: usize,
    pub(super) end_line: usize,
    pub(super) text: String,
    pub(super) modified_at: i64,
}

#[derive(Clone, Debug)]
pub(super) struct SearchConfig {
    pub(super) max_results: usize,
    pub(super) min_score: f64,
    pub(super) temporal_decay: bool,
    pub(super) half_life_days: f64,
    pub(super) source_weights: HashMap<String, f64>,
}

pub(super) fn memory_search(
    root: &Path,
    arguments: &Map<String, Value>,
    config: &Map<String, Value>,
) -> Result<String, String> {
    let query = arguments
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "query must be a non-empty string".to_string())?;
    if query.len() > MAX_QUERY_BYTES {
        return Err("query exceeds the 2 KB memory search limit".to_string());
    }
    let settings = search_config(config)?;
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
    let chunks = search_index::search_chunks(&paths, &markdown_chunks);
    let results = rank_chunks(&chunks, query, &settings, max_results, min_score);
    format_search_output(&results)
}

pub(super) fn memory_get(root: &Path, arguments: &Map<String, Value>) -> Result<String, String> {
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
pub(super) fn memory_remember(
    root: &Path,
    arguments: &Map<String, Value>,
) -> Result<String, String> {
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

    let lock = lock_memory_writes()?;
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
    refresh_index(&paths);

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
pub(super) fn ensure_memory_write_path(root: &Path, target: &Path) -> Result<(), String> {
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

pub(super) fn initial_memory_search(
    root: &Path,
    config: &Map<String, Value>,
    query: &str,
    min_score: f64,
) -> Result<Option<String>, String> {
    let settings = search_config(config)?;
    let paths = memory_paths(root)?;
    let markdown_chunks = load_chunks(&paths)?;
    let chunks = search_index::search_chunks(&paths, &markdown_chunks);
    let results = rank_chunks(&chunks, query, &settings, settings.max_results, min_score);
    if results.is_empty() {
        return Ok(None);
    }
    format_search_output(&results).map(Some)
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

pub(super) fn memory_paths(cwd: &Path) -> Result<MemoryPaths, String> {
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

pub(super) fn normalize_remote_url(value: &str) -> Option<String> {
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

pub(super) fn slugify(value: &str, max_len: usize) -> String {
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

pub(super) fn rank_chunks(
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

pub(super) fn read_bounded_utf8(path: &Path) -> Result<String, String> {
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

pub(super) fn safe_memory_file(path: &Path, canonical_root: &Path) -> Result<PathBuf, String> {
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

pub(super) fn bound_text(text: String, limit: usize) -> String {
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
