//! Ordered discovery and parsed-source catalog for declarative subagents.
//!
//! This module owns bounded native/plugin Markdown discovery and source
//! metadata. Policy and Settings remain separate consumers because their
//! naming and conflict rules are intentionally different.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use serde_json::{Map, Value};

use super::super::config_extensions::pi_plugin_agent_roots;
use super::subagent_markdown::{parse_agent_markdown, valid_name};
use crate::config_core::{melody_home, user_home};

const MAX_AGENT_DEFINITION_FILES: usize = 128;

#[derive(Clone, Debug)]
pub(super) struct AgentInventoryEntry {
    pub(super) path: PathBuf,
    pub(super) scope: String,
    pub(super) supported: bool,
    pub(super) unsupported_fields: Vec<String>,
}

#[derive(Clone, Debug)]
pub(super) struct AgentFileDefinition {
    pub(super) value: Value,
    pub(super) base: PathBuf,
    pub(super) unsupported_fields: Vec<String>,
}

#[derive(Clone)]
struct ParsedAgentDefinition {
    name: String,
    value: Value,
    unsupported_fields: Vec<String>,
    base: PathBuf,
    path: PathBuf,
}

#[derive(Clone)]
struct NativeAgentDefinition {
    scope: String,
    parsed: ParsedAgentDefinition,
}

#[derive(Clone)]
struct PluginAgentDefinition {
    scope: String,
    plugin: String,
    parsed: ParsedAgentDefinition,
}

/// One bounded source inventory feeds the Pi policy and Settings projections.
/// Each projection keeps its own conflict rules, while path enumeration and
/// Markdown parsing have a single owner.
#[derive(Default)]
pub(super) struct AgentDefinitionCatalog {
    native: BTreeMap<String, NativeAgentDefinition>,
    plugins: Vec<PluginAgentDefinition>,
}

impl AgentDefinitionCatalog {
    /// Resolve all native discovery roots without parsing them. Keeping root
    /// resolution separate lets each caller retain its existing error order.
    pub(super) fn native_roots(cwd: &str) -> Result<Vec<(PathBuf, String)>, String> {
        let cwd_path = PathBuf::from(cwd);
        if !cwd_path.is_dir() {
            return Err(format!("Workspace does not exist: {}", cwd_path.display()));
        }
        let mut roots = Vec::new();
        let mut current = cwd_path;
        let mut found_repository_marker = false;
        loop {
            for directory in [".melody", ".agents", ".claude", ".cursor"] {
                roots.push((
                    current.join(directory).join("agents"),
                    "project".to_string(),
                ));
            }
            if current.join(".git").exists() {
                found_repository_marker = true;
                break;
            }
            let Some(parent) = current.parent() else {
                break;
            };
            if parent == current {
                break;
            }
            current = parent.to_path_buf();
        }
        if !found_repository_marker {
            roots.truncate(4);
        }
        roots.push((melody_home()?.join("agents"), "user".to_string()));
        let home = user_home()?;
        for directory in [".agents", ".claude", ".cursor"] {
            roots.push((home.join(directory).join("agents"), "user".to_string()));
        }
        Ok(roots)
    }

    /// Load from the least-specific root to the most-specific root. Later
    /// files with the same declared name replace earlier definitions.
    pub(super) fn load_native_roots(&mut self, roots: &[(PathBuf, String)]) {
        for (directory, scope) in roots.iter().rev() {
            for path in agent_definition_paths(directory) {
                let parsed = parse_agent_definition_entry(&path, directory);
                self.native.insert(
                    parsed.name.clone(),
                    NativeAgentDefinition {
                        scope: scope.clone(),
                        parsed,
                    },
                );
            }
        }
    }

    pub(super) fn load_plugins(&mut self, cwd: &str) -> Result<(), String> {
        let roots = pi_plugin_agent_roots(cwd)?;
        visit_plugin_agent_definitions(&roots, |scope, plugin, _path, parsed| {
            self.plugins.push(PluginAgentDefinition {
                scope: scope.to_string(),
                plugin: plugin.to_string(),
                parsed,
            });
        });
        Ok(())
    }

    pub(super) fn merge_native_policy(
        &self,
        agents: &mut BTreeMap<String, AgentFileDefinition>,
        unsupported: &mut BTreeMap<String, Vec<String>>,
    ) {
        for definition in self.native.values() {
            set_parsed_agent_definition(definition.parsed.clone(), agents, unsupported);
        }
    }

    /// Plugin definitions always retain their qualified name. Their bare name
    /// is available only if no native, inline, or earlier plugin source claims it.
    pub(super) fn merge_plugin_policy(
        &self,
        agents: &mut BTreeMap<String, AgentFileDefinition>,
        unsupported: &mut BTreeMap<String, Vec<String>>,
    ) {
        for definition in &self.plugins {
            let bare_name_is_free = !agents.contains_key(&definition.parsed.name)
                && !unsupported.contains_key(&definition.parsed.name);
            if bare_name_is_free {
                set_parsed_agent_definition(definition.parsed.clone(), agents, unsupported);
            }
            let mut qualified = definition.parsed.clone();
            qualified.name = format!("{}:{}", definition.plugin, qualified.name);
            set_parsed_agent_definition(qualified, agents, unsupported);
        }
    }

    pub(super) fn project_native_inventory(
        &self,
        target: &mut BTreeMap<String, AgentInventoryEntry>,
    ) {
        for (name, definition) in &self.native {
            target.insert(
                name.clone(),
                AgentInventoryEntry {
                    path: definition.parsed.path.clone(),
                    scope: definition.scope.clone(),
                    supported: definition.parsed.unsupported_fields.is_empty(),
                    unsupported_fields: definition.parsed.unsupported_fields.clone(),
                },
            );
        }
    }

    pub(super) fn project_plugin_inventory(
        &self,
        target: &mut BTreeMap<String, AgentInventoryEntry>,
    ) {
        for definition in &self.plugins {
            let qualified = format!("{}:{}", definition.plugin, definition.parsed.name);
            target.insert(
                qualified,
                AgentInventoryEntry {
                    path: definition.parsed.path.clone(),
                    scope: definition.scope.clone(),
                    supported: definition.parsed.unsupported_fields.is_empty(),
                    unsupported_fields: definition.parsed.unsupported_fields.clone(),
                },
            );
        }
    }
}

/// Ordinary `*.md` files in an agent directory, in deterministic order.
fn agent_definition_paths(directory: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut paths = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension().and_then(|extension| extension.to_str()) == Some("md")
                && path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .is_some_and(valid_name)
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths.truncate(MAX_AGENT_DEFINITION_FILES);
    paths
}

fn parse_agent_definition_entry(path: &Path, directory: &Path) -> ParsedAgentDefinition {
    let fallback_name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string();
    match parse_agent_markdown(path) {
        Ok((name, value, unsupported_fields)) => ParsedAgentDefinition {
            name,
            value,
            unsupported_fields,
            base: path.parent().unwrap_or(directory).to_path_buf(),
            path: path.to_path_buf(),
        },
        Err(reason) => ParsedAgentDefinition {
            name: fallback_name,
            value: Value::Object(Map::new()),
            unsupported_fields: vec![reason],
            base: directory.to_path_buf(),
            path: path.to_path_buf(),
        },
    }
}

/// Stream enabled plugin agent files through one bounded scan and parser.
fn visit_plugin_agent_definitions(
    roots: &[(PathBuf, String, String)],
    mut visit: impl FnMut(&str, &str, &Path, ParsedAgentDefinition),
) {
    for (directory, scope, plugin) in roots {
        for path in agent_definition_paths(directory) {
            let entry = parse_agent_definition_entry(&path, directory);
            visit(scope, plugin, &path, entry);
        }
    }
}

/// Register one parsed file definition without re-evaluating its filtered data.
fn set_parsed_agent_definition(
    entry: ParsedAgentDefinition,
    agents: &mut BTreeMap<String, AgentFileDefinition>,
    unsupported: &mut BTreeMap<String, Vec<String>>,
) {
    let ParsedAgentDefinition {
        name,
        value,
        unsupported_fields,
        base,
        ..
    } = entry;
    agents.remove(&name);
    unsupported.remove(&name);
    if unsupported_fields.is_empty() {
        agents.insert(
            name,
            AgentFileDefinition {
                value,
                base,
                unsupported_fields,
            },
        );
    } else {
        unsupported.insert(name, unsupported_fields);
    }
}
