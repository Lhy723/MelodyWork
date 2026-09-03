#[path = "config_core.rs"]
mod config_core;
#[path = "config_extensions.rs"]
mod config_extensions;
#[path = "config_marketplace.rs"]
mod config_marketplace;
#[path = "config_plugin_details.rs"]
mod config_plugin_details;

pub use config_core::*;
pub use config_extensions::*;
pub use config_marketplace::*;
pub use config_plugin_details::*;

#[cfg(test)]
mod tests {
    use std::{collections::HashSet, env, fs};

    use toml_edit::{DocumentMut, Table};

    use super::config_core::*;
    use super::config_extensions::*;
    use super::config_marketplace::*;
    use super::config_plugin_details::*;
    use super::*;

    #[test]
    fn scans_supported_extension_directories() {
        let root = env::temp_dir().join(format!("melody-work-config-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("skills/review")).unwrap();
        fs::create_dir_all(root.join("plugins/git-tools")).unwrap();
        fs::create_dir_all(root.join("hooks")).unwrap();
        fs::write(root.join("skills/review/SKILL.md"), "# Review").unwrap();
        fs::write(root.join("hooks/after-tool.sh"), "#!/bin/sh").unwrap();

        let mut extensions = Vec::new();
        let disabled = HashSet::new();
        for kind in ["skills", "plugins", "hooks"] {
            scan_kind(&root, "project", kind, "melody", &disabled, &mut extensions);
        }

        assert_eq!(extensions.len(), 3);
        assert!(extensions.iter().any(|item| item.name == "review"));
        assert!(extensions.iter().any(|item| item.name == "git-tools"));
        assert!(extensions.iter().any(|item| item.name == "after-tool.sh"));
        assert!(extensions.iter().all(|item| item.provider == "melody"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scans_claude_compatible_plugins() {
        let root = env::temp_dir().join(format!("melody-work-claude-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("plugins/review-tools")).unwrap();

        let mut extensions = Vec::new();
        let disabled = HashSet::from(["review-tools".to_string()]);
        scan_kind(
            &root,
            "project",
            "plugins",
            "claude",
            &disabled,
            &mut extensions,
        );

        assert_eq!(extensions.len(), 1);
        assert_eq!(extensions[0].name, "review-tools");
        assert_eq!(extensions[0].provider, "claude");
        assert!(!extensions[0].enabled);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_git_and_local_marketplace_sources() {
        let document = r#"
[[marketplace.sources]]
name = "Team"
git = "https://example.com/plugins.git"
branch = "stable"

[[marketplace.sources]]
name = "Local"
path = "~/dev/plugins"
"#
        .parse::<DocumentMut>()
        .unwrap();

        let sources = marketplace_sources(&document).unwrap();

        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].kind, "git");
        assert_eq!(sources[0].branch.as_deref(), Some("stable"));
        assert_eq!(sources[1].kind, "local");
        assert_eq!(sources[1].location, "~/dev/plugins");
    }

    #[test]
    fn creates_marketplace_source_array_without_replacing_other_settings() {
        let mut document = "[marketplace]\nrequire_sha = true\n"
            .parse::<DocumentMut>()
            .unwrap();
        let sources = marketplace_sources_mut(&mut document).unwrap();
        let mut entry = Table::new();
        entry["name"] = toml_edit::value("Team");
        entry["git"] = toml_edit::value("https://example.com/plugins.git");
        sources.push(entry);

        let output = document.to_string();
        assert!(output.contains("require_sha = true"));
        assert!(output.contains("[[marketplace.sources]]"));
        assert!(output.contains("name = \"Team\""));
    }

    #[test]
    fn infers_marketplace_source_from_common_inputs() {
        let shorthand = marketplace_source_from_input("acme/team-plugins@stable").unwrap();
        assert_eq!(shorthand.name, "team-plugins");
        assert_eq!(shorthand.kind, "git");
        assert_eq!(
            shorthand.location,
            "https://github.com/acme/team-plugins.git"
        );
        assert_eq!(shorthand.branch.as_deref(), Some("stable"));

        let git = marketplace_source_from_input("https://example.com/acme/tools.git").unwrap();
        assert_eq!(git.name, "tools");
        assert_eq!(git.kind, "git");

        let local = marketplace_source_from_input("~/dev/plugins").unwrap();
        assert_eq!(local.name, "plugins");
        assert_eq!(local.kind, "local");
    }

    #[test]
    fn reads_plugin_metadata_and_component_inventory() {
        let root = env::temp_dir().join(format!("melody-work-plugin-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".claude-plugin")).unwrap();
        fs::create_dir_all(root.join("skills/review")).unwrap();
        fs::create_dir_all(root.join("commands")).unwrap();
        fs::create_dir_all(root.join("agents")).unwrap();
        fs::write(root.join("skills/review/SKILL.md"), "# Review").unwrap();
        fs::write(root.join("commands/check.md"), "# Check").unwrap();
        fs::write(root.join("agents/reviewer.md"), "# Reviewer").unwrap();
        fs::write(
            root.join(".claude-plugin/plugin.json"),
            serde_json::json!({
                "name": "team-tools",
                "version": "1.2.3",
                "description": "Team utilities",
                "author": { "name": "Acme" },
                "hooks": { "PreToolUse": [] },
                "mcpServers": { "github": { "command": "server" } },
                "lspServers": { "rust": { "command": "rust-analyzer" } }
            })
            .to_string(),
        )
        .unwrap();

        let details = plugin_details_from_directory(&root, "team-tools");

        assert_eq!(details.name, "team-tools");
        assert_eq!(details.version.as_deref(), Some("1.2.3"));
        assert_eq!(details.author.as_deref(), Some("Acme"));
        assert_eq!(details.components[0].items, ["review"]);
        assert_eq!(details.components[1].items, ["check"]);
        assert_eq!(details.components[2].items, ["reviewer"]);
        assert_eq!(details.components[3].items, ["PreToolUse"]);
        assert_eq!(details.components[4].items, ["github"]);
        assert_eq!(details.components[5].items, ["rust"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_skill_metadata_content_and_files() {
        let root = env::temp_dir().join(format!("melody-work-skill-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("references")).unwrap();
        fs::write(
            root.join("SKILL.md"),
            "---\nname: review\ndescription: Review code safely\nlicense: MIT\ncompatibility: Melody 0.0.1+\n---\n\n# Review\n",
        )
        .unwrap();
        fs::write(root.join("references/checklist.md"), "# Checklist").unwrap();

        let details = skill_details_from_directory(&root, "fallback").unwrap();

        assert_eq!(details.name, "review");
        assert_eq!(details.description.as_deref(), Some("Review code safely"));
        assert_eq!(details.license.as_deref(), Some("MIT"));
        assert_eq!(details.compatibility.as_deref(), Some("Melody 0.0.1+"));
        assert!(details.content.contains("# Review"));
        assert_eq!(details.files, ["SKILL.md", "references/checklist.md"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn maps_runtime_skill_catalog_with_sources_and_status() {
        let root = env::temp_dir().join(format!(
            "melody-work-runtime-skills-{}",
            uuid::Uuid::new_v4()
        ));
        let local = root.join(".melody/skills/review");
        let plugin = root.join(".claude/plugins/cache/team/skills/check");
        fs::create_dir_all(&local).unwrap();
        fs::create_dir_all(&plugin).unwrap();
        fs::write(local.join("SKILL.md"), "# Review").unwrap();
        fs::write(plugin.join("SKILL.md"), "# Check").unwrap();
        let document: MelodyInspectDocument = serde_json::from_value(serde_json::json!({
            "skills": [
                {
                    "name": "review",
                    "description": "Review changes",
                    "source": {
                        "type": "local",
                        "path": local.join("SKILL.md"),
                    },
                    "userInvocable": true
                },
                {
                    "name": "team:check",
                    "source": {
                        "type": "plugin",
                        "plugin_name": "team",
                        "path": plugin.join("SKILL.md"),
                    },
                    "vendor": "claude",
                    "disabled": true,
                    "compatibilityStatus": "disabled"
                }
            ]
        }))
        .unwrap();

        let skills = melody_skill_extensions(root.to_str().unwrap(), document);

        assert_eq!(skills.len(), 2);
        assert_eq!(skills[0].name, "review");
        assert_eq!(skills[0].scope, "project");
        assert_eq!(skills[0].provider, "melody");
        assert!(skills[0].enabled);
        assert!(skills[0].deletable);
        assert_eq!(skills[1].plugin_name.as_deref(), Some("team"));
        assert_eq!(skills[1].provider, "claude");
        assert!(!skills[1].enabled);
        assert!(!skills[1].deletable);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn skill_paths_must_be_direct_children_of_an_allowed_root() {
        let root = env::temp_dir().join(format!("melody-work-skills-{}", uuid::Uuid::new_v4()));
        let allowed = root.join("skills");
        let valid = allowed.join("review");
        let nested = valid.join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::write(valid.join("SKILL.md"), "# Review").unwrap();
        fs::write(nested.join("SKILL.md"), "# Nested").unwrap();

        assert!(allowed_skill_path_in_roots(&valid, &[allowed.clone()]).is_ok());
        assert!(allowed_skill_path_in_roots(&nested, &[allowed]).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn patches_known_values_without_removing_comments_or_unknown_settings() {
        let mut document = r#"# Keep this comment
[models]
default = "old"
future_option = "preserved"
"#
        .parse::<DocumentMut>()
        .unwrap();
        apply_patch(
            &mut document,
            &MelodyConfigPatch {
                path: vec!["models".into(), "default".into()],
                value: serde_json::json!("new"),
            },
        )
        .unwrap();
        apply_patch(
            &mut document,
            &MelodyConfigPatch {
                path: vec!["features".into(), "telemetry".into()],
                value: serde_json::json!(false),
            },
        )
        .unwrap();

        let output = document.to_string();
        assert!(output.contains("# Keep this comment"));
        assert!(output.contains("future_option = \"preserved\""));
        assert!(output.contains("default = \"new\""));
        assert!(output.contains("telemetry = false"));
    }

    #[test]
    fn null_patch_removes_only_the_requested_value() {
        let mut document = "[ui]\nsimple_mode = true\nvim_mode = true\n"
            .parse::<DocumentMut>()
            .unwrap();
        apply_patch(
            &mut document,
            &MelodyConfigPatch {
                path: vec!["ui".into(), "vim_mode".into()],
                value: serde_json::Value::Null,
            },
        )
        .unwrap();

        let output = document.to_string();
        assert!(output.contains("simple_mode = true"));
        assert!(!output.contains("vim_mode"));
    }

    #[test]
    fn parses_available_and_installed_marketplace_plugins() {
        let plugins = marketplace_plugins_from_json(
            r#"[
                {
                    "status": "available",
                    "name": "web-tools",
                    "version": "1.2.0",
                    "description": "Web tools",
                    "marketplace": "Official",
                    "skill_count": 2,
                    "has_hooks": true,
                    "has_agents": false,
                    "has_mcp": true
                },
                {
                    "status": "installed",
                    "name": "reviewer",
                    "version": "0.4.0",
                    "marketplace": "Official"
                },
                {
                    "status": "installed",
                    "name": "direct-install",
                    "version": "1.0.0",
                    "marketplace": null
                }
            ]"#,
        )
        .unwrap();

        assert_eq!(plugins.len(), 2);
        assert_eq!(plugins[0].name, "web-tools");
        assert_eq!(plugins[0].version.as_deref(), Some("1.2.0"));
        assert_eq!(plugins[0].skill_count, 2);
        assert!(plugins[0].has_hooks);
        assert!(plugins[0].has_mcp);
        assert_eq!(plugins[1].status, "installed");
        assert_eq!(plugins[1].installed_version.as_deref(), Some("0.4.0"));
        assert!(!plugins[1].update_available);
    }

    #[test]
    fn merges_installed_and_available_entries_before_marking_updates() {
        let plugins = marketplace_plugins_from_json(
            r#"[
                {
                    "status": "available",
                    "name": "new-tools",
                    "version": "2.0.0",
                    "description": "New tools",
                    "marketplace": "Official",
                    "skill_count": 3,
                    "has_hooks": true,
                    "has_agents": false,
                    "has_mcp": false
                },
                {
                    "status": "installed",
                    "name": "new-tools",
                    "version": "1.4.0",
                    "marketplace": "Official"
                },
                {
                    "status": "available",
                    "name": "same-tools",
                    "version": "1.4.0",
                    "marketplace": "Official"
                },
                {
                    "status": "installed",
                    "name": "same-tools",
                    "version": "1.4.0",
                    "marketplace": "Official"
                },
                {
                    "status": "installed",
                    "name": "unknown-tools",
                    "version": null,
                    "marketplace": "Official"
                }
            ]"#,
        )
        .unwrap();

        assert_eq!(plugins.len(), 3);
        assert_eq!(plugins[0].status, "installed");
        assert_eq!(plugins[0].version.as_deref(), Some("2.0.0"));
        assert_eq!(plugins[0].installed_version.as_deref(), Some("1.4.0"));
        assert!(plugins[0].update_available);
        assert_eq!(plugins[0].skill_count, 3);
        assert!(!plugins[1].update_available);
        assert!(!plugins[2].update_available);
    }

    #[test]
    fn normalizes_plugin_update_messages_without_unknown_version_claims() {
        assert_eq!(
            format_plugin_update_message(
                "agent-sdk-dev",
                "agent-sdk-dev-df237656: updated (? -> ?)"
            ),
            "agent-sdk-dev 已完成同步；插件来源未提供版本号，暂时无法确认是否有版本变化。"
        );
        assert_eq!(
            format_plugin_update_message("tools", "tools-abc: already up to date"),
            "tools 已是最新版本。"
        );
        assert_eq!(
            format_plugin_update_message("tools", ""),
            "tools 已是最新版本。"
        );
    }
}
