#[cfg(target_os = "windows")]
use std::path::PathBuf;

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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOpenerAvailability {
    pub id: String,
    pub installed: bool,
}

#[tauri::command]
pub async fn get_environment_capabilities() -> Vec<EnvironmentCapability> {
    vec![
        probe(
            "Node.js",
            "node",
            &["--version"],
            "仅 npx / npm 型 MCP 服务器需要（推荐 22 LTS）",
        )
        .await,
        probe(
            "Git",
            "git",
            &["--version"],
            "用于 Git 变更、分支和工作树操作",
        )
        .await,
    ]
}

#[tauri::command]
pub async fn get_file_opener_availability() -> Vec<FileOpenerAvailability> {
    vec![
        FileOpenerAvailability {
            id: "system".to_string(),
            installed: true,
        },
        FileOpenerAvailability {
            id: "vscode".to_string(),
            installed: detect_editor("vscode").await,
        },
        FileOpenerAvailability {
            id: "cursor".to_string(),
            installed: detect_editor("cursor").await,
        },
    ]
}

async fn detect_editor(id: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        let app_name = match id {
            "vscode" => "Visual Studio Code",
            "cursor" => "Cursor",
            _ => return false,
        };
        if command_succeeds("/usr/bin/open", &["-Ra", app_name]).await {
            return true;
        }
    }

    let binary = match id {
        "vscode" => "code",
        "cursor" => "cursor",
        _ => return false,
    };
    if command_succeeds(binary, &["--version"]).await {
        return true;
    }

    #[cfg(target_os = "windows")]
    {
        return windows_editor_paths(id).iter().any(|path| path.is_file());
    }

    false
}

async fn command_succeeds(program: &str, args: &[&str]) -> bool {
    Command::new(program)
        .args(args)
        .output()
        .await
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn windows_editor_paths(id: &str) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local_app_data));
    }
    if let Some(program_files) = std::env::var_os("PROGRAMFILES") {
        roots.push(PathBuf::from(program_files));
    }
    if let Some(program_files_x86) = std::env::var_os("PROGRAMFILES(X86)") {
        roots.push(PathBuf::from(program_files_x86));
    }

    match id {
        "vscode" => roots
            .into_iter()
            .flat_map(|root| {
                [
                    root.join("Programs/Microsoft VS Code/Code.exe"),
                    root.join("Microsoft VS Code/Code.exe"),
                    root.join("Programs/Microsoft VS Code/bin/code.cmd"),
                    root.join("Microsoft VS Code/bin/code.cmd"),
                ]
            })
            .collect(),
        "cursor" => roots
            .into_iter()
            .flat_map(|root| {
                [
                    root.join("Programs/Cursor/Cursor.exe"),
                    root.join("Cursor/Cursor.exe"),
                    root.join("Programs/Cursor/resources/app/bin/cursor.cmd"),
                    root.join("Cursor/resources/app/bin/cursor.cmd"),
                ]
            })
            .collect(),
        _ => Vec::new(),
    }
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
