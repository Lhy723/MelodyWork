use std::collections::HashSet;

use serde_json::Value;

use super::MAX_SEARCH_OUTPUT_BYTES;

pub(super) fn bounded_text(mut text: String, limit: usize) -> String {
    if text.len() <= limit {
        return text;
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push_str("\n[output truncated]");
    text
}

fn html_entity(value: &str) -> Option<char> {
    match value {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" | "#39" => Some('\''),
        "nbsp" => Some(' '),
        _ if value.starts_with("#x") => u32::from_str_radix(&value[2..], 16)
            .ok()
            .and_then(char::from_u32),
        _ if value.starts_with('#') => value[1..].parse::<u32>().ok().and_then(char::from_u32),
        _ => None,
    }
}

fn decode_entities(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find('&') {
        output.push_str(&rest[..start]);
        let candidate = &rest[start + 1..];
        let Some(end) = candidate.find(';') else {
            output.push_str(&rest[start..]);
            return output;
        };
        let entity = &candidate[..end];
        if let Some(decoded) = html_entity(entity) {
            output.push(decoded);
            rest = &candidate[end + 1..];
        } else {
            output.push('&');
            rest = candidate;
        }
    }
    output.push_str(rest);
    output
}

pub(super) fn html_to_text(html: &str, limit: usize) -> String {
    let chars = html.chars().collect::<Vec<_>>();
    let mut output = String::new();
    let mut index = 0;
    let mut hidden_depth = 0usize;
    let block_tags = [
        "address",
        "article",
        "aside",
        "blockquote",
        "br",
        "dd",
        "div",
        "dl",
        "dt",
        "figcaption",
        "figure",
        "footer",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "header",
        "hr",
        "li",
        "main",
        "nav",
        "ol",
        "p",
        "pre",
        "section",
        "table",
        "td",
        "th",
        "tr",
        "ul",
    ];
    while index < chars.len() {
        if chars[index] == '<' {
            if index + 3 < chars.len()
                && chars[index + 1] == '!'
                && chars[index + 2] == '-'
                && chars[index + 3] == '-'
            {
                let mut end = index + 4;
                while end + 2 < chars.len()
                    && !(chars[end] == '-' && chars[end + 1] == '-' && chars[end + 2] == '>')
                {
                    end += 1;
                }
                index = if end + 2 < chars.len() {
                    end + 3
                } else {
                    chars.len()
                };
                continue;
            }
            let mut end = index + 1;
            while end < chars.len() && chars[end] != '>' && end.saturating_sub(index) <= 512 {
                end += 1;
            }
            if end >= chars.len() || chars[end] != '>' {
                break;
            }
            let token = chars[index + 1..end].iter().collect::<String>();
            let trimmed = token.trim();
            let closing = trimmed.starts_with('/');
            let name = trimmed
                .trim_start_matches('/')
                .trim()
                .split_whitespace()
                .next()
                .unwrap_or_default()
                .trim_end_matches('/')
                .to_ascii_lowercase();
            if matches!(name.as_str(), "script" | "style" | "noscript" | "svg") {
                if closing {
                    hidden_depth = hidden_depth.saturating_sub(1);
                } else {
                    hidden_depth = hidden_depth.saturating_add(1);
                }
            } else if hidden_depth == 0 && block_tags.contains(&name.as_str()) {
                output.push('\n');
            }
            index = end + 1;
            continue;
        }
        if hidden_depth == 0 {
            output.push(chars[index]);
            if output.len() >= limit.saturating_mul(2) {
                break;
            }
        }
        index += 1;
    }
    let decoded = decode_entities(&output);
    let mut lines = Vec::new();
    for line in decoded.lines() {
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if !line.is_empty()
            && lines
                .last()
                .is_none_or(|previous: &String| previous != &line)
        {
            lines.push(line);
        }
    }
    bounded_text(lines.join("\n"), limit)
}

fn citations_and_text(value: &Value) -> (String, Vec<(String, String)>) {
    fn walk(value: &Value, text: &mut String, citations: &mut Vec<(String, String)>, depth: usize) {
        if depth > 8 {
            return;
        }
        match value {
            Value::Object(object) => {
                for (key, child) in object {
                    if key == "output_text" || key == "text" {
                        if let Some(value) = child.as_str() {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(value);
                        }
                    }
                    if key == "url" {
                        if let Some(url) = child
                            .as_str()
                            .filter(|url| url.starts_with("http://") || url.starts_with("https://"))
                        {
                            let title = object
                                .get("title")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                            citations.push((title, url.to_string()));
                        }
                    }
                    walk(child, text, citations, depth + 1);
                }
            }
            Value::Array(items) => items
                .iter()
                .for_each(|item| walk(item, text, citations, depth + 1)),
            _ => {}
        }
    }
    let mut text = String::new();
    let mut citations = Vec::new();
    walk(value, &mut text, &mut citations, 0);
    let mut seen = HashSet::new();
    citations.retain(|(_, url)| seen.insert(url.clone()));
    (bounded_text(text, MAX_SEARCH_OUTPUT_BYTES), citations)
}

pub(super) fn format_search_output(value: Value) -> String {
    let (text, citations) = citations_and_text(&value);
    let mut output = if text.trim().is_empty() {
        "No search results found.".to_string()
    } else {
        text.trim().to_string()
    };
    if !citations.is_empty() {
        output.push_str("\n\nSources:\n");
        for (index, (title, url)) in citations.iter().enumerate() {
            let label = if title.trim().is_empty() { url } else { title };
            output.push_str(&format!("{}. [{}]({})\n", index + 1, label, url));
        }
    }
    bounded_text(output, MAX_SEARCH_OUTPUT_BYTES)
}
