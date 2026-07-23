use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateStatus {
    configured: bool,
    available: bool,
    version: Option<String>,
    notes: Option<String>,
    installed: bool,
}

#[tauri::command]
pub async fn check_app_update(app: AppHandle, install: bool) -> Result<AppUpdateStatus, String> {
    let Some(public_key) =
        option_env!("MELODYWORK_UPDATER_PUBKEY").filter(|value| !value.trim().is_empty())
    else {
        return Ok(AppUpdateStatus {
            configured: false,
            available: false,
            version: None,
            notes: None,
            installed: false,
        });
    };
    let Some(endpoint) =
        option_env!("MELODYWORK_UPDATER_ENDPOINT").filter(|value| !value.trim().is_empty())
    else {
        return Ok(AppUpdateStatus {
            configured: false,
            available: false,
            version: None,
            notes: None,
            installed: false,
        });
    };
    let endpoint = endpoint
        .parse()
        .map_err(|error| format!("Invalid updater endpoint: {error}"))?;
    let updater = app
        .updater_builder()
        .pubkey(public_key)
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?;
    let Some(update) = updater.check().await.map_err(|error| error.to_string())? else {
        return Ok(AppUpdateStatus {
            configured: true,
            available: false,
            version: None,
            notes: None,
            installed: false,
        });
    };
    let version = Some(update.version.clone());
    let notes = update.body.clone();
    if install {
        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(AppUpdateStatus {
        configured: true,
        available: true,
        version,
        notes,
        installed: install,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn base_updater_configuration_deserializes() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri config JSON");
        let updater = config
            .get("plugins")
            .and_then(|plugins| plugins.get("updater"))
            .cloned()
            .expect("plugins.updater config");
        let _: tauri_plugin_updater::Config =
            serde_json::from_value(updater).expect("valid updater config");
    }
}
