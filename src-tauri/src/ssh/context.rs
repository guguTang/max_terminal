use crate::local::LOCAL_SESSION_ID;
use crate::ssh::exec::{run_remote_command_with_output, shell_quote};
use crate::ssh::session::SharedSession;
use crate::ssh::sftp::read_file;
use crate::ssh::terminal_meta::{is_valid_cwd_path, normalize_cwd_path};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitContext {
    pub branch: String,
    pub dirty_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SvnContext {
    pub branch: Option<String>,
    pub dirty_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct K8sContext {
    pub context: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PyenvContext {
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NodeContext {
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TerminalContextResult {
    pub git: Option<GitContext>,
    pub svn: Option<SvnContext>,
    pub k8s: Option<K8sContext>,
    pub pyenv: Option<PyenvContext>,
    pub node: Option<NodeContext>,
}

pub async fn query_terminal_context(
    session_id: &str,
    session: Option<&SharedSession>,
    cwd: &str,
    env: &HashMap<String, String>,
    providers: &[String],
) -> Result<TerminalContextResult> {
    let Some(cwd) = normalize_cwd_path(cwd) else {
        return Ok(TerminalContextResult::default());
    };

    let mut result = TerminalContextResult::default();
    let is_local = session_id == LOCAL_SESSION_ID;

    for provider in providers {
        match provider.as_str() {
            "git" => {
                if let Some(ctx) = query_git(session, &cwd, is_local).await? {
                    result.git = Some(ctx);
                }
            }
            "git_dirty" => {
                if let Some(dirty_count) =
                    query_git_dirty_for_cwd(session, &cwd, is_local).await?
                {
                    result.git = Some(GitContext {
                        branch: String::new(),
                        dirty_count,
                    });
                }
            }
            "svn" => {
                if let Some(ctx) = query_svn(session, &cwd, is_local).await? {
                    result.svn = Some(ctx);
                }
            }
            "k8s" => {
                if let Some(ctx) = query_k8s(session, env, is_local).await? {
                    result.k8s = Some(ctx);
                }
            }
            "pyenv" => {
                if let Some(version) = env.get("PYENV_VERSION").filter(|v| !v.is_empty()) {
                    result.pyenv = Some(PyenvContext {
                        version: version.clone(),
                    });
                } else if let Some(ctx) = query_pyenv(session, &cwd, is_local).await? {
                    result.pyenv = Some(ctx);
                }
            }
            "node" => {
                if let Some(ctx) = query_node(session, &cwd, env, is_local).await? {
                    result.node = Some(ctx);
                }
            }
            _ => {}
        }
    }

    Ok(result)
}

struct ShellOutput {
    stdout: String,
    exit_code: i32,
}

async fn run_in_cwd(
    session: Option<&SharedSession>,
    cwd: &str,
    script: &str,
    is_local: bool,
) -> Result<ShellOutput> {
    let q = shell_quote(cwd);
    let inner = format!("cd {q} && {script}");
    let wrapped = format!(
        "bash -lc {} 2>/dev/null || sh -lc {}",
        shell_quote(&inner),
        shell_quote(&inner)
    );
    run_shell(session, &wrapped, is_local).await
}

async fn run_shell(
    session: Option<&SharedSession>,
    command: &str,
    is_local: bool,
) -> Result<ShellOutput> {
    let command = if is_local {
        command.to_string()
    } else {
        format!(
            "export PATH=\"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH\"; {command}"
        )
    };

    if is_local {
        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg(&command)
            .output()
            .map_err(|e| anyhow!("local exec failed: {e}"))?;
        Ok(ShellOutput {
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            exit_code: output.status.code().unwrap_or(1),
        })
    } else {
        let session = session.ok_or_else(|| anyhow!("SSH session required"))?;
        let result = run_remote_command_with_output(session, &command).await?;
        Ok(ShellOutput {
            stdout: result.output,
            exit_code: result.exit_code,
        })
    }
}

async fn read_dotfile(
    session: Option<&SharedSession>,
    path: &str,
    is_local: bool,
) -> Option<String> {
    if is_local {
        std::fs::read_to_string(path).ok()
    } else {
        let session = session?;
        read_file(session, path).await.ok()
    }
}

async fn query_git(
    session: Option<&SharedSession>,
    cwd: &str,
    is_local: bool,
) -> Result<Option<GitContext>> {
    if let Some(ctx) = query_git_via_head(session, cwd, is_local).await {
        return Ok(Some(ctx));
    }
    query_git_exec(session, cwd, is_local).await
}

async fn query_git_exec(
    session: Option<&SharedSession>,
    cwd: &str,
    is_local: bool,
) -> Result<Option<GitContext>> {
    let q = shell_quote(cwd);
    let script = format!(
        "git -C {q} rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 1; \
         branch=$(git -C {q} branch --show-current 2>/dev/null); \
         if [ -z \"$branch\" ]; then branch=$(git -C {q} rev-parse --abbrev-ref HEAD 2>/dev/null); fi; \
         if [ \"$branch\" = \"HEAD\" ]; then short=$(git -C {q} rev-parse --short HEAD 2>/dev/null); branch=\"detached:${{short}}\"; fi; \
         dirty=$(git -C {q} status --porcelain 2>/dev/null | wc -l | tr -d ' '); \
         printf '%s\\n%s' \"$branch\" \"$dirty\""
    );
    let wrapped = format!(
        "bash -lc {} 2>/dev/null || sh -lc {}",
        shell_quote(&script),
        shell_quote(&script)
    );
    let ShellOutput { stdout, exit_code } = match run_shell(session, &wrapped, is_local).await {
        Ok(o) => o,
        Err(_) => return Ok(None),
    };
    if exit_code != 0 {
        return Ok(None);
    }
    parse_git_exec_output(&stdout)
}

fn parse_git_exec_output(stdout: &str) -> Result<Option<GitContext>> {
    let mut lines = stdout.lines();
    let branch = lines.next().unwrap_or("").trim().to_string();
    let dirty_str = lines.next().unwrap_or("0").trim();
    if branch.is_empty() {
        return Ok(None);
    }
    Ok(Some(GitContext {
        branch,
        dirty_count: dirty_str.parse().unwrap_or(0),
    }))
}

fn parse_git_head(content: &str) -> Option<String> {
    let line = content.trim();
    if let Some(name) = line.strip_prefix("ref: refs/heads/") {
        let name = name.trim();
        if !name.is_empty() {
            return Some(name.to_string());
        }
    }
    if line.len() >= 7 && !line.contains(' ') {
        return Some(format!("detached:{}", &line[..7]));
    }
    None
}

fn parent_dir(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() || trimmed == "/" {
        return None;
    }
    Path::new(trimmed)
        .parent()
        .map(|p| {
            let s = p.to_string_lossy().to_string();
            if s.is_empty() {
                "/".to_string()
            } else {
                s
            }
        })
}

async fn query_git_via_head(
    session: Option<&SharedSession>,
    cwd: &str,
    is_local: bool,
) -> Option<GitContext> {
    let mut current = cwd.trim_end_matches('/').to_string();
    if current.is_empty() {
        current = "/".to_string();
    }

    loop {
        let head_path = format!("{current}/.git/HEAD");
        if let Some(content) = read_dotfile(session, &head_path, is_local).await {
            if let Some(branch) = parse_git_head(&content) {
                return Some(GitContext {
                    branch,
                    dirty_count: 0,
                });
            }
        }

        let Some(parent) = parent_dir(&current) else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent;
    }
    None
}

async fn query_git_dirty_for_cwd(
    session: Option<&SharedSession>,
    cwd: &str,
    is_local: bool,
) -> Result<Option<u32>> {
    let mut current = cwd.trim_end_matches('/').to_string();
    if current.is_empty() {
        current = "/".to_string();
    }

    loop {
        let head_path = format!("{current}/.git/HEAD");
        if read_dotfile(session, &head_path, is_local).await.is_some() {
            let dirty_count = query_git_dirty(session, &current, is_local).await?;
            return Ok(Some(dirty_count));
        }

        let Some(parent) = parent_dir(&current) else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent;
    }
    Ok(None)
}

async fn query_git_dirty(
    session: Option<&SharedSession>,
    repo_root: &str,
    is_local: bool,
) -> Result<u32> {
    let q = shell_quote(repo_root);
    let script = format!(
        "git -C {q} status --porcelain 2>/dev/null | wc -l | tr -d ' '"
    );
    let wrapped = format!(
        "bash -lc {} 2>/dev/null || sh -lc {}",
        shell_quote(&script),
        shell_quote(&script)
    );
    let ShellOutput { stdout, exit_code } = run_shell(session, &wrapped, is_local).await?;
    if exit_code != 0 {
        return Ok(0);
    }
    Ok(stdout.trim().parse().unwrap_or(0))
}

async fn query_svn(
    session: Option<&SharedSession>,
    cwd: &str,
    is_local: bool,
) -> Result<Option<SvnContext>> {
    let script = r#"svn info --show-item relative-url >/dev/null 2>&1 || exit 1
branch=$(svn info --show-item relative-url 2>/dev/null | sed 's|^/||')
dirty=$(svn status 2>/dev/null | grep -c '^[^?]' || echo 0)
printf '%s\n%s' "$branch" "$dirty""#;
    let ShellOutput { stdout, exit_code } = match run_in_cwd(session, cwd, script, is_local).await {
        Ok(o) => o,
        Err(_) => return Ok(None),
    };
    if exit_code != 0 {
        return Ok(None);
    }
    let mut lines = stdout.lines();
    let branch_line = lines.next().unwrap_or("").trim();
    if branch_line.is_empty() {
        return Ok(None);
    }
    let dirty_count = lines
        .next()
        .unwrap_or("0")
        .trim()
        .parse()
        .unwrap_or(0);
    Ok(Some(SvnContext {
        branch: Some(branch_line.to_string()),
        dirty_count,
    }))
}

async fn query_k8s(
    session: Option<&SharedSession>,
    env: &HashMap<String, String>,
    is_local: bool,
) -> Result<Option<K8sContext>> {
    let mut prefix = String::new();
    if let Some(kubeconfig) = env.get("KUBECONFIG").filter(|v| !v.is_empty()) {
        prefix = format!("KUBECONFIG={} ", shell_quote(kubeconfig));
    }
    let script = format!(
        "{prefix}kubectl config current-context 2>/dev/null"
    );
    let ShellOutput { stdout, exit_code } = run_shell(session, &script, is_local)
        .await
        .unwrap_or(ShellOutput {
            stdout: String::new(),
            exit_code: 1,
        });
    let context = stdout.trim().to_string();
    if exit_code != 0 || context.is_empty() {
        return Ok(None);
    }
    Ok(Some(K8sContext { context }))
}

async fn query_pyenv(
    session: Option<&SharedSession>,
    cwd: &str,
    is_local: bool,
) -> Result<Option<PyenvContext>> {
    let path = Path::new(cwd).join(".python-version");
    let content = read_dotfile(session, &path.to_string_lossy(), is_local)
        .await
        .map(|s| s.lines().next().unwrap_or("").trim().to_string())
        .filter(|s| !s.is_empty());
    Ok(content.map(|version| PyenvContext { version }))
}

async fn query_node(
    session: Option<&SharedSession>,
    cwd: &str,
    _env: &HashMap<String, String>,
    is_local: bool,
) -> Result<Option<NodeContext>> {
    for name in [".nvmrc", ".node-version"] {
        let path = Path::new(cwd).join(name);
        if let Some(content) = read_dotfile(session, &path.to_string_lossy(), is_local).await {
            let version = content.lines().next().unwrap_or("").trim().to_string();
            if !version.is_empty() {
                return Ok(Some(NodeContext { version }));
            }
        }
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_cwd() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(query_terminal_context(
            LOCAL_SESSION_ID,
            None,
            "$(pwd)",
            &HashMap::new(),
            &["git".to_string()],
        ));
        assert!(result.unwrap().git.is_none());
    }

    #[test]
    fn parses_git_head_ref() {
        assert_eq!(
            parse_git_head("ref: refs/heads/main\n"),
            Some("main".to_string())
        );
    }

    #[test]
    fn finds_git_in_enigma_repo() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let cwd = "/Users/tangxin/Workprojects/enigma";
        let ctx = rt.block_on(query_terminal_context(
            LOCAL_SESSION_ID,
            None,
            cwd,
            &HashMap::new(),
            &["git".to_string()],
        ));
        let result = ctx.unwrap();
        assert!(result.git.is_some(), "git should be detected at enigma path");
        assert_eq!(result.git.as_ref().unwrap().branch, "develop");
    }
}
