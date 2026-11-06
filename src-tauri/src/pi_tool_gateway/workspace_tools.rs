use std::{
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use ignore::WalkBuilder;
use serde_json::Value;

use super::{GITIGNORED_ERROR_PREFIX, workspace_paths::relative_path};
use crate::pi_tool_output_archive::{
    TERMINAL_ARCHIVE_MAX_BYTES, TERMINAL_ARCHIVE_RELATIVE_DIR, is_tool_output_archive_name,
    validate_tool_output_directory,
};
use crate::workspace_runtime::{is_ignored_directory, safe_write_path};

mod patch;

pub(super) use patch::apply_patch;

const READ_FILE_MAX_BYTES: u64 = 2 * 1024 * 1024;
const TOOL_OUTPUT_READ_MAX_BYTES: u64 = 1024 * 1024;
const TOOL_OUTPUT_READ_DEFAULT_BYTES: u64 = 256 * 1024;
const READ_FILE_DEFAULT_LINES: usize = 400;
const READ_FILE_MAX_LINES: usize = 10_000;
const SEARCH_MAX_QUERY_BYTES: usize = 256;
const SEARCH_MAX_RESULTS: usize = 100;
const SEARCH_MAX_OUTPUT_BYTES: usize = 256 * 1024;
const SEARCH_MAX_FILES: usize = 4_000;
const LIST_DIRECTORY_MAX_ENTRIES: usize = 2_000;
const LIST_DIRECTORY_MAX_DEPTH: usize = 8;
const LIST_DIRECTORY_MAX_OUTPUT_BYTES: usize = 256 * 1024;
const WRITE_FILE_MAX_BYTES: usize = 2 * 1024 * 1024;

fn safe_existing_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let candidate = root.join(relative);
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("Failed to resolve {relative}: {error}"))?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve workspace root: {error}"))?;
    if !canonical.starts_with(&canonical_root) {
        return Err("Path is outside the authorized workspace".to_string());
    }
    Ok(canonical)
}

fn respect_gitignore(arguments: &serde_json::Map<String, Value>) -> Result<bool, String> {
    arguments
        .get("respectGitignore")
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "respectGitignore must be a boolean".to_string())
        })
        .transpose()
        .map(|value| value.unwrap_or(false))
}

fn gitignore_walk_builder(path: &Path, respect: bool) -> WalkBuilder {
    let mut builder = WalkBuilder::new(path);
    builder
        // Melody's current search/list tools still show dot-files unless the
        // caller explicitly asks the directory tool to hide them. Keep that
        // behavior while delegating the actual ignore matching to the same
        // crate Pi uses for its native file tools.
        .hidden(false)
        .parents(true)
        .ignore(respect)
        .git_ignore(respect)
        .git_global(respect)
        .git_exclude(respect)
        .require_git(false)
        .follow_links(false);
    builder
}

fn gitignored_path(root: &Path, path: &Path) -> bool {
    // Walk the target's parent rather than passing the target itself as the
    // explicit walk root. An explicit root is always yielded by `ignore`,
    // even when its own name matches a pattern, which would make direct
    // reads of an ignored file look allowed. Walking one level below the
    // parent preserves nested/parent `.gitignore` rules without scanning the
    // complete workspace. A missing target cannot be classified reliably (for
    // example when an add-file patch creates it), so callers use this helper
    // for existing read/edit/delete targets only.
    let parent = path.parent().unwrap_or(root);
    let mut walker = gitignore_walk_builder(parent, true);
    walker.max_depth(Some(1));
    let target = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    for entry in walker.build() {
        if let Ok(entry) = entry {
            let candidate = entry
                .path()
                .canonicalize()
                .unwrap_or_else(|_| entry.path().to_path_buf());
            if entry.depth() == 1 && candidate == target && candidate.starts_with(&canonical_root) {
                return false;
            }
        }
    }
    true
}

fn gitignored_error(relative: &str) -> String {
    format!("{GITIGNORED_ERROR_PREFIX}{relative} is ignored by .gitignore")
}

pub(super) fn read_file(root: &Path, arguments: &Value) -> Result<String, String> {
    let arguments = arguments
        .as_object()
        .ok_or_else(|| "workspace_read_file arguments must be an object".to_string())?;
    let relative = relative_path(arguments.get("path"), "path")?;
    let path = safe_existing_path(root, &relative)?;
    if respect_gitignore(arguments)? && gitignored_path(root, &path) {
        return Err(gitignored_error(&relative));
    }
    let metadata = path
        .metadata()
        .map_err(|error| format!("Failed to read file metadata: {error}"))?;
    if !metadata.is_file() {
        return Err("The requested workspace path is not a file".to_string());
    }
    if metadata.len() > READ_FILE_MAX_BYTES {
        return Err("The requested file is larger than the 2 MB read limit".to_string());
    }
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("File is not valid UTF-8 text: {error}"))?;
    let offset = arguments.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(READ_FILE_DEFAULT_LINES)
        .min(READ_FILE_MAX_LINES);
    if limit == 0 {
        return Err("limit must be greater than zero".to_string());
    }
    let mut output = String::new();
    for line in content.lines().skip(offset).take(limit) {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(line);
        if output.len() > SEARCH_MAX_OUTPUT_BYTES {
            output.truncate(SEARCH_MAX_OUTPUT_BYTES);
            output.push_str("\n[output truncated]");
            break;
        }
    }
    Ok(output)
}

pub(super) fn read_tool_output(root: &Path, arguments: &Value) -> Result<String, String> {
    let arguments = arguments
        .as_object()
        .ok_or_else(|| "workspace_read_tool_output arguments must be an object".to_string())?;
    let relative = relative_path(arguments.get("path"), "path")?;
    let normalized = relative.replace('\\', "/");
    let archive_prefix = format!("{TERMINAL_ARCHIVE_RELATIVE_DIR}/");
    let file_name = normalized
        .strip_prefix(&archive_prefix)
        .filter(|name| !name.is_empty() && !name.contains('/'))
        .ok_or_else(|| "path must reference a Melody terminal output archive".to_string())?;
    if !is_tool_output_archive_name(file_name) {
        return Err("path must reference a Melody terminal output archive".to_string());
    }

    let candidate = root.join(&relative);
    if fs::symlink_metadata(&candidate)
        .map_err(|error| format!("Failed to inspect terminal output archive: {error}"))?
        .file_type()
        .is_symlink()
    {
        return Err("Refusing to read a symbolic link as a terminal output archive".to_string());
    }
    let path = safe_existing_path(root, &relative)?;
    let archive_directory = validate_tool_output_directory(root)?;
    if path.parent() != Some(archive_directory.as_path()) {
        return Err("Terminal output archive path is not inside the archive directory".to_string());
    }
    let metadata = path
        .metadata()
        .map_err(|error| format!("Failed to read terminal output archive metadata: {error}"))?;
    if !metadata.is_file() || metadata.len() > TERMINAL_ARCHIVE_MAX_BYTES {
        return Err(
            "The terminal output archive is invalid or exceeds the archive limit".to_string(),
        );
    }

    let offset = arguments.get("offset").and_then(Value::as_u64).unwrap_or(0);
    if offset > metadata.len() {
        return Err("offset is past the end of the terminal output archive".to_string());
    }
    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(TOOL_OUTPUT_READ_DEFAULT_BYTES)
        .min(TOOL_OUTPUT_READ_MAX_BYTES);
    if limit == 0 {
        return Err("limit must be greater than zero".to_string());
    }

    let bytes_to_read = limit.min(metadata.len().saturating_sub(offset));
    let mut file = fs::File::open(&path)
        .map_err(|error| format!("Failed to open terminal output archive: {error}"))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("Failed to seek terminal output archive: {error}"))?;
    let mut bytes = vec![0_u8; bytes_to_read as usize];
    file.read_exact(&mut bytes)
        .map_err(|error| format!("Failed to read terminal output archive: {error}"))?;
    let end = offset.saturating_add(bytes_to_read);
    let mut output = String::from_utf8_lossy(&bytes).into_owned();
    if end < metadata.len() {
        output.push_str(&format!(
            "\n[archive chunk: offset={} bytes_read={} total={} use offset={} to continue]",
            offset,
            bytes_to_read,
            metadata.len(),
            end
        ));
    }
    Ok(output)
}

fn search_file(
    root: &Path,
    path: &Path,
    query: &str,
    results: &mut Vec<String>,
    output_bytes: &mut usize,
    files_seen: &mut usize,
) {
    if results.len() >= SEARCH_MAX_RESULTS || *files_seen >= SEARCH_MAX_FILES {
        return;
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return,
    };
    if metadata.file_type().is_symlink() {
        return;
    }
    if metadata.is_dir() {
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if path != root && is_ignored_directory(name) {
            return;
        }
        let Ok(entries) = fs::read_dir(path) else {
            return;
        };
        let mut children = entries.filter_map(Result::ok).collect::<Vec<_>>();
        children.sort_by_key(|entry| entry.file_name());
        for entry in children {
            search_file(
                root,
                &entry.path(),
                query,
                results,
                output_bytes,
                files_seen,
            );
            if results.len() >= SEARCH_MAX_RESULTS || *files_seen >= SEARCH_MAX_FILES {
                break;
            }
        }
        return;
    }
    if !metadata.is_file() || metadata.len() > READ_FILE_MAX_BYTES {
        return;
    }
    *files_seen += 1;
    let Ok(content) = fs::read_to_string(path) else {
        return;
    };
    for (line_number, line) in content.lines().enumerate() {
        if !line.contains(query) {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        let result = format!("{relative}:{}: {line}", line_number + 1);
        let result_bytes = result.len() + usize::from(!results.is_empty());
        if *output_bytes + result_bytes > SEARCH_MAX_OUTPUT_BYTES {
            return;
        }
        *output_bytes += result_bytes;
        results.push(result);
        if results.len() >= SEARCH_MAX_RESULTS {
            return;
        }
    }
}

fn search_file_with_gitignore(
    root: &Path,
    path: &Path,
    query: &str,
    results: &mut Vec<String>,
    output_bytes: &mut usize,
    files_seen: &mut usize,
) {
    if results.len() >= SEARCH_MAX_RESULTS || *files_seen >= SEARCH_MAX_FILES {
        return;
    }
    let mut files = Vec::new();
    let root_for_filter = root.to_path_buf();
    let mut walker = gitignore_walk_builder(path, true)
        .filter_entry(move |entry| {
            if entry.path() == root_for_filter {
                return true;
            }
            entry.file_type().is_none_or(|file_type| {
                !file_type.is_dir() || !is_ignored_directory(&entry.file_name().to_string_lossy())
            })
        })
        .build();
    while let Some(entry) = walker.next() {
        let Ok(entry) = entry else { continue };
        let Some(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() || file_type.is_symlink() {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.len() > READ_FILE_MAX_BYTES {
            continue;
        }
        files.push(entry.into_path());
        if files.len() >= SEARCH_MAX_FILES {
            break;
        }
    }
    files.sort_by(|left, right| {
        let left = left.strip_prefix(root).unwrap_or(left).to_string_lossy();
        let right = right.strip_prefix(root).unwrap_or(right).to_string_lossy();
        left.to_ascii_lowercase()
            .cmp(&right.to_ascii_lowercase())
            .then_with(|| left.cmp(&right))
    });
    for path in files {
        if results.len() >= SEARCH_MAX_RESULTS || *files_seen >= SEARCH_MAX_FILES {
            break;
        }
        *files_seen += 1;
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        for (line_number, line) in content.lines().enumerate() {
            if !line.contains(query) {
                continue;
            }
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let result = format!("{relative}:{}: {line}", line_number + 1);
            let result_bytes = result.len() + usize::from(!results.is_empty());
            if *output_bytes + result_bytes > SEARCH_MAX_OUTPUT_BYTES {
                return;
            }
            *output_bytes += result_bytes;
            results.push(result);
            if results.len() >= SEARCH_MAX_RESULTS {
                return;
            }
        }
    }
}

pub(super) fn search(root: &Path, arguments: &Value) -> Result<String, String> {
    let arguments = arguments
        .as_object()
        .ok_or_else(|| "workspace_search arguments must be an object".to_string())?;
    let query = arguments
        .get("query")
        .and_then(Value::as_str)
        .ok_or_else(|| "query must be a string".to_string())?;
    if query.is_empty() {
        return Err("query must not be empty".to_string());
    }
    if query.len() > SEARCH_MAX_QUERY_BYTES {
        return Err("query is larger than the 256 byte limit".to_string());
    }
    let respect = respect_gitignore(arguments)?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve workspace root: {error}"))?;
    let path = match arguments.get("path") {
        Some(value) => safe_existing_path(&canonical_root, &relative_path(Some(value), "path")?)?,
        None => canonical_root.clone(),
    };
    let mut results = Vec::new();
    let mut output_bytes = 0;
    let mut files_seen = 0;
    if respect {
        search_file_with_gitignore(
            &canonical_root,
            &path,
            query,
            &mut results,
            &mut output_bytes,
            &mut files_seen,
        );
    } else {
        search_file(
            &canonical_root,
            &path,
            query,
            &mut results,
            &mut output_bytes,
            &mut files_seen,
        );
    }
    if results.is_empty() {
        return Ok("No matches found".to_string());
    }
    Ok(results.join("\n"))
}

const LIST_DIRECTORY_TRUNCATED_NOTICE: &str =
    "\n[output truncated; narrow the path or lower the requested depth]";

fn display_relative_directory(relative: &str) -> String {
    let normalized = relative.replace('\\', "/");
    let trimmed = normalized.trim().trim_start_matches("./");
    if trimmed.is_empty() || trimmed == "." {
        ".".to_string()
    } else {
        trimmed.trim_end_matches('/').to_string()
    }
}

fn list_directory_entries(
    directory: &Path,
    depth: usize,
    max_depth: usize,
    include_hidden: bool,
    output: &mut String,
    entries_seen: &mut usize,
    truncated: &mut bool,
) -> Result<(), String> {
    if *truncated || depth > max_depth {
        return Ok(());
    }

    let mut children = fs::read_dir(directory)
        .map_err(|error| format!("Failed to read directory: {error}"))?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    children.sort_by(|left, right| {
        let left_name = left.file_name().to_string_lossy().into_owned();
        let right_name = right.file_name().to_string_lossy().into_owned();
        left_name
            .to_ascii_lowercase()
            .cmp(&right_name.to_ascii_lowercase())
            .then_with(|| left_name.cmp(&right_name))
    });

    for child in children {
        if *entries_seen >= LIST_DIRECTORY_MAX_ENTRIES {
            *truncated = true;
            break;
        }
        let path = child.path();
        let file_type = child
            .file_type()
            .map_err(|error| format!("Failed to inspect directory entry: {error}"))?;
        // Directory listings must not traverse links. This mirrors the
        // workspace tree and prevents a symlink from turning a read request
        // into an ambient filesystem walk.
        if file_type.is_symlink() {
            continue;
        }
        let name = child.file_name().to_string_lossy().into_owned();
        if !include_hidden && name.starts_with('.') {
            continue;
        }
        let is_directory = file_type.is_dir();
        if is_directory && is_ignored_directory(&name) {
            continue;
        }

        let mut line = "  ".repeat(depth + 1);
        line.push_str("- ");
        line.push_str(&name);
        if is_directory {
            line.push('/');
        }
        line.push('\n');
        if output
            .len()
            .saturating_add(line.len())
            .saturating_add(LIST_DIRECTORY_TRUNCATED_NOTICE.len())
            > LIST_DIRECTORY_MAX_OUTPUT_BYTES
        {
            *truncated = true;
            break;
        }
        output.push_str(&line);
        *entries_seen += 1;

        if is_directory && depth < max_depth {
            list_directory_entries(
                &path,
                depth + 1,
                max_depth,
                include_hidden,
                output,
                entries_seen,
                truncated,
            )?;
            if *truncated {
                break;
            }
        }
    }
    Ok(())
}

fn list_directory_entries_with_gitignore(
    root: &Path,
    directory: &Path,
    max_depth: usize,
    include_hidden: bool,
    output: &mut String,
    entries_seen: &mut usize,
    truncated: &mut bool,
) -> Result<(), String> {
    let mut entries = Vec::new();
    let directory_for_filter = directory.to_path_buf();
    let mut walker = gitignore_walk_builder(directory, true)
        .hidden(!include_hidden)
        .max_depth(Some(max_depth.saturating_add(1)))
        .filter_entry(move |entry| {
            if entry.path() == directory_for_filter {
                return true;
            }
            entry.file_type().is_none_or(|file_type| {
                !file_type.is_dir() || !is_ignored_directory(&entry.file_name().to_string_lossy())
            })
        })
        .build();
    while let Some(entry) = walker.next() {
        let entry = entry.map_err(|error| format!("Failed to walk directory: {error}"))?;
        if entry.depth() == 0 {
            continue;
        }
        let Some(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        entries.push((entry.into_path(), file_type.is_dir()));
        if entries.len() > LIST_DIRECTORY_MAX_ENTRIES {
            *truncated = true;
            break;
        }
    }
    entries.sort_by(|(left, _), (right, _)| {
        let left = left
            .strip_prefix(directory)
            .unwrap_or(left)
            .to_string_lossy();
        let right = right
            .strip_prefix(directory)
            .unwrap_or(right)
            .to_string_lossy();
        left.to_ascii_lowercase()
            .cmp(&right.to_ascii_lowercase())
            .then_with(|| left.cmp(&right))
    });
    for (path, is_directory) in entries {
        if *entries_seen >= LIST_DIRECTORY_MAX_ENTRIES {
            *truncated = true;
            break;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let depth = path
            .strip_prefix(directory)
            .ok()
            .map(|relative| relative.components().count())
            .unwrap_or(1);
        let mut line = "  ".repeat(depth);
        line.push_str("- ");
        line.push_str(name);
        if is_directory {
            line.push('/');
        }
        line.push('\n');
        if output
            .len()
            .saturating_add(line.len())
            .saturating_add(LIST_DIRECTORY_TRUNCATED_NOTICE.len())
            > LIST_DIRECTORY_MAX_OUTPUT_BYTES
        {
            *truncated = true;
            break;
        }
        output.push_str(&line);
        *entries_seen += 1;
    }
    // `root` is retained in the signature to keep the generated-directory
    // and relative-path policy explicit at this boundary, even though the
    // walker itself starts at the requested directory.
    let _ = root;
    Ok(())
}

pub(super) fn list_directory(root: &Path, arguments: &Value) -> Result<String, String> {
    let arguments = arguments
        .as_object()
        .ok_or_else(|| "workspace_list_directory arguments must be an object".to_string())?;
    let relative = relative_path(arguments.get("path"), "path")?;
    let candidate = root.join(&relative);
    let link_metadata = fs::symlink_metadata(&candidate)
        .map_err(|error| format!("Failed to inspect directory: {error}"))?;
    if link_metadata.file_type().is_symlink() {
        return Err("Refusing to list a symbolic link as a directory".to_string());
    }
    let path = safe_existing_path(root, &relative)?;
    let metadata = path
        .metadata()
        .map_err(|error| format!("Failed to read directory metadata: {error}"))?;
    if !metadata.is_dir() {
        return Err("The requested workspace path is not a directory".to_string());
    }

    let max_depth = arguments
        .get("depth")
        .map(|value| {
            value
                .as_u64()
                .ok_or_else(|| "depth must be an integer".to_string())
                .map(|depth| (depth as usize).min(LIST_DIRECTORY_MAX_DEPTH))
        })
        .transpose()?
        .unwrap_or(LIST_DIRECTORY_MAX_DEPTH);
    let include_hidden = arguments
        .get("includeHidden")
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| "includeHidden must be a boolean".to_string())
        })
        .transpose()?
        .unwrap_or(false);
    let respect = respect_gitignore(arguments)?;

    let mut output = format!("- {}/\n", display_relative_directory(&relative));
    let mut entries_seen = 0;
    let mut truncated = false;
    if respect {
        list_directory_entries_with_gitignore(
            root,
            &path,
            max_depth,
            include_hidden,
            &mut output,
            &mut entries_seen,
            &mut truncated,
        )?;
    } else {
        list_directory_entries(
            &path,
            0,
            max_depth,
            include_hidden,
            &mut output,
            &mut entries_seen,
            &mut truncated,
        )?;
    }
    if entries_seen == 0 && !truncated {
        output.push_str("  (empty)\n");
    }
    if truncated {
        output.push_str(LIST_DIRECTORY_TRUNCATED_NOTICE);
    }
    Ok(output.trim_end().to_string())
}

fn write_no_follow(path: &Path, content: &str) -> Result<(), String> {
    if content.len() > WRITE_FILE_MAX_BYTES {
        return Err("File content is larger than the 2 MB write limit".to_string());
    }
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("Failed to open file for writing: {error}"))?;
    file.write_all(content.as_bytes())
        .map_err(|error| format!("Failed to write file: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Failed to flush file: {error}"))
}

pub(super) fn write_file(root: &Path, arguments: &Value) -> Result<String, String> {
    let arguments = arguments
        .as_object()
        .ok_or_else(|| "workspace_write_file arguments must be an object".to_string())?;
    let relative = relative_path(arguments.get("path"), "path")?;
    let content = arguments
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| "content must be a string".to_string())?;
    let path = safe_write_path(root, &relative)?;
    write_no_follow(&path, content)?;
    Ok(format!("Wrote {} ({} bytes)", relative, content.len()))
}

pub(super) fn edit_file(root: &Path, arguments: &Value) -> Result<String, String> {
    let arguments = arguments
        .as_object()
        .ok_or_else(|| "workspace_edit arguments must be an object".to_string())?;
    let relative = relative_path(arguments.get("path"), "path")?;
    let old_text = arguments
        .get("oldText")
        .and_then(Value::as_str)
        .ok_or_else(|| "oldText must be a string".to_string())?;
    if old_text.is_empty() {
        return Err("oldText must not be empty".to_string());
    }
    let new_text = arguments
        .get("newText")
        .and_then(Value::as_str)
        .ok_or_else(|| "newText must be a string".to_string())?;
    // Mutation targets must not resolve through a workspace symlink. Read
    // access may safely follow an in-workspace link, but edit/delete/patch
    // must reject the link itself instead of mutating its target.
    let path = safe_write_path(root, &relative)?;
    if respect_gitignore(arguments)? && gitignored_path(root, &path) {
        return Err(gitignored_error(&relative));
    }
    let metadata = path.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > READ_FILE_MAX_BYTES {
        return Err("The edit target is not a bounded text file".to_string());
    }
    let original = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let replace_all = arguments
        .get("replaceAll")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let occurrences = original.matches(old_text).count();
    if occurrences == 0 {
        return Err("oldText was not found in the target file".to_string());
    }
    if occurrences > 1 && !replace_all {
        return Err(
            "oldText matched more than once; set replaceAll to edit all matches".to_string(),
        );
    }
    let updated = if replace_all {
        original.replace(old_text, new_text)
    } else {
        original.replacen(old_text, new_text, 1)
    };
    if updated.len() > WRITE_FILE_MAX_BYTES {
        return Err("Edited file is larger than the 2 MB write limit".to_string());
    }
    write_no_follow(&path, &updated)?;
    Ok(format!(
        "Edited {} ({} replacement{})",
        relative,
        occurrences,
        if occurrences == 1 { "" } else { "s" }
    ))
}
