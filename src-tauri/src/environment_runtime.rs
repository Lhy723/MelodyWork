use serde::Serialize;
use tokio::process::Command;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentCapability {
    pub name: String,
    pub version: Option<String>,
    pub installed: bool,
    pub description: String,
}

#[tauri::command]
pub async fn get_environment_capabilities() -> Vec<EnvironmentCapability> {
    vec![
        probe(
            "Node.js",
            "node",
            &["--version"],
            "可选 · 仅 npx / npm 型 MCP 服务器需要（推荐 22 LTS）",
        )
        .await,
        probe(
            "Git",
            "git",
            &["--version"],
            "可选 · 用于 Git 变更、分支和工作树操作",
        )
        .await,
    ]
}

async fn probe(
    name: &str,
    binary: &str,
    args: &[&str],
    description: &str,
) -> EnvironmentCapability {
    let output = Command::new(binary).args(args).output().await;
    let version = output.ok().and_then(|result| {
        let stdout = String::from_utf8_lossy(&result.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
        let value = if stdout.is_empty() { stderr } else { stdout };
        if value.is_empty() { None } else { Some(value) }
    });

    EnvironmentCapability {
        name: name.to_string(),
        installed: version.is_some(),
        version,
        description: description.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::EnvironmentCapability;

    #[test]
    fn capability_serializes_with_frontend_field_names() {
        let capability = EnvironmentCapability {
            name: "Git".to_string(),
            version: Some("2.55.0".to_string()),
            installed: true,
            description: "用于 Git 操作".to_string(),
        };
        let value = serde_json::to_value(capability).expect("capability should serialize");
        assert_eq!(value["name"], "Git");
        assert_eq!(value["installed"], true);
        assert_eq!(value["version"], "2.55.0");
    }
}
