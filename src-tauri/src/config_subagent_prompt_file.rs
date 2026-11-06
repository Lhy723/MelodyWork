//! Host-owned resolution and bounded loading of subagent prompt files.
//!
//! Inline/file instruction precedence and policy projection remain in the
//! parent configuration owner; this module only turns a relative reference
//! into validated prompt text.

use std::{fs, path::Path};

use serde_json::Value;

use super::subagent_markdown::{MAX_FILE_BYTES, MAX_TEXT_BYTES, bounded_text};

const MAX_PROMPT_REFERENCE_BYTES: usize = 4_096;

pub(super) fn read_prompt_file(base: &Path, raw: Option<&Value>) -> Option<String> {
    let reference = bounded_text(raw, MAX_PROMPT_REFERENCE_BYTES)?;
    let path = Path::new(&reference);
    if path.is_absolute() || reference.contains('\0') {
        return None;
    }
    let candidate = base.join(path);
    let canonical_base = base.canonicalize().ok()?;
    let canonical_candidate = candidate.canonicalize().ok()?;
    if canonical_candidate != canonical_base && !canonical_candidate.starts_with(&canonical_base) {
        return None;
    }
    let metadata = fs::symlink_metadata(&canonical_candidate).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return None;
    }
    let content = fs::read_to_string(canonical_candidate).ok()?;
    if content.len() > MAX_TEXT_BYTES
        || content
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t' && c != '\r')
    {
        return None;
    }
    Some(content.trim().to_string())
}
