//! Host-owned Skill Markdown details and path policy.
//!
//! `config_extensions` keeps workspace authorization and catalog membership
//! checks at the command seam; this module owns the bounded file projection
//! and the allowed-root policy shared by Settings and the resource catalog.

use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::config_core::{MAX_CONFIG_BYTES, SkillDetails, melody_home};

fn skill_frontmatter_value(content: &str, key: &str) -> Option<String> {
    let normalized = content.replace("\r\n", "\n");
    let frontmatter = normalized.strip_prefix("---\n")?.split_once("\n---\n")?.0;
    frontmatter.lines().find_map(|line| {
        let (candidate, value) = line.split_once(':')?;
        if candidate.trim() != key {
            return None;
        }
        let value = value.trim();
        if value.is_empty() || matches!(value, "|" | ">") {
            return None;
        }
        Some(
            value
                .trim_matches(|character| character == '"' || character == '\'')
                .to_string(),
        )
    })
}

pub(crate) fn skill_description_from_directory(root: &Path) -> Option<String> {
    let skill_path = root.join("SKILL.md");
    let metadata = fs::symlink_metadata(&skill_path).ok()?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_CONFIG_BYTES {
        return None;
    }
    let content = fs::read_to_string(skill_path).ok()?;
    skill_frontmatter_value(&content, "description")
}

fn collect_skill_files(root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((directory, depth)) = stack.pop() {
        if depth > 6 || files.len() >= 256 {
            continue;
        }
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                stack.push((path, depth + 1));
            } else if file_type.is_file()
                && let Ok(relative) = path.strip_prefix(root)
            {
                files.push(relative.to_string_lossy().into_owned());
            }
        }
    }
    files.sort();
    files.truncate(256);
    files
}

pub(crate) fn skill_details_from_directory(
    root: &Path,
    expected_name: &str,
) -> Result<SkillDetails, String> {
    let skill_path = root.join("SKILL.md");
    let metadata = skill_path
        .metadata()
        .map_err(|error| format!("Skill definition is unavailable: {error}"))?;
    if !metadata.is_file() {
        return Err("Skill directory does not contain SKILL.md".to_string());
    }
    if metadata.len() > MAX_CONFIG_BYTES {
        return Err("SKILL.md is larger than the 1 MB details limit".to_string());
    }
    let content = fs::read_to_string(&skill_path)
        .map_err(|error| format!("SKILL.md is not valid UTF-8 text: {error}"))?;
    Ok(SkillDetails {
        name: skill_frontmatter_value(&content, "name")
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| expected_name.to_string()),
        description: skill_frontmatter_value(&content, "description"),
        license: skill_frontmatter_value(&content, "license"),
        compatibility: skill_frontmatter_value(&content, "compatibility"),
        path: root.to_string_lossy().into_owned(),
        skill_path: skill_path.to_string_lossy().into_owned(),
        files: collect_skill_files(root),
        content,
    })
}

fn allowed_skill_path_in_roots(path: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Skill path is unavailable: {error}"))?;
    let parent = canonical
        .parent()
        .ok_or_else(|| "Skill path has no parent directory".to_string())?;
    let allowed = roots.iter().any(|root| {
        root.canonicalize()
            .ok()
            .is_some_and(|root| parent == root && canonical.starts_with(root))
    });
    if !allowed {
        return Err("Skill path is outside the allowed Melody skill directories".to_string());
    }
    let skill_file = canonical.join("SKILL.md");
    if !fs::symlink_metadata(&skill_file)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false)
    {
        return Err("Skill directory does not contain SKILL.md".to_string());
    }
    Ok(canonical)
}

pub(crate) fn allowed_skill_path(cwd: &str, path: &Path) -> Result<PathBuf, String> {
    let workspace = PathBuf::from(cwd)
        .canonicalize()
        .map_err(|error| format!("Workspace is unavailable: {error}"))?;
    allowed_skill_path_in_roots(
        path,
        &[
            melody_home()?.join("skills"),
            workspace.join(".melody/skills"),
        ],
    )
}
