use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

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

/// 折叠 `.` / `..`，避免 `enigma/..` 在 git 探测时仍命中子目录仓库。
pub fn normalize_cwd_path(path: &str) -> Option<String> {
    let path = path.trim();
    if !is_valid_cwd_path(path) || path.starts_with('~') {
        return None;
    }
    if !path.starts_with('/') {
        return None;
    }

    let mut stack: Vec<String> = Vec::new();
    for component in Path::new(path).components() {
        match component {
            std::path::Component::Normal(part) => {
                stack.push(part.to_string_lossy().to_string());
            }
            std::path::Component::ParentDir => {
                stack.pop();
            }
            std::path::Component::CurDir => {}
            std::path::Component::RootDir => {
                stack.clear();
            }
            _ => return None,
        }
    }

    if stack.is_empty() {
        return Some("/".to_string());
    }
    Some(format!("/{}", stack.join("/")))
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

/// Shell 集成：OSC7 cwd + OSC7799 precmd 环境元数据（对齐 Warp precmd 推送）。
fn shell_integration_hook_body() -> &'static str {
    r#"__mx_emit_cwd() {
  printf '\033]7;file://%s%s\033\\' "${HOSTNAME:-localhost}" "$PWD"
}
__mx_emit_meta() {
  local _node="${NVM_ACTIVE_VERSION:-}"
  if [ -z "$_node" ] && command -v node >/dev/null 2>&1; then
    _node=$(node -v 2>/dev/null)
    _node=${_node#v}
  fi
  printf '\033]7799;conda=%s;venv=%s;py=%s;node=%s\033\\' \
    "${CONDA_DEFAULT_ENV:-}" "${VIRTUAL_ENV:-}" "${PYENV_VERSION:-}" "${_node:-}"
}
__mx_precmd() {
  __mx_emit_cwd
  __mx_emit_meta
}
"#
}

/// 写入用户 shell rc 的 hook 正文（多行，供 ZDOTDIR / bash --rcfile 使用）。
pub fn build_cwd_hook_rc_body() -> String {
    let core = shell_integration_hook_body();
    format!(
        r#"{core}
if [ -n "${{ZSH_VERSION:-}}" ]; then
  if typeset -p precmd_functions >/dev/null 2>&1; then
    precmd_functions=(${{precmd_functions:#__mx_precmd}} __mx_precmd)
  else
    precmd_functions=(__mx_precmd)
  fi
else
  case "${{PROMPT_COMMAND:-}}" in
    *__mx_precmd*) ;;
    *) PROMPT_COMMAND="__mx_precmd${{PROMPT_COMMAND:+;$PROMPT_COMMAND}}";;
  esac
fi
__mx_precmd
"#
    )
}

/// 本机 shell 启动时注入 hook 的临时文件（生命周期与 PTY 相同）。
#[derive(Debug)]
pub struct LocalShellHookPaths {
    pub zdotdir: Option<PathBuf>,
    pub bash_rc: Option<PathBuf>,
}

impl LocalShellHookPaths {
    pub fn cleanup(&self) {
        if let Some(dir) = &self.zdotdir {
            let _ = std::fs::remove_dir_all(dir);
        }
        if let Some(rc) = &self.bash_rc {
            let _ = std::fs::remove_file(rc);
        }
    }
}

/// 为本机 zsh/bash 准备启动 rc，避免向 PTY 写入安装命令。
pub fn prepare_local_shell_hook(shell: &str, home: &str) -> std::io::Result<Option<LocalShellHookPaths>> {
    let name = Path::new(shell)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let hook_body = build_cwd_hook_rc_body();
    match name {
        "zsh" => {
            let zdot =
                std::env::temp_dir().join(format!("mx-term-zdot-{}", uuid::Uuid::new_v4().simple()));
            std::fs::create_dir_all(&zdot)?;
            let user_rc = format!("{home}/.zshrc");
            let zshrc = format!("{hook_body}\n[[ -f \"{user_rc}\" ]] && source \"{user_rc}\"\n");
            std::fs::write(zdot.join(".zshrc"), zshrc)?;
            let _ = std::fs::write(zdot.join(".zshenv"), "");
            Ok(Some(LocalShellHookPaths {
                zdotdir: Some(zdot),
                bash_rc: None,
            }))
        }
        "bash" => {
            let rc_path =
                std::env::temp_dir().join(format!("mx-term-bashrc-{}", uuid::Uuid::new_v4().simple()));
            let user_rc = format!("{home}/.bashrc");
            let content = format!("{hook_body}\n[[ -f \"{user_rc}\" ]] && source \"{user_rc}\"\n");
            std::fs::write(&rc_path, content)?;
            Ok(Some(LocalShellHookPaths {
                zdotdir: None,
                bash_rc: Some(rc_path),
            }))
        }
        _ => Ok(None),
    }
}

/// SSH 终端：单行注入 shell precmd（OSC7 + OSC7799），不依赖远程 shell 配置文件。
pub fn build_cwd_hook_script() -> String {
    let core = shell_integration_hook_body().replace('\n', " ");
    format!(
        "{core} \
     if [ -n \"${{ZSH_VERSION:-}}\" ]; then \
       if typeset -p precmd_functions >/dev/null 2>&1; then \
         precmd_functions=(${{precmd_functions:#__mx_precmd}} __mx_precmd); \
       else \
         precmd_functions=(__mx_precmd); \
       fi; \
     else \
       case \"${{PROMPT_COMMAND:-}}\" in *__mx_precmd*) ;; \
         *) PROMPT_COMMAND=\"__mx_precmd${{PROMPT_COMMAND:+;$PROMPT_COMMAND}}\";; \
       esac; \
     fi; \
     __mx_precmd; "
    )
}

/// 安装 hook 的单行命令（base64 解码执行，避免 zsh 回显整段脚本）。
pub fn build_cwd_hook_install_command() -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let mut inner = build_cwd_hook_script();
    inner.push_str("printf '__MX_HOOK_OK__\\n'; ");
    let b64 = STANDARD.encode(inner.as_bytes());
    format!(
        "stty -echo 2>/dev/null; eval \"$(printf '%s' '{b64}' | base64 -D 2>/dev/null || printf '%s' '{b64}' | base64 -d 2>/dev/null)\"; stty echo 2>/dev/null\n"
    )
}

/// 过滤 cwd 探测 / hook 安装命令的回显，避免泄露到前端终端。
pub fn should_suppress_setup_echo(text: &str) -> bool {
    text.contains("__mx_emit_cwd")
        || text.contains("__mx_emit_meta")
        || text.contains("__mx_precmd")
        || text.contains("__MX_HOOK_OK__")
        || text.contains("__MXCWD_")
        || text.contains("__mx_pwd")
        || text.contains("stty -echo")
        || text.contains("stty echo")
        || text.contains("base64 -D")
        || text.contains("base64 -d")
        || text.contains("X19teF9")
        || text.contains("printf '%s'")
        || (text.contains("precmd_functions") && text.contains("__mx"))
        || (text.contains("PROMPT_COMMAND") && text.contains("__mx"))
        || text.contains("typeset -p precmd_functions")
        || (text.contains("eval") && text.contains("base64"))
}

pub fn filter_terminal_setup_echo(text: &str) -> String {
    if should_suppress_setup_echo(text) {
        return String::new();
    }
    let mut out = String::new();
    for line in text.split_inclusive('\n') {
        if should_suppress_setup_echo(line) {
            continue;
        }
        out.push_str(line);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_parent_segments() {
        assert_eq!(
            normalize_cwd_path("/Users/tangxin/Workprojects/enigma/.."),
            Some("/Users/tangxin/Workprojects".to_string())
        );
    }

    #[test]
    fn rejects_shell_command_as_path() {
        assert!(!is_valid_cwd_path("\"$(pwd)\""));
        assert!(!is_valid_cwd_path("$(pwd)"));
        assert!(is_valid_cwd_path("/root"));
    }
}
