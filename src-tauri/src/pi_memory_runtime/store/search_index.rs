//! Disposable SQLite projection of the authoritative Markdown memory store.
//!
//! This module validates the sidecar before reads and treats every index failure
//! as a cache miss so callers can always use freshly loaded Markdown chunks.

use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{
    MAX_CHUNK_CHARS, MAX_FILES, MAX_READ_LINES, MemoryChunk, MemoryPaths, load_chunks, memory_paths,
};

pub(in crate::pi_memory_runtime) const MEMORY_INDEX_SCHEMA_VERSION: &str = "1";
const MEMORY_INDEX_MAX_CHUNKS: usize = MAX_FILES * 64;

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

pub(in crate::pi_memory_runtime) fn rebuild_memory_index(
    root: &Path,
) -> Result<MemoryIndexSummary, String> {
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

pub(in crate::pi_memory_runtime) fn sync_memory_index_path(
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
pub(in crate::pi_memory_runtime) fn load_indexed_chunks(
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

pub(super) fn search_chunks(
    paths: &MemoryPaths,
    markdown_chunks: &[MemoryChunk],
) -> Vec<MemoryChunk> {
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
