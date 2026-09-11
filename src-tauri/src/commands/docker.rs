use crate::ssh::exec::{run_remote_command_with_output, shell_quote};
use crate::state::AppState;
use serde::Deserialize;
use serde_json::Deserializer;
use tauri::State;

/// Non-interactive SSH exec often has a minimal PATH (docker may live in
/// `/usr/local/bin`, Homebrew, or Docker Desktop paths).
/// Use `--noprofile --norc` so login MOTD / .bashrc banners do not pollute JSON.
fn docker_remote_command(docker_args: &str) -> String {
    let inner = format!(
        "PATH=\"/usr/local/bin:/opt/homebrew/bin:/usr/bin:$HOME/bin:$HOME/.docker/bin:$PATH\" \
         docker {docker_args}"
    );
    format!("bash --noprofile --norc -c {}", shell_quote(&inner))
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainerInfo {
    pub id: String,
    pub names: String,
    pub image: String,
    pub status: String,
    pub state: String,
    pub ports: String,
    pub created: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerImageInfo {
    pub id: String,
    pub repository: String,
    pub tag: String,
    pub size: String,
    pub created: String,
}

#[derive(Deserialize)]
struct DockerPsRow {
    #[serde(default, alias = "ID", alias = "Id")]
    id: String,
    #[serde(default, alias = "Names", alias = "Name")]
    names: String,
    #[serde(default, alias = "Image")]
    image: String,
    #[serde(default, alias = "Status")]
    status: String,
    #[serde(default, alias = "State")]
    state: String,
    #[serde(default, alias = "Ports")]
    ports: String,
    #[serde(default, alias = "CreatedAt", alias = "Created")]
    created: String,
}

#[derive(Deserialize)]
struct DockerImagesRow {
    #[serde(default, alias = "ID", alias = "Id")]
    id: String,
    #[serde(default, alias = "Repository")]
    repository: String,
    #[serde(default, alias = "Tag")]
    tag: String,
    #[serde(default, alias = "Size")]
    size: String,
    // docker images JSON may include both CreatedAt and CreatedSince — do not alias them
    // onto one field (serde reports "duplicate field `created`").
    #[serde(default, rename = "CreatedAt")]
    created_at: String,
    #[serde(default, rename = "CreatedSince")]
    created_since: String,
    #[serde(default, rename = "Created")]
    created: String,
}

impl DockerImagesRow {
    fn created_display(&self) -> String {
        if !self.created_at.is_empty() {
            self.created_at.clone()
        } else if !self.created_since.is_empty() {
            self.created_since.clone()
        } else {
            self.created.clone()
        }
    }
}

fn first_nonempty_line(s: &str) -> &str {
    s.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or(s.trim())
}

/// Drop login banners / warnings before the first JSON object.
fn json_payload(raw: &str) -> &str {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return trimmed;
    }
    if let Some(idx) = trimmed.find('{') {
        return &trimmed[idx..];
    }
    trimmed
}

fn snippet_for_error(raw: &str) -> String {
    let compact = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= 160 {
        compact
    } else {
        let truncated: String = compact.chars().take(160).collect();
        format!("{truncated}…")
    }
}

/// Parse one or more JSON values from docker `--format '{{json .}}'` output.
/// Docker may emit NDJSON (one object per line) or pack several objects on one line.
fn parse_json_stream<T: for<'de> Deserialize<'de>>(raw: &str) -> Result<Vec<T>, String> {
    let payload = json_payload(raw);
    if payload.is_empty() {
        return Ok(Vec::new());
    }
    if !payload.starts_with('{') {
        return Err(format!(
            "解析 docker 输出失败: 不是 JSON（开头: {}）",
            snippet_for_error(payload)
        ));
    }

    let mut out = Vec::new();
    let mut de = Deserializer::from_str(payload).into_iter::<T>();
    while let Some(item) = de.next() {
        match item {
            Ok(v) => out.push(v),
            Err(e) => {
                if out.is_empty() {
                    return Err(format!(
                        "解析 docker 输出失败: {e}（开头: {}）",
                        snippet_for_error(payload)
                    ));
                }
                // Trailing noise after valid JSON (e.g. stderr warnings) — keep what we got.
                break;
            }
        }
    }
    Ok(out)
}

fn docker_failure_message(exit_code: i32, stdout: &str, stderr: &str) -> String {
    let detail = first_nonempty_line(stderr);
    let detail = if detail.is_empty() {
        first_nonempty_line(stdout)
    } else {
        detail
    };
    if exit_code == 127
        || detail.contains("command not found")
        || detail.contains("not found")
    {
        return "未找到 docker 命令。请确认当前 SSH 主机已安装 Docker，\
                且 PATH 中可执行 `docker`。"
            .to_string();
    }
    if detail.is_empty() {
        format!("docker 命令失败 (exit {exit_code})")
    } else {
        format!("docker 命令失败 (exit {exit_code}): {detail}")
    }
}

fn map_docker_list_result<T, R, F>(
    exit_code: i32,
    stdout: &str,
    stderr: &str,
    map_row: F,
) -> Result<Vec<R>, String>
where
    T: for<'de> Deserialize<'de>,
    F: Fn(T) -> R,
{
    match parse_json_stream::<T>(stdout) {
        Ok(rows) if !rows.is_empty() || exit_code == 0 => Ok(rows.into_iter().map(map_row).collect()),
        Ok(_) => Err(docker_failure_message(exit_code, stdout, stderr)),
        Err(parse_err) => {
            if exit_code != 0 {
                Err(docker_failure_message(exit_code, stdout, stderr))
            } else {
                Err(parse_err)
            }
        }
    }
}

#[tauri::command]
pub async fn docker_list_containers(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<DockerContainerInfo>, String> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Session not found".to_string())?
        .clone();
    drop(sessions);

    let result = run_remote_command_with_output(
        &session,
        &docker_remote_command(r#"ps -a --format "{{json .}}""#),
    )
    .await
    .map_err(|e| e.to_string())?;

    map_docker_list_result::<DockerPsRow, _, _>(
        result.exit_code,
        &result.stdout,
        &result.stderr,
        |row| DockerContainerInfo {
            id: row.id,
            names: row.names.trim_start_matches('/').to_string(),
            image: row.image,
            status: row.status,
            state: row.state,
            ports: row.ports,
            created: row.created,
        },
    )
}

#[tauri::command]
pub async fn docker_list_images(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<DockerImageInfo>, String> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Session not found".to_string())?
        .clone();
    drop(sessions);

    let result = run_remote_command_with_output(
        &session,
        &docker_remote_command(r#"images --format "{{json .}}""#),
    )
    .await
    .map_err(|e| e.to_string())?;

    map_docker_list_result::<DockerImagesRow, _, _>(
        result.exit_code,
        &result.stdout,
        &result.stderr,
        |row| {
            let created = row.created_display();
            DockerImageInfo {
                id: row.id,
                repository: row.repository,
                tag: row.tag,
                size: row.size,
                created,
            }
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ndjson() {
        let raw = r#"{"ID":"abc","Names":"/foo","Image":"img","Status":"Up","State":"running","Ports":"","CreatedAt":"now"}
{"ID":"def","Names":"/bar","Image":"img2","Status":"Exited (2) ago","State":"exited","Ports":"","CreatedAt":"then"}
"#;
        let rows = parse_json_stream::<DockerPsRow>(raw).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].names, "/foo");
        assert_eq!(rows[1].state, "exited");
    }

    #[test]
    fn parses_concatenated_objects_on_one_line() {
        let raw = r#"{"ID":"a","Names":"n1","Image":"i","Status":"Exited (2) 24 hours ago","State":"exited","Ports":"","CreatedAt":"x"} {"ID":"b","Names":"n2","Image":"i","Status":"Up","State":"running","Ports":"","CreatedAt":"y"}"#;
        let rows = parse_json_stream::<DockerPsRow>(raw).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "a");
        assert_eq!(rows[1].id, "b");
    }

    #[test]
    fn parses_images_with_created_at_and_created_since() {
        let raw = r#"{"Containers":"N/A","CreatedAt":"2026-07-15 14:04:43 +0800 CST","CreatedSince":"2 days ago","Digest":"<none>","ID":"501e1f14a0aa","Repository":"debian","SharedSize":"N/A","Size":"743MB","Tag":"buster","UniqueSize":"N/A","VirtualSize":"742.8MB"}"#;
        let rows = parse_json_stream::<DockerImagesRow>(raw).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].repository, "debian");
        assert_eq!(rows[0].created_display(), "2026-07-15 14:04:43 +0800 CST");
    }

    #[test]
    fn skips_banner_before_json() {
        let raw = "Welcome to Ubuntu\nLast login: today\n{\"ID\":\"abc\",\"Names\":\"/foo\",\"Image\":\"img\",\"Status\":\"Up\",\"State\":\"running\",\"Ports\":\"\",\"CreatedAt\":\"now\"}\n";
        let rows = parse_json_stream::<DockerPsRow>(raw).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "abc");
    }

    #[test]
    fn empty_stdout_is_ok() {
        let rows = parse_json_stream::<DockerPsRow>("").unwrap();
        assert!(rows.is_empty());
    }

    #[test]
    fn non_json_error_includes_snippet() {
        let err = match parse_json_stream::<DockerPsRow>("Cannot connect to the Docker daemon") {
            Ok(_) => panic!("expected parse error"),
            Err(e) => e,
        };
        assert!(err.contains("不是 JSON"));
        assert!(err.contains("Cannot connect"));
    }
}
