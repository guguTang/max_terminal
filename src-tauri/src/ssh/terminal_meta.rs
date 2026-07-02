use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMeta {
    pub cwd: String,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

pub fn is_valid_cwd_path(path: &str) -> bool {
    let path = path.trim();
    if path.is_empty() {
        return false;
    }
    if path.contains('$') || path.contains('"') || path.contains('`') {
        return false;
    }
    path.starts_with('/') || path.starts_with('~')
}

pub fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub fn build_bootstrap_script(cwd: Option<&str>, env: &HashMap<String, String>) -> Option<String> {
    let cwd = cwd.filter(|path| is_valid_cwd_path(path));
    if cwd.is_none() && env.is_empty() {
        return None;
    }

    let mut script = String::new();
    for (key, value) in env {
        if key.is_empty() {
            continue;
        }
        script.push_str(&format!(
            "export {}={}; ",
            key,
            shell_single_quote(value)
        ));
    }
    if let Some(cwd) = cwd {
        script.push_str(&format!("cd -- {}; ", shell_single_quote(cwd)));
    }
    script.push('\n');
    Some(script)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_shell_command_as_path() {
        assert!(!is_valid_cwd_path("\"$(pwd)\""));
        assert!(!is_valid_cwd_path("$(pwd)"));
        assert!(is_valid_cwd_path("/root"));
    }
}
