use crate::local::{default_home_dir, default_shell, is_valid_local_cwd_path};
use crate::ssh::pty::TerminalOutputEvent;
use crate::ssh::terminal_meta::{build_bootstrap_script, is_valid_cwd_path};
use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, Notify};

struct CwdQueryState {
    start_marker: String,
    end_marker: String,
    tx: oneshot::Sender<String>,
}

struct CwdCapture {
    buffer: String,
    pending: Option<CwdQueryState>,
}

impl CwdCapture {
    fn new() -> Self {
        Self {
            buffer: String::new(),
            pending: None,
        }
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
        self.buffer.push_str(chunk);
        let mut display = String::new();

        loop {
            let Some(pending) = self.pending.as_ref() else {
                display.push_str(&self.buffer);
                self.buffer.clear();
                break;
            };

            let start_marker = pending.start_marker.clone();
            let end_marker = pending.end_marker.clone();

            let Some(start) = self.buffer.find(&start_marker) else {
                let keep = partial_prefix_overlap(&self.buffer, &start_marker);
                if keep == 0 {
                    display.push_str(&self.buffer);
                    self.buffer.clear();
                } else if self.buffer.len() > keep {
                    let flush_end = self.buffer.len() - keep;
                    display.push_str(&self.buffer[..flush_end]);
                    self.buffer = self.buffer[flush_end..].to_string();
                }
                break;
            };

            if start > 0 {
                display.push_str(&self.buffer[..start]);
            }

            let after_start = &self.buffer[start + start_marker.len()..];
            let Some(end) = after_start.find(&end_marker) else {
                self.buffer = self.buffer[start..].to_string();
                break;
            };

            let path = after_start[..end].trim().to_string();
            self.buffer = after_start[end + end_marker.len()..].to_string();

            if is_valid_local_cwd_path(&path) {
                if let Some(state) = self.pending.take() {
                    let _ = state.tx.send(path);
                }
            }
        }

        display
    }
}

fn partial_prefix_overlap(text: &str, pattern: &str) -> usize {
    let max = pattern.len().min(text.len());
    for len in (1..=max).rev() {
        if pattern.starts_with(&text[text.len() - len..]) {
            return len;
        }
    }
    0
}

enum IoCommand {
    Input(Vec<u8>),
    Resize(u32, u32),
    Shutdown,
}

pub struct LocalTerminalHandle {
    cmd_tx: SyncSender<IoCommand>,
    writer_thread: Mutex<Option<JoinHandle<()>>>,
    reader_thread: Mutex<Option<JoinHandle<()>>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    child_killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    writer_alive: Arc<AtomicBool>,
    cwd_capture: Arc<Mutex<CwdCapture>>,
    shell_ready: Arc<Notify>,
}

impl LocalTerminalHandle {
    pub fn is_alive(&self) -> bool {
        if !self.writer_alive.load(Ordering::SeqCst) {
            return false;
        }
        let mut child = match self.child.lock() {
            Ok(guard) => guard,
            Err(_) => return false,
        };
        match child.try_wait() {
            Ok(None) => true,
            Ok(Some(_)) => false,
            Err(_) => false,
        }
    }

    pub async fn stop(&self) {
        let _ = self.cmd_tx.send(IoCommand::Shutdown);
        if let Ok(mut killer) = self.child_killer.lock() {
            let _ = killer.kill();
        }

        if let Ok(mut writer) = self.writer_thread.lock() {
            if let Some(handle) = writer.take() {
                let _ = handle.join();
            }
        }
        if let Ok(mut reader) = self.reader_thread.lock() {
            if let Some(handle) = reader.take() {
                let _ = handle.join();
            }
        }
        self.writer_alive.store(false, Ordering::SeqCst);
    }
}

pub async fn query_cwd(terminal: &LocalTerminalHandle) -> Result<String> {
    let token = uuid::Uuid::new_v4().simple().to_string();
    let start_marker = format!("__MXCWD_{token}__");
    let end_marker = format!("__MXEND_{token}__");

    let (tx, rx) = oneshot::channel();
    {
        let mut guard = terminal.cwd_capture.lock().unwrap();
        guard.begin_query(&token, tx);
    }

    let cmd = format!(
        "stty -echo 2>/dev/null; __mx_pwd=\"$(pwd)\"; stty echo 2>/dev/null; printf '{start_marker}%s{end_marker}\\n' \"$__mx_pwd\"\n"
    );
    write_input(terminal, &cmd).await?;

    match tokio::time::timeout(Duration::from_secs(5), rx).await {
        Ok(Ok(path)) if is_valid_local_cwd_path(&path) => Ok(path),
        Ok(Ok(_)) => {
            terminal.cwd_capture.lock().unwrap().clear_pending();
            Err(anyhow!("CWD query returned invalid path"))
        }
        Ok(Err(_)) => {
            terminal.cwd_capture.lock().unwrap().clear_pending();
            Err(anyhow!("CWD query cancelled"))
        }
        Err(_) => {
            terminal.cwd_capture.lock().unwrap().clear_pending();
            Err(anyhow!("CWD query timed out"))
        }
    }
}

pub async fn apply_terminal_state(
    terminal: &LocalTerminalHandle,
    cwd: Option<&str>,
    env: &HashMap<String, String>,
) -> Result<()> {
    let cwd = cwd.filter(|path| is_valid_local_cwd_path(path));
    let script_cwd = cwd.map(|p| if is_valid_cwd_path(p) { p } else { "" });
    let script_cwd = script_cwd.filter(|p| !p.is_empty());
    let Some(script) = build_bootstrap_script(script_cwd, env) else {
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

fn spawn_writer_thread(
    cmd_rx: Receiver<IoCommand>,
    mut writer: Box<dyn Write + Send>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer_alive: Arc<AtomicBool>,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        while let Ok(cmd) = cmd_rx.recv() {
            match cmd {
                IoCommand::Shutdown => break,
                IoCommand::Input(bytes) => {
                    if writer.write_all(&bytes).is_err() {
                        break;
                    }
                    let _ = writer.flush();
                }
                IoCommand::Resize(cols, rows) => {
                    if let Ok(guard) = master.lock() {
                        let _ = guard.resize(PtySize {
                            rows: rows.max(1) as u16,
                            cols: cols.max(1) as u16,
                            pixel_width: 0,
                            pixel_height: 0,
                        });
                    }
                }
            }
        }
        writer_alive.store(false, Ordering::SeqCst);
    })
}

fn spawn_reader_thread(
    mut reader: Box<dyn Read + Send>,
    app: AppHandle,
    session_id: String,
    terminal_id: String,
    cwd_capture: Arc<Mutex<CwdCapture>>,
    shell_ready: Arc<Notify>,
    writer_alive: Arc<AtomicBool>,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut shell_ready_signaled = false;

        while writer_alive.load(Ordering::SeqCst) {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if !shell_ready_signaled {
                        shell_ready_signaled = true;
                        shell_ready.notify_waiters();
                    }

                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    let cleaned = {
                        let mut guard = cwd_capture.lock().unwrap();
                        guard.process_chunk(&text)
                    };
                    if !cleaned.is_empty() {
                        let _ = app.emit(
                            "terminal-output",
                            TerminalOutputEvent {
                                session_id: session_id.clone(),
                                terminal_id: terminal_id.clone(),
                                data: cleaned,
                            },
                        );
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => break,
            }
        }
    })
}

fn configure_shell_command(shell: &str) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(shell);
    cmd.arg("-i");
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd
}

pub async fn create_local_terminal(
    app: AppHandle,
    session_id: String,
    terminal_id: String,
    cols: u32,
    rows: u32,
    initial_cwd: Option<String>,
    initial_env: HashMap<String, String>,
) -> Result<LocalTerminalHandle> {
    let cols = cols.max(1);
    let rows = rows.max(1);
    let home = default_home_dir();
    let shell = default_shell();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows as u16,
            cols: cols as u16,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| anyhow!("Failed to open local PTY: {e}"))?;

    let mut cmd = configure_shell_command(&shell);

    let spawn_cwd = initial_cwd
        .as_ref()
        .filter(|p| is_valid_local_cwd_path(p))
        .cloned()
        .unwrap_or_else(|| home.clone());
    cmd.cwd(&spawn_cwd);

    for (key, value) in &initial_env {
        if !key.is_empty() {
            cmd.env(key, value);
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| anyhow!("Failed to spawn local shell: {e}"))?;
    let child_killer = child.clone_killer();
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| anyhow!("Failed to clone PTY reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| anyhow!("Failed to take PTY writer: {e}"))?;
    let master: Arc<Mutex<Box<dyn MasterPty + Send>>> =
        Arc::new(Mutex::new(pair.master));

    let (cmd_tx, cmd_rx) = mpsc::sync_channel(256);
    let cwd_capture = Arc::new(Mutex::new(CwdCapture::new()));
    let shell_ready = Arc::new(Notify::new());
    let writer_alive = Arc::new(AtomicBool::new(true));

    let writer_thread = spawn_writer_thread(
        cmd_rx,
        writer,
        master.clone(),
        writer_alive.clone(),
    );
    let reader_thread = spawn_reader_thread(
        reader,
        app,
        session_id,
        terminal_id,
        cwd_capture.clone(),
        shell_ready.clone(),
        writer_alive.clone(),
    );

    Ok(LocalTerminalHandle {
        cmd_tx,
        writer_thread: Mutex::new(Some(writer_thread)),
        reader_thread: Mutex::new(Some(reader_thread)),
        child: Mutex::new(child),
        child_killer: Mutex::new(child_killer),
        writer_alive,
        cwd_capture,
        shell_ready,
    })
}

pub async fn write_input(terminal: &LocalTerminalHandle, data: &str) -> Result<()> {
    if !terminal.is_alive() {
        return Err(anyhow!("Local terminal is not running"));
    }
    terminal
        .cmd_tx
        .send(IoCommand::Input(data.as_bytes().to_vec()))
        .map_err(|e| anyhow!("Failed to write to local terminal: {e}"))
}

pub async fn resize_terminal(terminal: &LocalTerminalHandle, cols: u32, rows: u32) -> Result<()> {
    if !terminal.is_alive() {
        return Err(anyhow!("Local terminal is not running"));
    }
    terminal
        .cmd_tx
        .send(IoCommand::Resize(cols, rows))
        .map_err(|e| anyhow!("Failed to resize local terminal: {e}"))
}
