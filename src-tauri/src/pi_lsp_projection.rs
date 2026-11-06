//! Bounded, deterministic text projections for read-only LSP results.
//!
//! The runtime owns process/configuration lifecycle; this module turns LSP
//! result JSON into the stable human-readable output shown by the Host tool.

use serde_json::Value;

pub(super) const MAX_OUTPUT_BYTES: usize = 256 * 1024;

pub(super) fn bounded_text(value: impl Into<String>) -> String {
    let value = value.into();
    if value.len() <= MAX_OUTPUT_BYTES {
        return value;
    }
    let suffix = "\n[output truncated]";
    let mut end = MAX_OUTPUT_BYTES.saturating_sub(suffix.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    let mut result = value[..end].to_string();
    result.push_str(suffix);
    result
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hi = (bytes[index + 1] as char).to_digit(16);
            let lo = (bytes[index + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                output.push((hi * 16 + lo) as u8);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}

fn location_path(value: &Value) -> Option<(String, u64, u64)> {
    let object = value.as_object()?;
    let uri = object
        .get("uri")
        .or_else(|| object.get("targetUri"))
        .and_then(Value::as_str)?;
    let range = object
        .get("range")
        .or_else(|| object.get("targetSelectionRange"))
        .and_then(Value::as_object)?;
    let start = range.get("start").and_then(Value::as_object)?;
    let line = start.get("line").and_then(Value::as_u64).unwrap_or(0);
    let character = start.get("character").and_then(Value::as_u64).unwrap_or(0);
    let path = uri
        .strip_prefix("file://")
        .map(percent_decode)
        .unwrap_or_else(|| uri.to_string());
    Some((path, line + 1, character + 1))
}

fn result_items(value: &Value) -> Vec<&Value> {
    match value {
        Value::Array(items) => items.iter().collect(),
        Value::Null => Vec::new(),
        other => vec![other],
    }
}

pub(super) fn format_locations(label: &str, value: &Value) -> String {
    let mut locations = result_items(value)
        .into_iter()
        .filter_map(location_path)
        .map(|(path, line, character)| format!("  {path}:{line}:{character}"))
        .collect::<Vec<_>>();
    locations.sort();
    locations.dedup();
    if locations.is_empty() {
        return "No results found.".to_string();
    }
    format!(
        "{label} ({} location{}):\n{}",
        locations.len(),
        if locations.len() == 1 { "" } else { "s" },
        locations.join("\n")
    )
}

fn symbol_kind(value: &Value) -> &'static str {
    match value.as_u64().unwrap_or(0) {
        1 => "File",
        2 => "Module",
        3 => "Namespace",
        4 => "Package",
        5 => "Class",
        6 => "Method",
        7 => "Property",
        8 => "Field",
        9 => "Constructor",
        10 => "Enum",
        11 => "Interface",
        12 => "Function",
        13 => "Variable",
        14 => "Constant",
        15 => "String",
        16 => "Number",
        17 => "Boolean",
        18 => "Array",
        19 => "Object",
        20 => "Key",
        21 => "Null",
        22 => "EnumMember",
        23 => "Struct",
        24 => "Event",
        25 => "Operator",
        26 => "TypeParameter",
        _ => "Symbol",
    }
}

fn append_symbols(value: &Value, output: &mut Vec<String>) {
    let Some(object) = value.as_object() else {
        return;
    };
    let Some(name) = object.get("name").and_then(Value::as_str) else {
        return;
    };
    let location = object
        .get("location")
        .and_then(location_path)
        .or_else(|| location_path(value));
    let Some((path, line, _character)) = location else {
        return;
    };
    let kind = symbol_kind(object.get("kind").unwrap_or(&Value::Null));
    output.push(format!("{kind} {name} ({path}:{line})"));
    if let Some(children) = object.get("children").and_then(Value::as_array) {
        for child in children {
            append_symbols(child, output);
        }
    }
}

pub(super) fn format_symbols(value: &Value) -> String {
    let mut symbols = Vec::new();
    for item in result_items(value) {
        append_symbols(item, &mut symbols);
    }
    symbols.sort();
    symbols.dedup();
    if symbols.is_empty() {
        "No symbols found.".to_string()
    } else {
        bounded_text(symbols.join("\n"))
    }
}

pub(super) fn hover_text(value: &Value) -> String {
    let Some(contents) = value.get("contents") else {
        return "No hover information available.".to_string();
    };
    fn one(value: &Value) -> Option<String> {
        match value {
            Value::String(text) => Some(text.clone()),
            Value::Object(object) => object
                .get("value")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            _ => None,
        }
    }
    let text = match contents {
        Value::Array(items) => items.iter().filter_map(one).collect::<Vec<_>>().join("\n"),
        other => one(other).unwrap_or_default(),
    };
    if text.trim().is_empty() {
        "No hover information available.".to_string()
    } else {
        bounded_text(text)
    }
}
