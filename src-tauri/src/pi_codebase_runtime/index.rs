//! Host-owned bounded workspace index and code-location query lifecycle.

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::UNIX_EPOCH,
};

use ignore::WalkBuilder;
use serde::Serialize;
use serde_json::{Value, json};

use super::{
    parser::{Occurrence, parse_source, supports_path},
    request,
};
use crate::workspace_runtime::is_ignored_directory;

const MAX_FILES: usize = 4_096;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RESULTS: usize = 100;
const MAX_ERRORS: usize = 32;
const MAX_ERROR_BYTES: usize = 512;
const MAX_INDEX_WORKSPACES: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileFingerprint {
    size: u64,
    modified_secs: i64,
    modified_nanos: u32,
}

impl FileFingerprint {
    fn from_metadata(metadata: &fs::Metadata) -> Self {
        let (modified_secs, modified_nanos) = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| (duration.as_secs() as i64, duration.subsec_nanos()))
            .unwrap_or((0, 0));
        Self {
            size: metadata.len(),
            modified_secs,
            modified_nanos,
        }
    }
}

#[derive(Debug, Clone)]
struct IndexedFile {
    fingerprint: FileFingerprint,
    relative_path: String,
    definitions: Vec<Occurrence>,
    references: Vec<Occurrence>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CodeLocation {
    path: String,
    /// Zero-based line and byte column, matching tree-sitter and the Pi tool
    /// request. Symbol names in supported languages are UTF-8 identifiers,
    /// while tree-sitter reports columns in bytes.
    line: usize,
    character: usize,
    symbol: String,
    kind: String,
}

#[derive(Debug, Clone)]
pub(super) struct CodebaseIndex {
    root: PathBuf,
    files: HashMap<PathBuf, IndexedFile>,
    generation: u64,
    scanned_files: usize,
    skipped_files: usize,
    total_bytes: u64,
    errors: Vec<String>,
}

impl CodebaseIndex {
    fn new(root: PathBuf) -> Self {
        Self {
            root,
            files: HashMap::new(),
            generation: 0,
            scanned_files: 0,
            skipped_files: 0,
            total_bytes: 0,
            errors: Vec::new(),
        }
    }

    fn rebuild(&mut self) -> Result<(), String> {
        self.files.clear();
        self.refresh()
    }

    /// Refresh changed files while retaining parsed results for unchanged
    /// files. Walking on every request is intentional: it makes edits visible
    /// without a background watcher and bounds the amount of state retained
    /// by the Host.
    fn refresh(&mut self) -> Result<(), String> {
        let root = request::canonical_workspace(&self.root)?;
        self.root = root.clone();
        let mut builder = WalkBuilder::new(&root);
        builder
            .hidden(true)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .follow_links(false)
            .filter_entry(|entry| {
                if entry.depth() == 0 {
                    return true;
                }
                let Some(file_type) = entry.file_type() else {
                    return false;
                };
                !file_type.is_dir() || !is_ignored_directory(&entry.file_name().to_string_lossy())
            });

        let mut candidates = Vec::new();
        let mut skipped = 0usize;
        let mut errors = Vec::new();
        let mut total_bytes = 0u64;
        for result in builder.build() {
            let entry = match result {
                Ok(entry) => entry,
                Err(error) => {
                    push_error(&mut errors, error.to_string());
                    continue;
                }
            };
            let Some(file_type) = entry.file_type() else {
                skipped = skipped.saturating_add(1);
                continue;
            };
            if !file_type.is_file() || file_type.is_symlink() {
                continue;
            }
            if !supports_path(entry.path()) {
                continue;
            }
            if candidates.len() >= MAX_FILES {
                skipped = skipped.saturating_add(1);
                continue;
            }
            let canonical = match entry.path().canonicalize() {
                Ok(path) if path.starts_with(&root) && path.is_file() => path,
                Ok(_) => {
                    skipped = skipped.saturating_add(1);
                    continue;
                }
                Err(error) => {
                    skipped = skipped.saturating_add(1);
                    push_error(&mut errors, error.to_string());
                    continue;
                }
            };
            let metadata = match fs::metadata(&canonical) {
                Ok(metadata) => metadata,
                Err(error) => {
                    skipped = skipped.saturating_add(1);
                    push_error(&mut errors, error.to_string());
                    continue;
                }
            };
            let size = metadata.len();
            if size > MAX_FILE_BYTES || total_bytes.saturating_add(size) > MAX_TOTAL_BYTES {
                skipped = skipped.saturating_add(1);
                continue;
            }
            total_bytes = total_bytes.saturating_add(size);
            candidates.push((canonical, FileFingerprint::from_metadata(&metadata)));
        }

        let paths = candidates
            .iter()
            .map(|(path, _)| path.clone())
            .collect::<HashSet<_>>();
        self.files.retain(|path, _| paths.contains(path));

        for (path, fingerprint) in candidates {
            if self
                .files
                .get(&path)
                .is_some_and(|file| file.fingerprint == fingerprint)
            {
                continue;
            }
            let source = match fs::read(&path) {
                Ok(source) => source,
                Err(error) => {
                    skipped = skipped.saturating_add(1);
                    push_error(&mut errors, error.to_string());
                    self.files.remove(&path);
                    continue;
                }
            };
            match parse_source(&path, &source) {
                Ok((definitions, references)) => {
                    let relative_path = relative_path(&root, &path)?;
                    self.files.insert(
                        path,
                        IndexedFile {
                            fingerprint,
                            relative_path,
                            definitions,
                            references,
                        },
                    );
                }
                Err(error) => {
                    skipped = skipped.saturating_add(1);
                    push_error(&mut errors, error);
                    self.files.remove(&path);
                }
            }
        }
        self.generation = self.generation.saturating_add(1);
        self.scanned_files = self.files.len();
        self.skipped_files = skipped;
        self.total_bytes = total_bytes;
        self.errors = errors;
        Ok(())
    }

    pub(super) fn status(&self) -> Value {
        json!({
            "root": self.root.to_string_lossy(),
            "generation": self.generation,
            "files": self.scanned_files,
            "skippedFiles": self.skipped_files,
            "bytes": self.total_bytes,
            "languages": ["rust", "typescript", "javascript", "python", "go"],
            "errors": self.errors,
            "implementation": "host-tree-sitter",
        })
    }

    pub(super) fn symbol_at(&self, path: &Path, line: usize, character: usize) -> Option<String> {
        let file = self.files.get(path)?;
        file.definitions
            .iter()
            .chain(file.references.iter())
            .filter(|occurrence| {
                occurrence.line == line
                    && character >= occurrence.character
                    && character <= occurrence.end_character
            })
            .min_by_key(|occurrence| {
                occurrence
                    .end_character
                    .saturating_sub(occurrence.character)
            })
            .map(|occurrence| occurrence.symbol.clone())
    }

    pub(super) fn locations_for_symbol(
        &self,
        symbol: &str,
        references: bool,
        include_definition: bool,
    ) -> Vec<CodeLocation> {
        let mut locations = self
            .files
            .values()
            .flat_map(|file| {
                let occurrences = if references {
                    if include_definition {
                        file.references
                            .iter()
                            .chain(file.definitions.iter())
                            .collect::<Vec<_>>()
                    } else {
                        file.references.iter().collect::<Vec<_>>()
                    }
                } else {
                    file.definitions.iter().collect::<Vec<_>>()
                };
                occurrences.into_iter().map(|occurrence| CodeLocation {
                    path: file.relative_path.clone(),
                    line: occurrence.line,
                    character: occurrence.character,
                    symbol: occurrence.symbol.clone(),
                    kind: occurrence.kind.clone(),
                })
            })
            .filter(|location| location.symbol == symbol)
            .collect::<Vec<_>>();
        sort_locations(&mut locations);
        locations.truncate(MAX_RESULTS);
        locations
    }

    pub(super) fn document_locations(&self, path: &Path) -> Vec<CodeLocation> {
        let Some(file) = self.files.get(path) else {
            return Vec::new();
        };
        let mut locations = file
            .definitions
            .iter()
            .map(|occurrence| CodeLocation {
                path: file.relative_path.clone(),
                line: occurrence.line,
                character: occurrence.character,
                symbol: occurrence.symbol.clone(),
                kind: occurrence.kind.clone(),
            })
            .collect::<Vec<_>>();
        sort_locations(&mut locations);
        locations.truncate(MAX_RESULTS);
        locations
    }

    pub(super) fn workspace_locations(&self, query: &str) -> Vec<CodeLocation> {
        let query = query.to_ascii_lowercase();
        let mut locations = self
            .files
            .values()
            .flat_map(|file| {
                file.definitions.iter().filter_map(|occurrence| {
                    occurrence
                        .symbol
                        .to_ascii_lowercase()
                        .contains(&query)
                        .then(|| CodeLocation {
                            path: file.relative_path.clone(),
                            line: occurrence.line,
                            character: occurrence.character,
                            symbol: occurrence.symbol.clone(),
                            kind: occurrence.kind.clone(),
                        })
                })
            })
            .collect::<Vec<_>>();
        sort_locations(&mut locations);
        locations.truncate(MAX_RESULTS);
        locations
    }
}

static CODEBASE_INDEXES: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<CodebaseIndex>>>>> =
    OnceLock::new();

fn index_for(root: &Path) -> Arc<Mutex<CodebaseIndex>> {
    let indexes = CODEBASE_INDEXES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut indexes = indexes
        .lock()
        .expect("codebase index registry must not be poisoned");
    if let Some(index) = indexes.get(root) {
        return Arc::clone(index);
    }
    if indexes.len() >= MAX_INDEX_WORKSPACES {
        // The map owns one strong reference. Requests hold the other while
        // they refresh/query; evict only idle entries so an in-flight request
        // can never lose its index. This keeps opening many projects from
        // growing the Host registry without a bound.
        let idle_root = indexes
            .iter()
            .find(|(_, index)| Arc::strong_count(index) == 1)
            .map(|(path, _)| path.clone());
        if let Some(idle_root) = idle_root {
            indexes.remove(&idle_root);
        }
    }
    let index = Arc::new(Mutex::new(CodebaseIndex::new(root.to_path_buf())));
    indexes.insert(root.to_path_buf(), Arc::clone(&index));
    index
}

fn push_error(errors: &mut Vec<String>, message: String) {
    if errors.len() >= MAX_ERRORS {
        return;
    }
    let message = if message.len() <= MAX_ERROR_BYTES {
        message
    } else {
        let mut end = MAX_ERROR_BYTES;
        while end > 0 && !message.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &message[..end])
    };
    errors.push(message);
}

fn relative_path(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .map_err(|_| "代码索引路径超出工作区范围。".to_string())
}

fn sort_locations(locations: &mut [CodeLocation]) {
    locations.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then(left.line.cmp(&right.line))
            .then(left.character.cmp(&right.character))
            .then(left.symbol.cmp(&right.symbol))
    });
}

/// Refresh a workspace index under its registry lock and run one bounded query.
pub(super) fn with_index<T>(
    root: &Path,
    rebuild: bool,
    query: impl FnOnce(&CodebaseIndex) -> T,
) -> Result<T, String> {
    let index = index_for(root);
    let mut index = index.lock().map_err(|_| "代码索引锁已损坏。".to_string())?;
    let refresh_result = if rebuild {
        index.rebuild()
    } else {
        index.refresh()
    };
    refresh_result?;
    Ok(query(&index))
}
