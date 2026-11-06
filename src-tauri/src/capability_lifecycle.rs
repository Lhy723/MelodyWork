use std::collections::HashSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CapabilityKind {
    Skill,
    Plugin,
}

impl CapabilityKind {
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value {
            "skills" => Ok(Self::Skill),
            "plugins" => Ok(Self::Plugin),
            _ => Err("Only skills and plugins can be enabled or disabled".to_string()),
        }
    }

    pub(crate) fn config_key(self) -> &'static str {
        match self {
            Self::Skill => "skills",
            Self::Plugin => "plugins",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct CapabilityStateUpdate {
    pub(crate) disabled: Vec<String>,
    pub(crate) explicitly_enabled: Option<Vec<String>>,
}

pub(crate) fn capability_name(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.is_empty() {
        Err("Extension name cannot be empty".to_string())
    } else {
        Ok(value)
    }
}

pub(crate) fn change_capability_state(
    kind: CapabilityKind,
    name: &str,
    enabled: bool,
    mut disabled: HashSet<String>,
    mut explicitly_enabled: HashSet<String>,
) -> CapabilityStateUpdate {
    if enabled {
        disabled.remove(name);
    } else {
        disabled.insert(name.to_string());
    }

    let explicitly_enabled = if kind == CapabilityKind::Plugin {
        if enabled {
            explicitly_enabled.insert(name.to_string());
        } else {
            explicitly_enabled.remove(name);
        }
        Some(sorted(explicitly_enabled))
    } else {
        None
    };

    CapabilityStateUpdate {
        disabled: sorted(disabled),
        explicitly_enabled,
    }
}

fn sorted(values: HashSet<String>) -> Vec<String> {
    let mut values = values.into_iter().collect::<Vec<_>>();
    values.sort();
    values
}
