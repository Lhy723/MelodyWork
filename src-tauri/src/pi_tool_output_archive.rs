//! Host-owned bounded output capture and safe archives shared by Pi tools and MCP.

use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

use crate::{config_core::PiTerminalPolicy, workspace_runtime::safe_write_path};

pub(super) const TERMINAL_MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
pub(super) const TERMINAL_ARCHIVE_MAX_BYTES: u64 = 64 * 1024 * 1024;
const TERMINAL_ARCHIVE_MAX_FILES: usize = 32;
const TERMINAL_ARCHIVE_MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
pub(super) const TERMINAL_ARCHIVE_RELATIVE_DIR: &str = ".melody/pi/tool-output";
const TERMINAL_ARCHIVE_FILE_PREFIX: &str = "pi-output-";
pub(crate) const MCP_ARCHIVE_FILE_PREFIX: &str = "mcp-output-";

#[derive(Debug)]
struct ToolOutputArchive {
    relative_path: String,
    file: fs::File,
    bytes_written: u64,
    truncated: bool,
}

#[derive(Debug)]
pub(super) struct TerminalOutputCapture {
    root: PathBuf,
    preview_limit: usize,
    preview: Vec<u8>,
    total_bytes: u64,
    archive: Option<ToolOutputArchive>,
    archive_error: Option<String>,
}

impl TerminalOutputCapture {
    /// Test-only constructor for the default policy; production always builds a
    /// capture from the Host-resolved `PiTerminalPolicy`.

    pub(super) fn with_policy(root: &Path, policy: Option<PiTerminalPolicy>) -> Self {
        let preview_limit = policy
            .map(|policy| policy.output_byte_limit)
            .unwrap_or(TERMINAL_MAX_OUTPUT_BYTES)
            .clamp(1, TERMINAL_MAX_OUTPUT_BYTES);
        Self {
            root: root.to_path_buf(),
            preview_limit,
            preview: Vec::with_capacity(preview_limit.min(64 * 1024)),
            total_bytes: 0,
            archive: None,
            archive_error: None,
        }
    }

    pub(super) fn push(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }

        let preview_capacity = self.preview_limit.saturating_sub(self.preview.len());
        let preview_bytes = preview_capacity.min(bytes.len());
        self.preview.extend_from_slice(&bytes[..preview_bytes]);
        self.total_bytes = self.total_bytes.saturating_add(bytes.len() as u64);

        if self.total_bytes <= self.preview_limit as u64 {
            return;
        }

        let archive_started = self.archive.is_none() && self.archive_error.is_none();
        if archive_started {
            match create_tool_output_archive(&self.root) {
                Ok(mut archive) => {
                    if let Err(error) = archive.file.write_all(&self.preview) {
                        let path = archive.relative_path.clone();
                        self.archive_error =
                            Some(format!("failed to write terminal output archive: {error}"));
                        let _ = fs::remove_file(self.root.join(path));
                    } else {
                        archive.bytes_written = self.preview.len() as u64;
                        self.archive = Some(archive);
                    }
                }
                Err(error) => {
                    self.archive_error = Some(error);
                }
            }
        }

        if let Some(archive) = self.archive.as_mut() {
            // The preview prefix was written when the archive was created;
            // only the overflow portion of this chunk should be appended.
            let overflow = &bytes[preview_bytes..];
            if let Err(error) = append_tool_output_archive(archive, overflow) {
                let path = archive.relative_path.clone();
                self.archive_error = Some(error);
                self.archive = None;
                let _ = fs::remove_file(self.root.join(path));
            }
        }
    }

    pub(super) fn finish(mut self) -> String {
        if let Some(archive) = self.archive.as_mut() {
            if let Err(error) = archive.file.sync_all() {
                let path = archive.relative_path.clone();
                self.archive_error =
                    Some(format!("failed to flush terminal output archive: {error}"));
                self.archive = None;
                let _ = fs::remove_file(self.root.join(path));
            }
        }

        let mut text = String::from_utf8_lossy(&self.preview).into_owned();
        if self.total_bytes <= self.preview_limit as u64 {
            return text;
        }

        let archive_note = match (self.archive.as_ref(), self.archive_error.as_deref()) {
            (Some(archive), _) if archive.truncated => format!(
                "archive contains the first {} of {} bytes at {}",
                archive.bytes_written, self.total_bytes, archive.relative_path
            ),
            (Some(archive), _) => format!(
                "full output ({} bytes) archived at {}",
                self.total_bytes, archive.relative_path
            ),
            (None, Some(error)) => format!(
                "full output ({} bytes) could not be archived: {}",
                self.total_bytes, error
            ),
            (None, None) => format!(
                "full output ({} bytes) could not be archived",
                self.total_bytes
            ),
        };
        text.push_str("\n[output truncated: ");
        text.push_str(&archive_note);
        text.push(']');
        text
    }
}

fn append_tool_output_archive(archive: &mut ToolOutputArchive, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() {
        return Ok(());
    }
    let remaining = TERMINAL_ARCHIVE_MAX_BYTES.saturating_sub(archive.bytes_written);
    let writable = remaining.min(bytes.len() as u64) as usize;
    if writable > 0 {
        archive
            .file
            .write_all(&bytes[..writable])
            .map_err(|error| format!("failed to write terminal output archive: {error}"))?;
        archive.bytes_written += writable as u64;
    }
    if writable < bytes.len() {
        archive.truncated = true;
    }
    Ok(())
}

fn ensure_tool_output_directory(root: &Path) -> Result<PathBuf, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve workspace root: {error}"))?;
    let mut directory = canonical_root.clone();
    for component in [".melody", "pi", "tool-output"] {
        directory.push(component);
        match fs::symlink_metadata(&directory) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(format!(
                        "Refusing to use symbolic link in terminal output archive path: {}",
                        directory.display()
                    ));
                }
                if !metadata.is_dir() {
                    return Err(format!(
                        "Terminal output archive path is not a directory: {}",
                        directory.display()
                    ));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&directory).map_err(|create_error| {
                    format!(
                        "Failed to create terminal output archive directory {}: {create_error}",
                        directory.display()
                    )
                })?;
            }
            Err(error) => {
                return Err(format!(
                    "Failed to inspect terminal output archive directory {}: {error}",
                    directory.display()
                ));
            }
        }
    }

    let canonical_directory = directory
        .canonicalize()
        .map_err(|error| format!("Failed to resolve terminal output archive directory: {error}"))?;
    if !canonical_directory.starts_with(&canonical_root) {
        return Err("Terminal output archive directory is outside the workspace".to_string());
    }
    Ok(canonical_directory)
}

pub(super) fn validate_tool_output_directory(root: &Path) -> Result<PathBuf, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve workspace root: {error}"))?;
    let mut directory = canonical_root.clone();
    for component in [".melody", "pi", "tool-output"] {
        directory.push(component);
        let metadata = fs::symlink_metadata(&directory).map_err(|error| {
            format!(
                "Failed to inspect terminal output archive directory {}: {error}",
                directory.display()
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "Refusing to use symbolic link in terminal output archive path: {}",
                directory.display()
            ));
        }
        if !metadata.is_dir() {
            return Err(format!(
                "Terminal output archive path is not a directory: {}",
                directory.display()
            ));
        }
    }
    let canonical_directory = directory
        .canonicalize()
        .map_err(|error| format!("Failed to resolve terminal output archive directory: {error}"))?;
    if !canonical_directory.starts_with(&canonical_root) {
        return Err("Terminal output archive directory is outside the workspace".to_string());
    }
    Ok(canonical_directory)
}

fn prune_tool_output_archives(directory: &Path) -> Result<(), String> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("Failed to read terminal output archive directory: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Failed to inspect terminal output archive: {error}"))?;
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|error| format!("Failed to read terminal output archive metadata: {error}"))?;
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if !metadata.is_file() || !is_tool_output_archive_name(&file_name) {
            continue;
        }
        let modified = metadata
            .modified()
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        entries.push((modified, metadata.len(), entry.path()));
    }
    entries.sort_by_key(|(modified, _, _)| *modified);

    let mut total_bytes = entries.iter().map(|(_, size, _)| *size).sum::<u64>();
    while entries.len() >= TERMINAL_ARCHIVE_MAX_FILES
        || total_bytes.saturating_add(TERMINAL_ARCHIVE_MAX_BYTES) > TERMINAL_ARCHIVE_MAX_TOTAL_BYTES
    {
        let Some((_, size, path)) = entries.first().cloned() else {
            break;
        };
        fs::remove_file(&path).map_err(|error| {
            format!(
                "Failed to prune terminal output archive {}: {error}",
                path.display()
            )
        })?;
        entries.remove(0);
        total_bytes = total_bytes.saturating_sub(size);
    }
    if entries.len() >= TERMINAL_ARCHIVE_MAX_FILES
        || total_bytes.saturating_add(TERMINAL_ARCHIVE_MAX_BYTES) > TERMINAL_ARCHIVE_MAX_TOTAL_BYTES
    {
        return Err("Terminal output archive retention limit has been reached".to_string());
    }
    Ok(())
}

fn create_tool_output_archive(root: &Path) -> Result<ToolOutputArchive, String> {
    create_tool_output_archive_with_prefix(root, TERMINAL_ARCHIVE_FILE_PREFIX)
}

pub(super) fn is_tool_output_archive_name(file_name: &str) -> bool {
    (file_name.starts_with(TERMINAL_ARCHIVE_FILE_PREFIX)
        || file_name.starts_with(MCP_ARCHIVE_FILE_PREFIX))
        && file_name.ends_with(".log")
}

fn create_tool_output_archive_with_prefix(
    root: &Path,
    prefix: &str,
) -> Result<ToolOutputArchive, String> {
    if !matches!(
        prefix,
        TERMINAL_ARCHIVE_FILE_PREFIX | MCP_ARCHIVE_FILE_PREFIX
    ) {
        return Err("Unknown terminal output archive prefix".to_string());
    }
    let directory = ensure_tool_output_directory(root)?;
    prune_tool_output_archives(&directory)?;
    let file_name = format!("{}{}.log", prefix, uuid::Uuid::new_v4().simple());
    let relative_path = format!("{TERMINAL_ARCHIVE_RELATIVE_DIR}/{file_name}");
    let path = safe_write_path(root, &relative_path)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW).mode(0o600);
    }
    let file = options
        .open(&path)
        .map_err(|error| format!("Failed to create terminal output archive: {error}"))?;
    Ok(ToolOutputArchive {
        relative_path,
        file,
        bytes_written: 0,
        truncated: false,
    })
}

pub(crate) fn archive_tool_output(
    root: &Path,
    bytes: &[u8],
    prefix: &str,
) -> Result<(String, u64, bool), String> {
    let mut archive = create_tool_output_archive_with_prefix(root, prefix)?;
    if let Err(error) = append_tool_output_archive(&mut archive, bytes) {
        let path = archive.relative_path.clone();
        drop(archive);
        let _ = fs::remove_file(root.join(&path));
        return Err(error);
    }
    if let Err(error) = archive.file.sync_all() {
        let path = archive.relative_path.clone();
        drop(archive);
        let _ = fs::remove_file(root.join(&path));
        return Err(format!("failed to flush terminal output archive: {error}"));
    }
    Ok((
        archive.relative_path,
        archive.bytes_written,
        archive.truncated,
    ))
}
