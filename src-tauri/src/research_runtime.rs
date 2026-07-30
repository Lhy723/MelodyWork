use serde::Serialize;
use std::time::Duration;

const MAX_RESPONSE_BYTES: u64 = 10 * 1024 * 1024;
const ALLOWED_RESEARCH_HOSTS: [&str; 5] = [
    "api.crossref.org",
    "api.openalex.org",
    "api.semanticscholar.org",
    "eutils.ncbi.nlm.nih.gov",
    "export.arxiv.org",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchHttpResponse {
    body: String,
    content_type: Option<String>,
}

fn validate_research_url(candidate: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(candidate).map_err(|error| error.to_string())?;
    if url.scheme() != "https" {
        return Err("科研数据源仅允许 HTTPS 请求。".into());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "科研数据源地址缺少主机名。".to_string())?;
    if !ALLOWED_RESEARCH_HOSTS.contains(&host) {
        return Err(format!("不允许访问科研数据源主机：{host}"));
    }
    Ok(url)
}

#[tauri::command]
pub async fn fetch_research_resource(
    url: String,
    accept: Option<String>,
) -> Result<ResearchHttpResponse, String> {
    let url = validate_research_url(&url)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("MelodyWork/0.1 research-client")
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client.get(url);
    if let Some(accept) = accept.filter(|value| !value.trim().is_empty()) {
        request = request.header(reqwest::header::ACCEPT, accept);
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "{} {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("")
        ));
    }
    if response.content_length().unwrap_or(0) > MAX_RESPONSE_BYTES {
        return Err("科研数据源响应超过 10 MB 限制。".into());
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        return Err("科研数据源响应超过 10 MB 限制。".into());
    }
    let body = String::from_utf8(bytes.to_vec())
        .map_err(|_| "科研数据源返回了非 UTF-8 内容。".to_string())?;
    Ok(ResearchHttpResponse { body, content_type })
}

#[cfg(test)]
mod tests {
    use super::validate_research_url;

    #[test]
    fn allows_only_known_https_research_hosts() {
        assert!(validate_research_url("https://api.crossref.org/works?query=test").is_ok());
        assert!(
            validate_research_url("https://api.semanticscholar.org/graph/v1/paper/search").is_ok()
        );
        assert!(validate_research_url("http://export.arxiv.org/api/query").is_err());
        assert!(validate_research_url("https://example.com/").is_err());
    }
}
