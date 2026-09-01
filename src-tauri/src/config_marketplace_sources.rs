use std::path::{Path, PathBuf};

use tauri::AppHandle;
use toml_edit::{ArrayOfTables, DocumentMut, Item, Table};

use crate::config_io::TextFileStore;
use crate::workspace_access::confirm_action;

use super::super::config_core::*;

pub(crate) fn read_user_config_document() -> Result<(PathBuf, DocumentMut), String> {
    let path = melody_home()?.join("config.toml");
    let content =
        TextFileStore::with_limit_description(&path, MAX_CONFIG_BYTES, "the 1 MB editor limit")
            .read_text("Melody config")?
            .unwrap_or_default();
    let document = if content.trim().is_empty() {
        DocumentMut::new()
    } else {
        content
            .parse::<DocumentMut>()
            .map_err(|error| format!("Melody config contains invalid TOML: {error}"))?
    };
    Ok((path, document))
}

pub(crate) fn marketplace_sources(
    document: &DocumentMut,
) -> Result<Vec<MarketplaceSource>, String> {
    let Some(marketplace) = document.get("marketplace") else {
        return Ok(Vec::new());
    };
    let marketplace = marketplace
        .as_table()
        .ok_or_else(|| "[marketplace] must be a table".to_string())?;
    let Some(sources) = marketplace.get("sources") else {
        return Ok(Vec::new());
    };
    let sources = sources
        .as_array_of_tables()
        .ok_or_else(|| "[[marketplace.sources]] must be an array of tables".to_string())?;
    Ok(sources
        .iter()
        .filter_map(|entry| {
            let name = entry.get("name")?.as_str()?.to_string();
            if let Some(location) = entry.get("git").and_then(Item::as_str) {
                Some(MarketplaceSource {
                    name,
                    kind: "git".to_string(),
                    location: location.to_string(),
                    branch: entry
                        .get("branch")
                        .and_then(Item::as_str)
                        .map(str::to_string),
                })
            } else {
                entry
                    .get("path")
                    .and_then(Item::as_str)
                    .map(|location| MarketplaceSource {
                        name,
                        kind: "local".to_string(),
                        location: location.to_string(),
                        branch: None,
                    })
            }
        })
        .collect())
}

pub(crate) fn marketplace_sources_mut(
    document: &mut DocumentMut,
) -> Result<&mut ArrayOfTables, String> {
    let marketplace = document
        .entry("marketplace")
        .or_insert_with(|| Item::Table(Table::new()))
        .as_table_mut()
        .ok_or_else(|| "[marketplace] must be a table".to_string())?;
    marketplace
        .entry("sources")
        .or_insert_with(|| Item::ArrayOfTables(ArrayOfTables::new()))
        .as_array_of_tables_mut()
        .ok_or_else(|| "[[marketplace.sources]] must be an array of tables".to_string())
}

fn write_user_config(path: &Path, document: &DocumentMut) -> Result<(), String> {
    let content = document.to_string();
    TextFileStore::with_limit_description(path, MAX_CONFIG_BYTES, "the 1 MB editor limit")
        .write_text(&content, "Melody config")
}

fn validate_marketplace_source(source: &mut MarketplaceSource) -> Result<(), String> {
    source.name = source.name.trim().to_string();
    source.location = source.location.trim().to_string();
    source.branch = source
        .branch
        .take()
        .map(|branch| branch.trim().to_string())
        .filter(|branch| !branch.is_empty());
    if source.name.is_empty() {
        return Err("Marketplace name cannot be empty".to_string());
    }
    if source.location.is_empty() {
        return Err("Marketplace source cannot be empty".to_string());
    }
    if source.kind != "git" && source.kind != "local" {
        return Err("Marketplace kind must be git or local".to_string());
    }
    if source.kind == "local" {
        source.branch = None;
    }
    Ok(())
}

pub(crate) fn marketplace_source_from_input(input: &str) -> Result<MarketplaceSource, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("Marketplace link or path cannot be empty".to_string());
    }

    let windows_path = input
        .as_bytes()
        .get(1)
        .is_some_and(|separator| *separator == b':');
    let local = input.starts_with('/')
        || input.starts_with("./")
        || input.starts_with("../")
        || input.starts_with("~/")
        || input.starts_with('\\')
        || windows_path;

    let mut branch = None;
    let location = if local {
        input.to_string()
    } else if !input.contains("://")
        && !input.starts_with("git@")
        && input.matches('/').count() == 1
    {
        let (repository, parsed_branch) = input
            .rsplit_once('@')
            .map_or((input, None), |(repository, branch)| {
                (repository, (!branch.is_empty()).then_some(branch))
            });
        branch = parsed_branch.map(str::to_string);
        format!(
            "https://github.com/{}.git",
            repository.trim_end_matches(".git")
        )
    } else {
        input.to_string()
    };

    let name = location
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .rsplit(['/', '\\', ':'])
        .next()
        .unwrap_or_default()
        .trim()
        .to_string();
    if name.is_empty() {
        return Err("Could not infer a Marketplace name from this source".to_string());
    }

    Ok(MarketplaceSource {
        name,
        kind: if local { "local" } else { "git" }.to_string(),
        location,
        branch,
    })
}

#[tauri::command]
pub fn list_marketplace_sources() -> Result<Vec<MarketplaceSource>, String> {
    let (_, document) = read_user_config_document()?;
    marketplace_sources(&document)
}

#[tauri::command]
pub async fn add_marketplace_source(
    app: AppHandle,
    input: String,
) -> Result<Vec<MarketplaceSource>, String> {
    let source = marketplace_source_from_input(&input)?;
    confirm_action(
        &app,
        "确认添加 Marketplace",
        format!("允许将以下来源写入 Melody 配置吗？\n{}", source.location),
    )
    .await?;
    save_marketplace_source_inner(None, source)
}

#[tauri::command]
pub async fn save_marketplace_source(
    app: AppHandle,
    original_name: Option<String>,
    mut source: MarketplaceSource,
) -> Result<Vec<MarketplaceSource>, String> {
    validate_marketplace_source(&mut source)?;
    confirm_action(
        &app,
        "确认保存 Marketplace",
        format!("允许将 Marketplace {} 写入 Melody 配置吗？", source.name),
    )
    .await?;
    save_marketplace_source_inner(original_name, source)
}

fn save_marketplace_source_inner(
    original_name: Option<String>,
    mut source: MarketplaceSource,
) -> Result<Vec<MarketplaceSource>, String> {
    validate_marketplace_source(&mut source)?;
    let (path, mut document) = read_user_config_document()?;
    let sources = marketplace_sources_mut(&mut document)?;
    if sources.iter().any(|entry| {
        entry.get("name").and_then(Item::as_str) == Some(source.name.as_str())
            && original_name.as_deref() != Some(source.name.as_str())
    }) {
        return Err(format!(
            "A marketplace named '{}' already exists",
            source.name
        ));
    }
    let existing = original_name.as_deref().and_then(|name| {
        sources
            .iter()
            .position(|entry| entry.get("name").and_then(Item::as_str) == Some(name))
    });
    let mut entry = Table::new();
    entry["name"] = toml_edit::value(&source.name);
    match source.kind.as_str() {
        "git" => {
            entry["git"] = toml_edit::value(&source.location);
            if let Some(branch) = &source.branch {
                entry["branch"] = toml_edit::value(branch);
            }
        }
        "local" => entry["path"] = toml_edit::value(&source.location),
        _ => unreachable!("validated marketplace kind"),
    }
    if let Some(index) = existing {
        let existing_entry = sources
            .iter_mut()
            .nth(index)
            .expect("marketplace index came from this collection");
        *existing_entry = entry;
    } else {
        sources.push(entry);
    }
    write_user_config(&path, &document)?;
    marketplace_sources(&document)
}

#[tauri::command]
pub async fn delete_marketplace_source(
    app: AppHandle,
    name: String,
) -> Result<Vec<MarketplaceSource>, String> {
    confirm_action(
        &app,
        "确认删除 Marketplace",
        format!("允许从 Melody 配置删除 Marketplace {} 吗？", name.trim()),
    )
    .await?;
    let (path, mut document) = read_user_config_document()?;
    let sources = marketplace_sources_mut(&mut document)?;
    let index = sources
        .iter()
        .position(|entry| entry.get("name").and_then(Item::as_str) == Some(name.as_str()))
        .ok_or_else(|| format!("Marketplace '{}' was not found", name))?;
    sources.remove(index);
    write_user_config(&path, &document)?;
    marketplace_sources(&document)
}
