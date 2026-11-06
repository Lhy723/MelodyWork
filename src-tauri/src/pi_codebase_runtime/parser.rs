//! Tree-sitter language selection and source occurrence extraction.
//!
//! Parsing is deliberately independent of workspace traversal, index caching,
//! and Host request authorization. It returns bounded syntax occurrences to
//! the codebase index without retaining parser or tree state.

use std::path::Path;

use tree_sitter::{Language, Node, Parser};

const MAX_SYMBOL_BYTES: usize = 256;
/// Untrusted source can contain pathological nesting; cap recursive AST walks.
const MAX_AST_DEPTH: usize = 256;

#[derive(Debug, Clone)]
pub(super) struct Occurrence {
    pub(super) symbol: String,
    pub(super) line: usize,
    pub(super) character: usize,
    pub(super) end_character: usize,
    pub(super) kind: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LanguageKind {
    Rust,
    TypeScript,
    JavaScript,
    Python,
    Go,
}

fn language_for_path(path: &Path) -> Option<LanguageKind> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "rs" => Some(LanguageKind::Rust),
        "ts" | "tsx" => Some(LanguageKind::TypeScript),
        "js" | "jsx" | "mjs" | "cjs" => Some(LanguageKind::JavaScript),
        "py" | "pyi" => Some(LanguageKind::Python),
        "go" => Some(LanguageKind::Go),
        _ => None,
    }
}

pub(super) fn supports_path(path: &Path) -> bool {
    language_for_path(path).is_some()
}

fn language_for_kind(kind: LanguageKind) -> Language {
    match kind {
        LanguageKind::Rust => tree_sitter_rust::LANGUAGE.into(),
        LanguageKind::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        LanguageKind::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
        LanguageKind::Python => tree_sitter_python::LANGUAGE.into(),
        LanguageKind::Go => tree_sitter_go::LANGUAGE.into(),
    }
}

pub(super) fn parse_source(
    path: &Path,
    source: &[u8],
) -> Result<(Vec<Occurrence>, Vec<Occurrence>), String> {
    let kind = language_for_path(path).ok_or_else(|| "不支持的代码文件类型。".to_string())?;
    let mut parser = Parser::new();
    parser
        .set_language(&language_for_kind(kind))
        .map_err(|error| format!("无法初始化代码解析器：{error}"))?;
    let tree = parser
        .parse(source, None)
        .ok_or_else(|| "代码解析失败。".to_string())?;
    let mut definitions = Vec::new();
    let mut references = Vec::new();
    collect_occurrences(
        tree.root_node(),
        source,
        kind,
        &mut definitions,
        &mut references,
        0,
    );
    deduplicate_occurrences(&mut definitions);
    deduplicate_occurrences(&mut references);
    Ok((definitions, references))
}

fn is_identifier_kind(kind: &str) -> bool {
    matches!(
        kind,
        "identifier"
            | "type_identifier"
            | "field_identifier"
            | "property_identifier"
            | "namespace_identifier"
            | "shorthand_property_identifier_pattern"
            | "shorthand_property_identifier"
    )
}

fn node_in_field(parent: Node<'_>, field: &str, node: Node<'_>) -> bool {
    let Some(field_node) = parent.child_by_field_name(field) else {
        return false;
    };
    node.start_byte() >= field_node.start_byte() && node.end_byte() <= field_node.end_byte()
}

fn direct_name(parent: Node<'_>, node: Node<'_>) -> bool {
    parent.child_by_field_name("name").is_some_and(|name| {
        name.start_byte() == node.start_byte() && name.end_byte() == node.end_byte()
    })
}

fn parameter_node(node: Node<'_>) -> bool {
    let mut parent = node.parent();
    for _ in 0..3 {
        let Some(candidate) = parent else {
            return false;
        };
        if matches!(
            candidate.kind(),
            "parameters"
                | "formal_parameters"
                | "parameter_list"
                | "parameter_declaration"
                | "required_parameter"
                | "optional_parameter"
                | "typed_parameter"
                | "default_parameter"
                | "list_splat_pattern"
                | "dictionary_splat_pattern"
        ) {
            return true;
        }
        parent = candidate.parent();
    }
    false
}

fn definition_kind(node: Node<'_>, language: LanguageKind) -> Option<&'static str> {
    let parent = node.parent()?;
    let kind = parent.kind();
    let direct = direct_name(parent, node);
    let pattern = node_in_field(parent, "pattern", node)
        || node_in_field(parent, "left", node)
        || node_in_field(parent, "name", node);
    match language {
        LanguageKind::Rust => {
            if direct {
                return match kind {
                    "function_item" => Some("function"),
                    "struct_item" => Some("struct"),
                    "enum_item" => Some("enum"),
                    "trait_item" => Some("trait"),
                    "type_item" => Some("type"),
                    "mod_item" => Some("module"),
                    "const_item" | "static_item" => Some("constant"),
                    "macro_definition" => Some("macro"),
                    "field_declaration" => Some("field"),
                    _ => None,
                };
            }
            if pattern && matches!(kind, "let_declaration" | "parameter" | "field_declaration") {
                return Some(if kind == "field_declaration" {
                    "field"
                } else {
                    "variable"
                });
            }
        }
        LanguageKind::TypeScript | LanguageKind::JavaScript => {
            if direct {
                return match kind {
                    "function_declaration" | "function" => Some("function"),
                    "class_declaration" | "class" => Some("class"),
                    "interface_declaration" => Some("interface"),
                    "type_alias_declaration" => Some("type"),
                    "enum_declaration" => Some("enum"),
                    "method_definition" | "public_field_definition" => Some("method"),
                    "variable_declarator" => Some("variable"),
                    "import_specifier" | "namespace_import" | "import_clause" => Some("import"),
                    _ => None,
                };
            }
            if pattern
                && matches!(
                    kind,
                    "variable_declarator" | "required_parameter" | "optional_parameter"
                )
            {
                return Some(if kind == "variable_declarator" {
                    "variable"
                } else {
                    "parameter"
                });
            }
            if parameter_node(node) && is_identifier_kind(node.kind()) {
                return Some("parameter");
            }
        }
        LanguageKind::Python => {
            if direct {
                return match kind {
                    "function_definition" => Some("function"),
                    "class_definition" => Some("class"),
                    _ => None,
                };
            }
            if pattern
                && matches!(
                    kind,
                    "assignment"
                        | "for_statement"
                        | "with_item"
                        | "import_statement"
                        | "import_from_statement"
                )
            {
                return Some("variable");
            }
            if parameter_node(node) && is_identifier_kind(node.kind()) {
                return Some("parameter");
            }
        }
        LanguageKind::Go => {
            if direct {
                return match kind {
                    "function_declaration" => Some("function"),
                    "method_declaration" => Some("method"),
                    "type_spec" => Some("type"),
                    "var_spec" | "const_spec" => Some("variable"),
                    "field_declaration" => Some("field"),
                    _ => None,
                };
            }
            if pattern
                && matches!(
                    kind,
                    "var_spec" | "const_spec" | "parameter_declaration" | "short_var_declaration"
                )
            {
                return Some(if kind == "parameter_declaration" {
                    "parameter"
                } else {
                    "variable"
                });
            }
            if parameter_node(node) && is_identifier_kind(node.kind()) {
                return Some("parameter");
            }
        }
    }
    None
}

fn collect_occurrences(
    node: Node<'_>,
    source: &[u8],
    language: LanguageKind,
    definitions: &mut Vec<Occurrence>,
    references: &mut Vec<Occurrence>,
    depth: usize,
) {
    if depth > MAX_AST_DEPTH {
        return;
    }
    if is_identifier_kind(node.kind()) {
        if let Ok(raw) = node.utf8_text(source) {
            let symbol = raw.trim();
            if valid_symbol(symbol) {
                let occurrence = Occurrence {
                    symbol: symbol.to_string(),
                    line: node.start_position().row,
                    character: node.start_position().column,
                    end_character: node.end_position().column,
                    kind: definition_kind(node, language)
                        .unwrap_or("reference")
                        .to_string(),
                };
                if definition_kind(node, language).is_some() {
                    definitions.push(occurrence);
                } else {
                    references.push(occurrence);
                }
            }
        }
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_occurrences(
            child,
            source,
            language,
            definitions,
            references,
            depth.saturating_add(1),
        );
    }
}

fn valid_symbol(symbol: &str) -> bool {
    !symbol.is_empty()
        && symbol.len() <= MAX_SYMBOL_BYTES
        && symbol.chars().all(|character| {
            !character.is_control()
                && !character.is_whitespace()
                && !matches!(character, '(' | ')' | '[' | ']' | '{' | '}' | '"' | '\'')
        })
}

fn deduplicate_occurrences(occurrences: &mut Vec<Occurrence>) {
    occurrences.sort_by(|left, right| {
        left.line
            .cmp(&right.line)
            .then(left.character.cmp(&right.character))
            .then(left.symbol.cmp(&right.symbol))
    });
    occurrences.dedup_by(|left, right| {
        left.line == right.line && left.character == right.character && left.symbol == right.symbol
    });
}
