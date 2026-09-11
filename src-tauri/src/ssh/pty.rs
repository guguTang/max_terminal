use crate::ssh::handler::SshHandler;
use crate::ssh::terminal_meta::{
    build_bootstrap_script, build_cwd_hook_install_command, filter_terminal_setup_echo,
    is_valid_cwd_path,
};
use anyhow::{anyhow, Result};
use russh::{client, ChannelMsg};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot, Mutex, Notify};
use tokio::task::JoinHandle;

struct CwdQueryState {
    start_marker: String,
    end_marker: String,
    tx: oneshot::Sender<String>,
}

struct CwdCapture {
    buffer: String,
    pending: Option<CwdQueryState>,
    hook_installing: bool,
}

impl CwdCapture {
    fn new() -> Self {
        Self {
            buffer: String::new(),
            pending: None,
            hook_installing: false,
        }
    }

    fn begin_hook_install(&mut self) {
        self.hook_installing = true;
        self.buffer.clear();
    }

    fn end_hook_install(&mut self) {
        self.hook_installing = false;
        self.buffer.clear();
    }

    fn is_hook_installing(&self) -> bool {
        self.hook_installing
    }

    fn begin_query(&mut self, token: &str, tx: oneshot::Sender<String>) {
        self.pending = Some(CwdQueryState {
            start_marker: format!("__MXCWD_{token}__"),
            end_marker: format!("__MXEND_{token}__"),
            tx,
        });
    }

    fn clear_pending(&mut self) {
        self.pending = None;
    }

    fn process_chunk(&mut self, chunk: &str) -> String {
        if self.hook_installing {
            self.buffer.push_str(chunk);
            if self.buffer.contains("__MX_HOOK_OK__") || self.buffer.contains("\x1b]7;file://") || self.buffer.contains("\x1b]7799;") {
                self.hook_installing = false;
                self.buffer.clear();
            }
            return String::new();
        }

        self.buffer.push_str(chunk);
        let mut display = String::new();

        loop {
            let Some(pending) = self.pending.as_ref() else {
                display.push_str(&filter_terminal_setup_echo(&self.buffer));
                self.buffer.clear();
                break;
            };

            let start_marker = pending.start_marker.clone();
            let end_marker = pending.end_marker.clone();

            let Some(start) = self.buffer.find(&start_marker) else {
                let keep = partial_prefix_overlap(&self.buffer, &start_marker);
                if keep == 0 {
                    let flushed = filter_terminal_setup_echo(&self.buffer);
                    display.push_str(&flushed);
                    self.buffer.clear();
                } else if self.buffer.len() > keep {
                    let flush_end = self.buffer.len() - keep;
                    let flushed = filter_terminal_setup_echo(&self.buffer[..flush_end]);
                    display.push_str(&flushed);
                    self.buffer = self.buffer[flush_end..].to_string();
                }
                break;
            };

            if start > 0 {
                display.push_str(&filter_terminal_setup_echo(&self.buffer[..start]));
            }

            let after_start = &self.buffer[start + start_marker.len()..];
            let Some(end) = after_start.find(&end_marker) else {
                self.buffer = self.buffer[start..].to_string();
                break;
            };

            let path = after_start[..end].trim().to_string();
            self.buffer = after_start[end + end_marker.len()..].to_string();

            if is_valid_cwd_path(&path) {
                if let Some(state) = self.pending.take() {
                    let _ = state.tx.send(path);
                }
            }
        }

        display
    }
}

/// 仅保留可能是 marker 前缀的尾部，避免吞掉正常终端输出。
fn partial_prefix_overlap(text: &str, pattern: &str) -> usize {
    let max = pattern.len().min(text.len());
    for len in (1..=max).rev() {
        if pattern.starts_with(&text[text.len() - len..]) {
            return len;
        }
    }
    0
}

pub struct TerminalHandle {
    stdin_tx: mpsc::UnboundedSender<Vec<u8>>,
    resize_tx: mpsc::UnboundedSender<(u32, u32)>,
    shutdown_tx: mpsc::UnboundedSender<()>,
    reader: JoinHandle<()>,
    cwd_capture: Arc<Mutex<CwdCapture>>,
    shell_ready: Arc<Notify>,
}

impl TerminalHandle {
    pub fn is_alive(&self) -> bool {
        !self.reader.is_finished()
    }

    pub async fn stop(&self) {
        let _ = self.shutdown_tx.send(());
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            while !self.reader.is_finished() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await;
        if !self.reader.is_finished() {
            self.reader.abort();
        }
    }
}

pub async fn query_cwd(terminal: &TerminalHandle) -> Result<String> {
    let token = uuid::Uuid::new_v4().simple().to_string();
    let start_marker = format!("__MXCWD_{token}__");
    let end_marker = format!("__MXEND_{token}__");

    let (tx, rx) = oneshot::channel();
    {
        let mut guard = terminal.cwd_capture.lock().await;
        guard.begin_query(&token, tx);
    }

    // 整段探测在单行内完成，减少 stty 命令被分步回显。
    let cmd = format!(
        "stty -echo 2>/dev/null; __mx_pwd=\"$(pwd)\"; stty echo 2>/dev/null; printf '{start_marker}%s{end_marker}\\n' \"$__mx_pwd\"\n"
    );
    write_input(terminal, &cmd).await?;

    let result = match tokio::time::timeout(Duration::from_secs(5), rx).await {
        Ok(Ok(path)) if is_valid_cwd_path(&path) => Ok(path),
        Ok(Ok(_)) => {
            terminal.cwd_capture.lock().await.clear_pending();
            Err(anyhow!("CWD query returned invalid path"))
        }
        Ok(Err(_)) => {
            terminal.cwd_capture.lock().await.clear_pending();
            Err(anyhow!("CWD query cancelled"))
        }
        Err(_) => {
            terminal.cwd_capture.lock().await.clear_pending();
            Err(anyhow!("CWD query timed out"))
        }
    };

    result
}

pub async fn apply_terminal_state(
    terminal: &TerminalHandle,
    cwd: Option<&str>,
    env: &HashMap<String, String>,
) -> Result<()> {
    let cwd = cwd.filter(|path| is_valid_cwd_path(path));
    let Some(script) = build_bootstrap_script(cwd, env) else {
        return Ok(());
    };

    match tokio::time::timeout(Duration::from_secs(8), terminal.shell_ready.notified()).await {
        Ok(()) => {}
        Err(_) => {
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
    }

    tokio::time::sleep(Duration::from_millis(150)).await;
    write_input(terminal, &script).await
}

pub async fn install_cwd_hook(terminal: &TerminalHandle) -> Result<()> {
    match tokio::time::timeout(Duration::from_secs(8), terminal.shell_ready.notified()).await {
        Ok(()) => {}
        Err(_) => {
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
    }

    tokio::time::sleep(Duration::from_millis(150)).await;
    {
        let mut guard = terminal.cwd_capture.lock().await;
        guard.begin_hook_install();
    }
    write_input(terminal, &build_cwd_hook_install_command()).await?;
    for _ in 0..150 {
        let done = {
            let guard = terminal.cwd_capture.lock().await;
            !guard.is_hook_installing()
        };
        if done {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    {
        let mut guard = terminal.cwd_capture.lock().await;
        guard.end_hook_install();
    }
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputEvent {
    pub session_id: String,
    pub terminal_id: String,
    pub data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalClosedEvent {
    pub session_id: String,
    pub terminal_id: String,
}

pub async fn create_terminal(
    handle: &mut client::Handle<SshHandler>,
    app: AppHandle,
    session_id: String,
    terminal_id: String,
    cols: u32,
    rows: u32,
) -> Result<TerminalHandle> {
    let cols = cols.max(1);
    let rows = rows.max(1);

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| {
            let detail = e.to_string();
            if detail.contains("ConnectFailed") {
                anyhow!(
                    "Failed to open terminal channel: server refused new shell session (often sshd MaxSessions); reconnect and retry"
                )
            } else {
                anyhow!("Failed to open terminal channel: {detail}")
            }
        })?;

    channel
        .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
        .await
        .map_err(|e| anyhow!("Failed to request PTY: {e}"))?;
    channel
        .request_shell(false)
        .await
        .map_err(|e| anyhow!("Failed to start shell: {e}"))?;

    let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (resize_tx, mut resize_rx) = mpsc::unbounded_channel::<(u32, u32)>();
    let (shutdown_tx, mut shutdown_rx) = mpsc::unbounded_channel::<()>();
    let reader_session_id = session_id.clone();
    let reader_terminal_id = terminal_id.clone();
    let cwd_capture = Arc::new(Mutex::new(CwdCapture::new()));
    let reader_cwd_capture = cwd_capture.clone();
    let shell_ready = Arc::new(Notify::new());
    let reader_shell_ready = shell_ready.clone();
    let mut shell_ready_signaled = false;

    let reader = tokio::spawn(async move {
        let mut channel = channel;
        let mut unexpected_close = false;
        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => {
                    let _ = channel.eof().await;
                    let _ = channel.close().await;
                    break;
                }
                data = stdin_rx.recv() => {
                    match data {
                        Some(bytes) => {
                            if channel.data(&bytes[..]).await.is_err() {
                                unexpected_close = true;
                                break;
                            }
                        }
                        None => break,
                    }
                }
                resize = resize_rx.recv() => {
                    match resize {
                        Some((cols, rows)) => {
                            let _ = channel.window_change(cols, rows, 0, 0).await;
                        }
                        None => break,
                    }
                }
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                            if !shell_ready_signaled {
                                shell_ready_signaled = true;
                                reader_shell_ready.notify_waiters();
                            }

                            let text = String::from_utf8_lossy(&data).to_string();
                            let cleaned = {
                                let mut guard = reader_cwd_capture.lock().await;
                                guard.process_chunk(&text)
                            };
                            if !cleaned.is_empty() {
                                let _ = app.emit(
                                    "terminal-output",
                                    TerminalOutputEvent {
                                        session_id: reader_session_id.clone(),
                                        terminal_id: reader_terminal_id.clone(),
                                        data: cleaned,
                                    },
                                );
                            }
                        }
                        Some(ChannelMsg::ExitStatus { .. }) | None => {
                            unexpected_close = true;
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }
        if unexpected_close {
            let _ = app.emit(
                "terminal-closed",
                TerminalClosedEvent {
                    session_id: reader_session_id,
                    terminal_id: reader_terminal_id,
                },
            );
        }
    });

    Ok(TerminalHandle {
        stdin_tx,
        resize_tx,
        shutdown_tx,
        reader,
        cwd_capture,
        shell_ready,
    })
}

pub async fn write_input(terminal: &TerminalHandle, data: &str) -> Result<()> {
    if !terminal.is_alive() {
        return Err(anyhow!("Terminal channel closed"));
    }
    terminal
        .stdin_tx
        .send(data.as_bytes().to_vec())
        .map_err(|e| anyhow!("Failed to write to terminal: {e}"))
}

pub async fn resize_terminal(terminal: &TerminalHandle, cols: u32, rows: u32) -> Result<()> {
    if !terminal.is_alive() {
        return Err(anyhow!("Terminal channel closed"));
    }
    terminal
        .resize_tx
        .send((cols, rows))
        .map_err(|e| anyhow!("Failed to resize terminal: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cwd_capture_flushes_prompt_without_holding_suffix() {
        let mut capture = CwdCapture::new();
        let prompt = "(base) [root@k8s-master-34 ~]# ";
        let out = capture.process_chunk(prompt);
        assert_eq!(out, prompt);
        assert!(capture.buffer.is_empty());
    }

    #[test]
    fn cwd_capture_suppresses_probe_echo() {
        let mut capture = CwdCapture::new();
        let (tx, _rx) = tokio::sync::oneshot::channel();
        capture.begin_query("abc123", tx);

        let echo = "(base) [root@k8s-master-34 ~]# stty -echo 2>/dev/null\n";
        let out = capture.process_chunk(echo);
        assert_eq!(out, "");

        let response = "__MXCWD_abc123__/root__MXEND_abc123__\n";
        let out = capture.process_chunk(response);
        assert_eq!(out, "\n");
    }

    #[test]
    fn cwd_capture_ignores_false_positive_from_command_echo() {
        let mut capture = CwdCapture::new();
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        capture.begin_query("abc123", tx);

        let echo = "printf \"%s%s%s\\n\" \"__MAXPWD__\" \"$(pwd)\" \"__MXEND__\"\n";
        let out = capture.process_chunk(echo);
        assert_eq!(out, echo);
        assert!(rx.try_recv().is_err());

        let response = "__MXCWD_abc123__/root__MXEND_abc123__\n";
        let out = capture.process_chunk(response);
        assert_eq!(out, "\n");
        assert_eq!(rx.try_recv().unwrap(), "/root");
    }

    #[test]
    fn partial_prefix_overlap_only_when_needed() {
        assert_eq!(partial_prefix_overlap("hello", "__MXCWD_x__"), 0);
        assert_eq!(partial_prefix_overlap("__MXCWD", "__MXCWD_x__"), 7);
    }
}
