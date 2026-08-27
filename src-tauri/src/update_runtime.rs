use std::cmp::Ordering;

use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    Stable,
    Beta,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateStatus {
    channel: UpdateChannel,
    configured: bool,
    available: bool,
    version: Option<String>,
    notes: Option<String>,
    installed: bool,
}

struct UpdateCandidate {
    channel: UpdateChannel,
    update: Update,
}

fn configured_endpoints(channel: UpdateChannel) -> Vec<(UpdateChannel, &'static str)> {
    let candidates = match channel {
        UpdateChannel::Stable => vec![(
            UpdateChannel::Stable,
            option_env!("MELODYWORK_UPDATER_ENDPOINT"),
        )],
        UpdateChannel::Beta => vec![
            (
                UpdateChannel::Beta,
                option_env!("MELODYWORK_BETA_UPDATER_ENDPOINT"),
            ),
            (
                UpdateChannel::Stable,
                option_env!("MELODYWORK_UPDATER_ENDPOINT"),
            ),
        ],
    };
    let mut endpoints = Vec::with_capacity(candidates.len());
    for (source, endpoint) in candidates {
        let Some(endpoint) = endpoint.filter(|value| !value.trim().is_empty()) else {
            continue;
        };
        if endpoints
            .iter()
            .any(|(_, configured)| *configured == endpoint)
        {
            continue;
        }
        endpoints.push((source, endpoint));
    }
    endpoints
}

async fn check_endpoint(
    app: &AppHandle,
    public_key: &str,
    channel: UpdateChannel,
    endpoint: &str,
) -> Result<Option<UpdateCandidate>, String> {
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
    let update = updater.check().await.map_err(|error| error.to_string())?;
    Ok(update.map(|update| UpdateCandidate { channel, update }))
}

fn compare_versions(left: &str, right: &str) -> Ordering {
    match (Version::parse(left), Version::parse(right)) {
        (Ok(left), Ok(right)) => left.cmp(&right),
        _ => left.cmp(right),
    }
}

fn channel_priority(channel: UpdateChannel) -> u8 {
    match channel {
        UpdateChannel::Stable => 1,
        UpdateChannel::Beta => 0,
    }
}

fn select_newest_update(candidates: Vec<UpdateCandidate>) -> Option<UpdateCandidate> {
    candidates.into_iter().max_by(|left, right| {
        compare_versions(&left.update.version, &right.update.version)
            .then_with(|| channel_priority(left.channel).cmp(&channel_priority(right.channel)))
    })
}

#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    channel: UpdateChannel,
    install: bool,
) -> Result<AppUpdateStatus, String> {
    let Some(public_key) =
        option_env!("MELODYWORK_UPDATER_PUBKEY").filter(|value| !value.trim().is_empty())
    else {
        return Ok(AppUpdateStatus {
            channel,
            configured: false,
            available: false,
            version: None,
            notes: None,
            installed: false,
        });
    };
    let endpoints = configured_endpoints(channel);
    if endpoints.is_empty() {
        return Ok(AppUpdateStatus {
            channel,
            configured: false,
            available: false,
            version: None,
            notes: None,
            installed: false,
        });
    }
    let mut candidates = Vec::new();
    let mut last_error = None;
    let mut endpoint_succeeded = false;
    for (source, endpoint) in endpoints {
        match check_endpoint(&app, public_key, source, endpoint).await {
            Ok(Some(candidate)) => {
                endpoint_succeeded = true;
                candidates.push(candidate);
            }
            Ok(None) => {
                endpoint_succeeded = true;
            }
            Err(error) => {
                last_error = Some(error);
            }
        }
    }
    if !endpoint_succeeded {
        return Err(last_error.unwrap_or_else(|| "Unable to check for updates".into()));
    }
    let Some(candidate) = select_newest_update(candidates) else {
        return Ok(AppUpdateStatus {
            channel,
            configured: true,
            available: false,
            version: None,
            notes: None,
            installed: false,
        });
    };
    let selected_channel = candidate.channel;
    let version = Some(candidate.update.version.clone());
    let notes = candidate.update.body.clone();
    if install {
        candidate
            .update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(AppUpdateStatus {
        channel: selected_channel,
        configured: true,
        available: true,
        version,
        notes,
        installed: install,
    })
}

#[cfg(test)]
mod tests {
    use std::cmp::Ordering;

    use super::{UpdateChannel, channel_priority, compare_versions};

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

    #[test]
    fn update_channel_deserializes_from_the_frontend_value() {
        let stable: UpdateChannel = serde_json::from_str("\"stable\"").expect("stable channel");
        let beta: UpdateChannel = serde_json::from_str("\"beta\"").expect("beta channel");
        assert!(matches!(stable, UpdateChannel::Stable));
        assert!(matches!(beta, UpdateChannel::Beta));
    }

    #[test]
    fn stable_release_is_newer_than_a_beta_for_the_same_base_version() {
        assert_eq!(compare_versions("0.3.1", "0.3.1-beta.2"), Ordering::Greater);
    }

    #[test]
    fn newer_beta_still_wins_over_an_older_stable_release() {
        assert_eq!(compare_versions("0.3.2-beta.1", "0.3.1"), Ordering::Greater);
    }

    #[test]
    fn stable_wins_when_versions_are_equal() {
        assert!(channel_priority(UpdateChannel::Stable) > channel_priority(UpdateChannel::Beta));
    }
}
