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

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::UNIX_EPOCH,
};

use ignore::WalkBuilder;
use serde::Serialize;
use serde_json::{Map, Value, json};
use tree_sitter::{Language, Node, Parser};

use crate::{
    config_runtime::read_melody_config_inner,
    pi_tool_gateway::{self, success_for_request, tool_request_arguments},
    workspace_runtime::is_ignored_directory,
};

pub(crate) const CODEBASE_TOOL: &str = "codebase_navigation";

const MAX_FILES: usize = 4_096;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RESULTS: usize = 100;
const MAX_QUERY_BYTES: usize = 256;
const MAX_SYMBOL_BYTES: usize = 256;
const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_ERRORS: usize = 32;
const MAX_ERROR_BYTES: usize = 512;
const MAX_POSITION: u64 = 100_000;
const MAX_INDEX_PATTERNS: usize = 64;
const MAX_INDEX_PATTERN_BYTES: usize = 512;
const MAX_INDEX_WORKSPACES: usize = 16;
/// Tree-sitter normally handles deeply nested syntax efficiently, but a
/// generated source file can still contain a pathological amount of nesting.
/// Keep the recursive walk shallow so an untrusted workspace cannot exhaust
/// the Host stack while requesting navigation.
const MAX_AST_DEPTH: usize = 256;

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
struct Occurrence {
    symbol: String,
    line: usize,
    character: usize,
    end_character: usize,
    kind: String,
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
struct CodeLocation {
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
struct CodebaseIndex {
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
        let root = canonical_workspace(&self.root)?;
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
            if language_for_path(entry.path()).is_none() {
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

    fn status(&self) -> Value {
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

    fn symbol_at(&self, path: &Path, line: usize, character: usize) -> Option<String> {
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

    fn locations_for_symbol(
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

    fn document_locations(&self, path: &Path) -> Vec<CodeLocation> {
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

    fn workspace_locations(&self, query: &str) -> Vec<CodeLocation> {
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

fn canonical_workspace(root: &Path) -> Result<PathBuf, String> {
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
    if value.trim().is_empty() || value.len() > 4_096 {
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
    if language_for_path(&canonical).is_none() {
        return Err("代码库导航暂不支持该文件类型。".to_string());
    }
    Ok(canonical)
}

fn relative_path(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .map_err(|_| "代码索引路径超出工作区范围。".to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LanguageKind {
    Rust,
    TypeScript,
    JavaScript,
    Python,
    Go,
}

fn language_for_path(path: &Path) -> Option<LanguageKind> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "rs" => Some(LanguageKind::Rust),
        "ts" | "tsx" => Some(LanguageKind::TypeScript),
        "js" | "jsx" | "mjs" | "cjs" => Some(LanguageKind::JavaScript),
        "py" | "pyi" => Some(LanguageKind::Python),
        "go" => Some(LanguageKind::Go),
        _ => None,
    }
}

fn language_for_kind(kind: LanguageKind) -> Language {
    match kind {
        LanguageKind::Rust => tree_sitter_rust::LANGUAGE.into(),
        LanguageKind::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        LanguageKind::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
        LanguageKind::Python => tree_sitter_python::LANGUAGE.into(),
        LanguageKind::Go => tree_sitter_go::LANGUAGE.into(),
    }
}

fn parse_source(path: &Path, source: &[u8]) -> Result<(Vec<Occurrence>, Vec<Occurrence>), String> {
    let kind = language_for_path(path).ok_or_else(|| "不支持的代码文件类型。".to_string())?;
    let mut parser = Parser::new();
    parser
        .set_language(&language_for_kind(kind))
        .map_err(|error| format!("无法初始化代码解析器：{error}"))?;
    let tree = parser
        .parse(source, None)
        .ok_or_else(|| "代码解析失败。".to_string())?;
    let mut definitions = Vec::new();
    let mut references = Vec::new();
    collect_occurrences(
        tree.root_node(),
        source,
        kind,
        &mut definitions,
        &mut references,
        0,
    );
    deduplicate_occurrences(&mut definitions);
    deduplicate_occurrences(&mut references);
    Ok((definitions, references))
}

fn is_identifier_kind(kind: &str) -> bool {
    matches!(
        kind,
        "identifier"
            | "type_identifier"
            | "field_identifier"
            | "property_identifier"
            | "namespace_identifier"
            | "shorthand_property_identifier_pattern"
            | "shorthand_property_identifier"
    )
}

fn node_in_field(parent: Node<'_>, field: &str, node: Node<'_>) -> bool {
    let Some(field_node) = parent.child_by_field_name(field) else {
        return false;
    };
    node.start_byte() >= field_node.start_byte() && node.end_byte() <= field_node.end_byte()
}

fn direct_name(parent: Node<'_>, node: Node<'_>) -> bool {
    parent.child_by_field_name("name").is_some_and(|name| {
        name.start_byte() == node.start_byte() && name.end_byte() == node.end_byte()
    })
}

fn parameter_node(node: Node<'_>) -> bool {
    let mut parent = node.parent();
    for _ in 0..3 {
        let Some(candidate) = parent else {
            return false;
        };
        if matches!(
            candidate.kind(),
            "parameters"
                | "formal_parameters"
                | "parameter_list"
                | "parameter_declaration"
                | "required_parameter"
                | "optional_parameter"
                | "typed_parameter"
                | "default_parameter"
                | "list_splat_pattern"
                | "dictionary_splat_pattern"
        ) {
            return true;
        }
        parent = candidate.parent();
    }
    false
}

fn definition_kind(node: Node<'_>, language: LanguageKind) -> Option<&'static str> {
    let parent = node.parent()?;
    let kind = parent.kind();
    let direct = direct_name(parent, node);
    let pattern = node_in_field(parent, "pattern", node)
        || node_in_field(parent, "left", node)
        || node_in_field(parent, "name", node);
    match language {
        LanguageKind::Rust => {
            if direct {
                return match kind {
                    "function_item" => Some("function"),
                    "struct_item" => Some("struct"),
                    "enum_item" => Some("enum"),
                    "trait_item" => Some("trait"),
                    "type_item" => Some("type"),
                    "mod_item" => Some("module"),
                    "const_item" | "static_item" => Some("constant"),
                    "macro_definition" => Some("macro"),
                    "field_declaration" => Some("field"),
                    _ => None,
                };
            }
            if pattern && matches!(kind, "let_declaration" | "parameter" | "field_declaration") {
                return Some(if kind == "field_declaration" {
                    "field"
                } else {
                    "variable"
                });
            }
        }
        LanguageKind::TypeScript | LanguageKind::JavaScript => {
            if direct {
                return match kind {
                    "function_declaration" | "function" => Some("function"),
                    "class_declaration" | "class" => Some("class"),
                    "interface_declaration" => Some("interface"),
                    "type_alias_declaration" => Some("type"),
                    "enum_declaration" => Some("enum"),
                    "method_definition" | "public_field_definition" => Some("method"),
                    "variable_declarator" => Some("variable"),
                    "import_specifier" | "namespace_import" | "import_clause" => Some("import"),
                    _ => None,
                };
            }
            if pattern
                && matches!(
                    kind,
                    "variable_declarator" | "required_parameter" | "optional_parameter"
                )
            {
                return Some(if kind == "variable_declarator" {
                    "variable"
                } else {
                    "parameter"
                });
            }
            if parameter_node(node) && is_identifier_kind(node.kind()) {
                return Some("parameter");
            }
        }
        LanguageKind::Python => {
            if direct {
                return match kind {
                    "function_definition" => Some("function"),
                    "class_definition" => Some("class"),
                    _ => None,
                };
            }
            if pattern
                && matches!(
                    kind,
                    "assignment"
                        | "for_statement"
                        | "with_item"
                        | "import_statement"
                        | "import_from_statement"
                )
            {
                return Some("variable");
            }
            if parameter_node(node) && is_identifier_kind(node.kind()) {
                return Some("parameter");
            }
        }
        LanguageKind::Go => {
            if direct {
                return match kind {
                    "function_declaration" => Some("function"),
                    "method_declaration" => Some("method"),
                    "type_spec" => Some("type"),
                    "var_spec" | "const_spec" => Some("variable"),
                    "field_declaration" => Some("field"),
                    _ => None,
                };
            }
            if pattern
                && matches!(
                    kind,
                    "var_spec" | "const_spec" | "parameter_declaration" | "short_var_declaration"
                )
            {
                return Some(if kind == "parameter_declaration" {
                    "parameter"
                } else {
                    "variable"
                });
            }
            if parameter_node(node) && is_identifier_kind(node.kind()) {
                return Some("parameter");
            }
        }
    }
    None
}

fn collect_occurrences(
    node: Node<'_>,
    source: &[u8],
    language: LanguageKind,
    definitions: &mut Vec<Occurrence>,
    references: &mut Vec<Occurrence>,
    depth: usize,
) {
    if depth > MAX_AST_DEPTH {
        return;
    }
    if is_identifier_kind(node.kind()) {
        if let Ok(raw) = node.utf8_text(source) {
            let symbol = raw.trim();
            if valid_symbol(symbol) {
                let occurrence = Occurrence {
                    symbol: symbol.to_string(),
                    line: node.start_position().row,
                    character: node.start_position().column,
                    end_character: node.end_position().column,
                    kind: definition_kind(node, language)
                        .unwrap_or("reference")
                        .to_string(),
                };
                if definition_kind(node, language).is_some() {
                    definitions.push(occurrence);
                } else {
                    references.push(occurrence);
                }
            }
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_occurrences(
            child,
            source,
            language,
            definitions,
            references,
            depth.saturating_add(1),
        );
    }
}

fn valid_symbol(symbol: &str) -> bool {
    !symbol.is_empty()
        && symbol.len() <= MAX_SYMBOL_BYTES
        && symbol.chars().all(|character| {
            !character.is_control()
                && !character.is_whitespace()
                && !matches!(character, '(' | ')' | '[' | ']' | '{' | '}' | '"' | '\'')
        })
}

fn deduplicate_occurrences(occurrences: &mut Vec<Occurrence>) {
    occurrences.sort_by(|left, right| {
        left.line
            .cmp(&right.line)
            .then(left.character.cmp(&right.character))
            .then(left.symbol.cmp(&right.symbol))
    });
    occurrences.dedup_by(|left, right| {
        left.line == right.line && left.character == right.character && left.symbol == right.symbol
    });
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CodebaseOperation {
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

    fn requires_file(self) -> bool {
        matches!(
            self,
            Self::Definition | Self::References | Self::DocumentSymbols
        )
    }

    fn requires_position(self) -> bool {
        matches!(self, Self::Definition | Self::References)
    }

    fn output_name(self) -> &'static str {
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
    let operation = match arguments
        .get("operation")
        .and_then(Value::as_str)
        .and_then(CodebaseOperation::parse)
    {
        Some(operation) => operation,
        None => {
            return pi_tool_gateway::fail_for_request(
                value,
                "pi.codebase_tool_failed",
                "operation 必须是受支持的代码库导航操作。".to_string(),
            );
        }
    };
    let root = match canonical_workspace(root) {
        Ok(root) => root,
        Err(error) => {
            return pi_tool_gateway::fail_for_request(value, "pi.codebase_tool_failed", error);
        }
    };
    let file_path = match arguments.get("file_path").and_then(Value::as_str) {
        Some(path) => match normalize_file_path(&root, path) {
            Ok(path) => Some(path),
            Err(error) => {
                return pi_tool_gateway::fail_for_request(value, "pi.codebase_tool_failed", error);
            }
        },
        None if operation.requires_file() => {
            return pi_tool_gateway::fail_for_request(
                value,
                "pi.codebase_tool_failed",
                "该代码库导航操作需要 file_path。".to_string(),
            );
        }
        None => None,
    };
    let line = match parse_position(arguments, "line") {
        Ok(value) => value,
        Err(error) => {
            return pi_tool_gateway::fail_for_request(value, "pi.codebase_tool_failed", error);
        }
    };
    let character = match parse_position(arguments, "character") {
        Ok(value) => value,
        Err(error) => {
            return pi_tool_gateway::fail_for_request(value, "pi.codebase_tool_failed", error);
        }
    };
    if operation.requires_position() && (line.is_none() || character.is_none()) {
        return pi_tool_gateway::fail_for_request(
            value,
            "pi.codebase_tool_failed",
            "定义和引用查询需要 line 和 character。".to_string(),
        );
    }
    let query = match parse_query(arguments) {
        Ok(query) => query,
        Err(error) => {
            return pi_tool_gateway::fail_for_request(value, "pi.codebase_tool_failed", error);
        }
    };
    let include_definition = match parse_include_definition(arguments) {
        Ok(value) => value,
        Err(error) => {
            return pi_tool_gateway::fail_for_request(value, "pi.codebase_tool_failed", error);
        }
    };
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
    let index = index_for(&root);
    let mut index = match index.lock() {
        Ok(index) => index,
        Err(_) => {
            return pi_tool_gateway::fail_for_request(
                value,
                "pi.codebase_tool_failed",
                "代码索引锁已损坏。",
            );
        }
    };
    let refresh_result = if operation == CodebaseOperation::Rebuild {
        index.rebuild()
    } else {
        index.refresh()
    };
    if let Err(error) = refresh_result {
        return pi_tool_gateway::fail_for_request(value, "pi.codebase_tool_failed", error);
    }
    let output = match operation {
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
                .and_then(|line| character.map(|character| index.symbol_at(&path, line, character)))
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
                .and_then(|line| character.map(|character| index.symbol_at(&path, line, character)))
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn request(root: &Path, arguments: Value) -> Value {
        json!({
            "sessionId": "session-1",
            "runId": "run-1",
            "event": {
                "type": "tool.requested",
                "toolCallId": "tool-1",
                "toolName": CODEBASE_TOOL,
                "activity": { "arguments": arguments },
            },
            "cwd": root.to_string_lossy(),
        })
    }

    #[test]
    fn parses_operations_and_aliases() {
        assert_eq!(
            CodebaseOperation::parse("goToDefinition"),
            Some(CodebaseOperation::Definition)
        );
        assert_eq!(
            CodebaseOperation::parse("workspaceSymbols"),
            Some(CodebaseOperation::WorkspaceSymbols)
        );
        assert_eq!(CodebaseOperation::parse("unknown"), None);
    }

    #[test]
    fn matches_codebase_indexing_switch_and_path_patterns() {
        assert!(
            !CodebaseIndexingPolicy::Enabled(false)
                .should_index(Path::new("/workspace/project"))
                .unwrap()
        );
        assert!(
            CodebaseIndexingPolicy::Enabled(true)
                .should_index(Path::new("/workspace/project"))
                .unwrap()
        );

        let policy =
            parse_codebase_indexing_value(&json!(["/workspace/*", "!/workspace/ignored"])).unwrap();
        assert!(
            policy
                .should_index(Path::new("/workspace/project"))
                .unwrap()
        );
        assert!(
            !policy
                .should_index(Path::new("/workspace/ignored"))
                .unwrap()
        );
        assert!(parse_codebase_indexing_value(&json!(["["])).is_err());
    }

    #[test]
    fn indexes_definitions_references_and_refreshes_changes() {
        let root =
            std::env::temp_dir().join(format!("melody-codebase-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("src")).unwrap();
        let file = root.join("src/lib.rs");
        fs::write(&file, "fn greet() {}\nfn main() { greet(); }\n").unwrap();

        let definition = resolve_request(
            &root,
            &request(
                &root,
                json!({ "operation": "definition", "file_path": "src/lib.rs", "line": 1, "character": 14 }),
            ),
        );
        let locations = definition["resolution"]["output"].as_str().unwrap();
        assert!(locations.contains("\"symbol\":\"greet\""));
        assert!(locations.contains("\"line\":0"));

        let references = resolve_request(
            &root,
            &request(
                &root,
                json!({ "operation": "references", "file_path": "src/lib.rs", "line": 0, "character": 3 }),
            ),
        );
        let output = references["resolution"]["output"].as_str().unwrap();
        assert!(output.contains("\"locations\""));
        assert!(output.contains("\"line\":1"));

        let references_without_definition = resolve_request(
            &root,
            &request(
                &root,
                json!({
                    "operation": "references",
                    "file_path": "src/lib.rs",
                    "line": 0,
                    "character": 3,
                    "include_definition": false
                }),
            ),
        );
        let output = references_without_definition["resolution"]["output"]
            .as_str()
            .unwrap();
        assert!(output.contains("\"includeDefinition\":false"));
        assert!(!output.contains("\"line\":0"));

        fs::write(&file, "fn farewell() {}\nfn main() { farewell(); }\n").unwrap();
        let workspace_symbols = resolve_request(
            &root,
            &request(
                &root,
                json!({ "operation": "workspaceSymbols", "query": "farewell" }),
            ),
        );
        let output = workspace_symbols["resolution"]["output"].as_str().unwrap();
        assert!(output.contains("farewell"));
        assert!(!output.contains("greet"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_absolute_and_outside_paths() {
        let root =
            std::env::temp_dir().join(format!("melody-codebase-path-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let absolute = resolve_request(
            &root,
            &request(
                &root,
                json!({ "operation": "documentSymbols", "file_path": "/etc/passwd" }),
            ),
        );
        assert_eq!(
            absolute["resolution"]["error"]["code"],
            "pi.codebase_tool_failed"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bounds_output_without_splitting_utf8() {
        let output = bounded_text("字".repeat(MAX_OUTPUT_BYTES));
        assert!(output.len() <= MAX_OUTPUT_BYTES);
        assert!(output.ends_with("[output truncated]"));
    }
}
