//! URL trust policy for remote browser pages, local previews, and popups.
//!
//! These predicates form the boundary for navigation and content returned to
//! the Pi worker. Keeping them together makes the public-HTTPS and loopback
//! preview exceptions auditable without pulling in WebView lifecycle state.

use std::net::IpAddr;

use reqwest::Url;

const MAX_URL_BYTES: usize = 4_096;

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            !address.is_private()
                && !address.is_loopback()
                && !address.is_link_local()
                && !address.is_broadcast()
                && !address.is_unspecified()
                && !address.is_multicast()
                && !address.is_documentation()
        }
        IpAddr::V6(address) => {
            let segments = address.segments();
            !address.is_loopback()
                && !address.is_unspecified()
                && !address.is_multicast()
                && !(segments[0] & 0xfe00 == 0xfc00) // unique-local
                && !(segments[0] & 0xffc0 == 0xfe80) // link-local
        }
    }
}

pub(super) fn validate_url(raw: &str) -> Result<Url, String> {
    if raw.len() > MAX_URL_BYTES || raw.chars().any(char::is_control) {
        return Err("Browser URL is invalid or exceeds 4 KB.".to_string());
    }
    let url = Url::parse(raw.trim()).map_err(|error| format!("Browser URL is invalid: {error}"))?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let local_name = host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal");
    let private_ip = host
        .parse::<IpAddr>()
        .is_ok_and(|address| !is_public_ip(address));
    if url.scheme() != "https"
        || host.is_empty()
        || !url.username().is_empty()
        || url.password().is_some()
        || local_name
        || private_ip
    {
        return Err(
            "Browser only allows public HTTPS URLs without embedded credentials.".to_string(),
        );
    }
    Ok(url)
}

pub(super) fn validate_local_preview_url(raw: &str) -> Result<Url, String> {
    if raw.len() > MAX_URL_BYTES || raw.chars().any(char::is_control) {
        return Err("Local preview URL is invalid or exceeds 4 KB.".to_string());
    }
    let url =
        Url::parse(raw.trim()).map_err(|error| format!("Local preview URL is invalid: {error}"))?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let is_loopback_name = host == "localhost" || host.ends_with(".localhost");
    let is_loopback_ip = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
        .is_ok_and(|address| address.is_loopback());
    if !matches!(url.scheme(), "http" | "https")
        || (!is_loopback_name && !is_loopback_ip)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(
            "Local preview only allows HTTP(S) loopback URLs without credentials.".to_string(),
        );
    }
    Ok(url)
}

pub(super) fn browser_url_is_allowed_for_snapshot(raw: &str, local_origin: Option<&str>) -> bool {
    if raw == "about:blank" || validate_url(raw).is_ok() {
        return true;
    }
    validate_local_preview_url(raw)
        .is_ok_and(|url| local_origin == Some(url.origin().ascii_serialization().as_str()))
}

pub(super) fn is_allowed_popup_url(raw: &str) -> bool {
    raw == "about:blank" || validate_url(raw).is_ok()
}
