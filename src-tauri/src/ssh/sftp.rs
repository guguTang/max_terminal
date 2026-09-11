use crate::ssh::session::{sftp_io_lock, SharedSession};
use anyhow::{anyhow, Result};
use russh_sftp::client::fs::File as SftpFile;
use russh_sftp::protocol::FileType;
use serde::Serialize;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const MAX_READ_BYTES: usize = 2 * 1024 * 1024;
/// Larger chunks cut SFTP round-trips; still below typical max packet aggregation.
const TRANSFER_CHUNK_SIZE: usize = 512 * 1024;
/// Avoid hammering the UI / transfer task mutex on every chunk.
const PROGRESS_REPORT_EVERY_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy)]
pub struct TransferProgress {
    pub phase: &'static str,
    pub loaded_bytes: u64,
    pub total_bytes: Option<u64>,
}

pub(crate) fn ensure_not_cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(anyhow!("Cancelled"))
    } else {
        Ok(())
    }
}

pub(crate) fn is_sftp_transport_error(err: &str) -> bool {
    let lower = err.to_lowercase();
    lower.contains("timeout")
        || lower.contains("connection lost")
        || lower.contains("no connection")
        || lower.contains("broken pipe")
        || lower.contains("channel closed")
        || lower.contains("disconnected")
        || lower.contains("keepalive")
        || lower.contains("connection reset")
        || lower.contains("not connected")
        || lower.contains("eof")
        || lower.contains("i/o:")
}

/// Properly close an SFTP file handle.
/// Drop alone uses close_nowait and does NOT decrement russh-sftp's open-handle
/// counter (limits@openssh.com), which eventually yields "handle limit reached"
/// and makes the destination session look dead after many files.
async fn close_sftp_file(file: &mut SftpFile) -> Result<()> {
    file.shutdown()
        .await
        .map_err(|e| anyhow!("Failed to close remote file: {e}"))
}

async fn ensure_remote_dir(session: &SharedSession, ui_path: &str) -> Result<()> {
    let sftp_io = sftp_io_lock(session).await;
    let _sftp_guard = sftp_io.lock().await;
    let sftp_path = {
        let inner = session.lock().await;
        ui_to_sftp(ui_path, &inner.home_path)
    };
    let inner = session.lock().await;
    match inner.sftp.metadata(&sftp_path).await {
        Ok(meta) if meta.file_type() == FileType::Dir => Ok(()),
        Ok(_) => Err(anyhow!("Destination exists and is not a directory: {ui_path}")),
        Err(_) => inner
            .sftp
            .create_dir(&sftp_path)
            .await
            .map_err(|e| anyhow!("Failed to create destination directory: {e}")),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<u64>,
}

pub async fn list_dir(session: &SharedSession, path: &str) -> Result<Vec<FileEntry>> {
    let sftp_io = sftp_io_lock(session).await;
    let _sftp_guard = sftp_io.lock().await;
    let inner = session.lock().await;
    let sftp_path = ui_to_sftp(path, &inner.home_path);
    let parent_abs = inner
        .sftp
        .canonicalize(&sftp_path)
        .await
        .map_err(|e| anyhow!("Failed to resolve directory {path}: {e}"))?;
    let entries = inner.sftp.read_dir(&sftp_path).await?;

    let parent_base = parent_abs.trim_end_matches('/');
    let mut result = Vec::new();
    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let abs_path = format!("{parent_base}/{name}");
        let metadata = entry.metadata();
        let is_dir = metadata.file_type() == FileType::Dir;
        let size = metadata.size.unwrap_or(0);
        let modified = metadata.mtime.map(|t| t as u64);
        result.push(FileEntry {
            name,
            path: abs_path,
            is_dir,
            size,
            modified,
        });
    }
    result.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(result)
}

pub async fn read_file(session: &SharedSession, path: &str) -> Result<String> {
    let data = read_file_bytes(session, path).await?;
    if data.len() > MAX_READ_BYTES {
        return Err(anyhow!(
            "File too large to preview (max {} MB)",
            MAX_READ_BYTES / 1024 / 1024
        ));
    }
    if data.contains(&0) {
        return Err(anyhow!("Binary file cannot be previewed"));
    }
    String::from_utf8(data).map_err(|_| anyhow!("File is not valid UTF-8 text"))
}

pub async fn write_file(session: &SharedSession, path: &str, content: &str) -> Result<()> {
    write_file_bytes(session, path, content.as_bytes()).await
}

pub async fn read_file_bytes(session: &SharedSession, path: &str) -> Result<Vec<u8>> {
    let sftp_io = sftp_io_lock(session).await;
    let _sftp_guard = sftp_io.lock().await;
    let sftp_path = {
        let inner = session.lock().await;
        ui_to_sftp(path, &inner.home_path)
    };
    let mut file = {
        let inner = session.lock().await;
        inner
            .sftp
            .open(&sftp_path)
            .await
            .map_err(|e| anyhow!("Failed to open file: {e}"))?
    };
    let mut data = Vec::new();
    file.read_to_end(&mut data)
        .await
        .map_err(|e| anyhow!("Failed to read file: {e}"))?;
    close_sftp_file(&mut file).await?;
    Ok(data)
}

pub async fn write_file_bytes(session: &SharedSession, path: &str, content: &[u8]) -> Result<()> {
    let sftp_io = sftp_io_lock(session).await;
    let _sftp_guard = sftp_io.lock().await;
    let sftp_path = {
        let inner = session.lock().await;
        ui_to_sftp(path, &inner.home_path)
    };
    let mut file = {
        let inner = session.lock().await;
        inner
            .sftp
            .create(&sftp_path)
            .await
            .map_err(|e| anyhow!("Failed to create file: {e}"))?
    };
    file.write_all(content)
        .await
        .map_err(|e| anyhow!("Failed to write file: {e}"))?;
    close_sftp_file(&mut file).await
}

pub async fn remove_path(session: &SharedSession, path: &str, is_dir: bool) -> Result<()> {
    if is_dir {
        return remove_dir_recursive(session, path).await;
    }
    remove_file(session, path).await
}

async fn remove_file(session: &SharedSession, path: &str) -> Result<()> {
    let sftp_io = sftp_io_lock(session).await;
    let _sftp_guard = sftp_io.lock().await;
    let sftp_path = {
        let inner = session.lock().await;
        ui_to_sftp(path, &inner.home_path)
    };
    let inner = session.lock().await;
    inner
        .sftp
        .remove_file(&sftp_path)
        .await
        .map_err(|e| anyhow!("Failed to remove file: {e}"))
}

async fn remove_dir_recursive(session: &SharedSession, path: &str) -> Result<()> {
    let entries = list_dir(session, path).await?;
    for entry in entries {
        if entry.is_dir {
            Box::pin(remove_dir_recursive(session, &entry.path)).await?;
        } else {
            remove_file(session, &entry.path).await?;
        }
    }
    let sftp_io = sftp_io_lock(session).await;
    let _sftp_guard = sftp_io.lock().await;
    let sftp_path = {
        let inner = session.lock().await;
        ui_to_sftp(path, &inner.home_path)
    };
    let inner = session.lock().await;
    inner
        .sftp
        .remove_dir(&sftp_path)
        .await
        .map_err(|e| anyhow!("Failed to remove directory: {e}"))
}

pub async fn rename_path(session: &SharedSession, path: &str, new_path: &str) -> Result<()> {
    let sftp_io = sftp_io_lock(session).await;
    let _sftp_guard = sftp_io.lock().await;
    let (old_sftp_path, new_sftp_path) = {
        let inner = session.lock().await;
        (
            ui_to_sftp(path, &inner.home_path),
            ui_to_sftp(new_path, &inner.home_path),
        )
    };
    let inner = session.lock().await;
    inner
        .sftp
        .rename(&old_sftp_path, &new_sftp_path)
        .await
        .map_err(|e| anyhow!("Failed to rename path: {e}"))
}

async fn local_path_total_bytes(path: &str, cancel: &AtomicBool) -> Result<u64> {
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|e| anyhow!("Failed to read local path metadata: {e}"))?;
    if meta.is_file() {
        return Ok(meta.len());
    }
    if !meta.is_dir() {
        return Err(anyhow!("Local path is neither file nor directory"));
    }

    let mut total = 0_u64;
    let mut stack = vec![path.to_string()];
    while let Some(current) = stack.pop() {
        ensure_not_cancelled(cancel)?;
        let mut rd = tokio::fs::read_dir(&current)
            .await
            .map_err(|e| anyhow!("Failed to read local directory {current}: {e}"))?;
        while let Some(entry) = rd.next_entry().await? {
            let ft = entry
                .file_type()
                .await
                .map_err(|e| anyhow!("Failed to read local entry type: {e}"))?;
            if ft.is_file() {
                total += entry
                    .metadata()
                    .await
                    .map_err(|e| anyhow!("Failed to read local file metadata: {e}"))?
                    .len();
            } else if ft.is_dir() {
                stack.push(entry.path().to_string_lossy().into_owned());
            }
        }
    }
    Ok(total)
}

async fn upload_single_local_file<F>(
    session: &SharedSession,
    local_path: &str,
    remote_path: &str,
    total_bytes: u64,
    loaded: &mut u64,
    cancel: &AtomicBool,
    on_progress: &mut F,
) -> Result<()>
where
    F: FnMut(u64, u64) -> Result<()>,
{
    let mut local_file = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| anyhow!("Failed to open local file: {e}"))?;

    let sftp_io = sftp_io_lock(session).await;
    let _sftp_guard = sftp_io.lock().await;
    let sftp_path = {
        let inner = session.lock().await;
        ui_to_sftp(remote_path, &inner.home_path)
    };
    let mut remote_file = {
        let inner = session.lock().await;
        inner
            .sftp
            .create(&sftp_path)
            .await
            .map_err(|e| anyhow!("Failed to create remote file: {e}"))?
    };

    let mut buffer = vec![0_u8; TRANSFER_CHUNK_SIZE];
    let mut last_reported = *loaded;
    loop {
        ensure_not_cancelled(cancel)?;
        let n = local_file
            .read(&mut buffer)
            .await
            .map_err(|e| anyhow!("Failed to read local file: {e}"))?;
        if n == 0 {
            break;
        }
        remote_file
            .write_all(&buffer[..n])
            .await
            .map_err(|e| anyhow!("Failed to write remote file: {e}"))?;
        *loaded += n as u64;
        if *loaded - last_reported >= PROGRESS_REPORT_EVERY_BYTES {
            on_progress(*loaded, total_bytes)?;
            last_reported = *loaded;
        }
    }
    if *loaded != last_reported {
        on_progress(*loaded, total_bytes)?;
    }
    close_sftp_file(&mut remote_file).await
}

async fn upload_local_path_recursive<F>(
    session: &SharedSession,
    local_path: &str,
    remote_path: &str,
    is_dir: bool,
    total_bytes: u64,
    loaded: &mut u64,
    cancel: &AtomicBool,
    on_progress: &mut F,
) -> Result<()>
where
    F: FnMut(u64, u64) -> Result<()>,
{
    ensure_not_cancelled(cancel)?;
    if is_dir {
        ensure_remote_dir(session, remote_path).await?;

        let mut rd = tokio::fs::read_dir(local_path)
            .await
            .map_err(|e| anyhow!("Failed to read local directory {local_path}: {e}"))?;
        while let Some(entry) = rd.next_entry().await? {
            ensure_not_cancelled(cancel)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let child_local = entry.path().to_string_lossy().into_owned();
            let child_remote = join_ui_path(remote_path, &name);
            let child_is_dir = entry
                .file_type()
                .await
                .map_err(|e| anyhow!("Failed to read local entry type: {e}"))?
                .is_dir();
            Box::pin(upload_local_path_recursive(
                session,
                &child_local,
                &child_remote,
                child_is_dir,
                total_bytes,
                loaded,
                cancel,
                on_progress,
            ))
            .await?;
        }
        Ok(())
    } else {
        upload_single_local_file(
            session,
            local_path,
            remote_path,
            total_bytes,
            loaded,
            cancel,
            on_progress,
        )
        .await
    }
}

pub async fn upload_local_path_with_progress<F>(
    session: &SharedSession,
    local_path: &str,
    remote_path: &str,
    cancel: &AtomicBool,
    mut report: F,
) -> Result<u64>
where
    F: FnMut(TransferProgress) -> Result<()>,
{
    report(TransferProgress {
        phase: "preparing",
        loaded_bytes: 0,
        total_bytes: None,
    })?;
    ensure_not_cancelled(cancel)?;

    let meta = tokio::fs::metadata(local_path)
        .await
        .map_err(|e| anyhow!("Failed to read local path metadata: {e}"))?;
    let is_dir = meta.is_dir();
    if !meta.is_file() && !is_dir {
        return Err(anyhow!("Local path is neither file nor directory"));
    }
    let total_bytes = local_path_total_bytes(local_path, cancel).await?;
    report(TransferProgress {
        phase: "transferring",
        loaded_bytes: 0,
        total_bytes: Some(total_bytes),
    })?;

    let mut loaded = 0_u64;
    let mut on_progress = |loaded_bytes: u64, total: u64| {
        report(TransferProgress {
            phase: "transferring",
            loaded_bytes,
            total_bytes: Some(total),
        })
    };
    upload_local_path_recursive(
        session,
        local_path,
        remote_path,
        is_dir,
        total_bytes,
        &mut loaded,
        cancel,
        &mut on_progress,
    )
    .await?;
    Ok(total_bytes)
}

pub(crate) fn join_ui_path(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", dir.trim_end_matches('/'), name)
    }
}

pub(crate) async fn remote_path_is_dir(session: &SharedSession, path: &str) -> Result<bool> {
    let sftp_io = sftp_io_lock(session).await;
    let _sftp_guard = sftp_io.lock().await;
    let sftp_path = {
        let inner = session.lock().await;
        ui_to_sftp(path, &inner.home_path)
    };
    let inner = session.lock().await;
    let meta = inner
        .sftp
        .metadata(&sftp_path)
        .await
        .map_err(|e| anyhow!("Failed to query remote metadata: {e}"))?;
    Ok(meta.file_type() == FileType::Dir)
}

pub(crate) async fn remote_path_total_bytes(
    session: &SharedSession,
    path: &str,
    is_dir: bool,
    cancel: &AtomicBool,
) -> Result<u64> {
    ensure_not_cancelled(cancel)?;
    if !is_dir {
        let sftp_io = sftp_io_lock(session).await;
        let _sftp_guard = sftp_io.lock().await;
        let sftp_path = {
            let inner = session.lock().await;
            ui_to_sftp(path, &inner.home_path)
        };
        let inner = session.lock().await;
        let meta = inner
            .sftp
            .metadata(&sftp_path)
            .await
            .map_err(|e| anyhow!("Failed to query remote metadata: {e}"))?;
        return Ok(meta.size.unwrap_or(0));
    }

    let entries = list_dir(session, path).await?;
    let mut total = 0_u64;
    for entry in entries {
        ensure_not_cancelled(cancel)?;
        total += Box::pin(remote_path_total_bytes(session, &entry.path, entry.is_dir, cancel)).await?;
    }
    Ok(total)
}

async fn copy_remote_file<F>(
    source: &SharedSession,
    dest: &SharedSession,
    source_path: &str,
    dest_path: &str,
    total_bytes: Option<u64>,
    loaded: &mut u64,
    cancel: &AtomicBool,
    on_progress: &mut F,
) -> Result<()>
where
    F: FnMut(u64, Option<u64>) -> Result<()>,
{
    let source_sftp_path = {
        let inner = source.lock().await;
        ui_to_sftp(source_path, &inner.home_path)
    };
    let dest_sftp_path = {
        let inner = dest.lock().await;
        ui_to_sftp(dest_path, &inner.home_path)
    };

    // Serialize SFTP IO on both sides without holding SessionInner locks, so
    // terminal_input can still resolve PTY handles during long transfers.
    // Lock order by Arc pointer to avoid A↔B / B↔A deadlocks.
    let source_io = sftp_io_lock(source).await;
    let dest_io = sftp_io_lock(dest).await;
    let source_ptr = std::sync::Arc::as_ptr(&source_io) as usize;
    let dest_ptr = std::sync::Arc::as_ptr(&dest_io) as usize;
    let (_first_guard, _second_guard) = if source_ptr <= dest_ptr {
        (source_io.lock().await, dest_io.lock().await)
    } else {
        let dest_guard = dest_io.lock().await;
        let source_guard = source_io.lock().await;
        (source_guard, dest_guard)
    };

    let mut source_file = {
        let inner = source.lock().await;
        inner
            .sftp
            .open(&source_sftp_path)
            .await
            .map_err(|e| anyhow!("Failed to open source file: {e}"))?
    };
    let mut dest_file = {
        let inner = dest.lock().await;
        inner
            .sftp
            .create(&dest_sftp_path)
            .await
            .map_err(|e| anyhow!("Failed to create destination file: {e}"))?
    };

    // Pipeline: read next chunk from A while writing the previous chunk to B.
    let mut read_buf = vec![0_u8; TRANSFER_CHUNK_SIZE];
    let mut write_buf = vec![0_u8; TRANSFER_CHUNK_SIZE];
    let mut write_len = 0_usize;
    let mut last_reported = *loaded;
    let mut primed = false;

    loop {
        ensure_not_cancelled(cancel)?;
        if !primed {
            let n = source_file
                .read(&mut read_buf)
                .await
                .map_err(|e| anyhow!("Failed to read source file: {e}"))?;
            if n == 0 {
                break;
            }
            std::mem::swap(&mut read_buf, &mut write_buf);
            write_len = n;
            primed = true;
            continue;
        }

        let write_fut = dest_file.write_all(&write_buf[..write_len]);
        let read_fut = source_file.read(&mut read_buf);
        let (write_res, read_res) = tokio::join!(write_fut, read_fut);
        write_res.map_err(|e| anyhow!("Failed to write destination file: {e}"))?;
        *loaded += write_len as u64;
        if *loaded - last_reported >= PROGRESS_REPORT_EVERY_BYTES {
            on_progress(*loaded, total_bytes)?;
            last_reported = *loaded;
        }

        let n = read_res.map_err(|e| anyhow!("Failed to read source file: {e}"))?;
        if n == 0 {
            break;
        }
        std::mem::swap(&mut read_buf, &mut write_buf);
        write_len = n;
    }

    if *loaded != last_reported {
        on_progress(*loaded, total_bytes)?;
    }
    close_sftp_file(&mut dest_file).await?;
    close_sftp_file(&mut source_file).await?;
    Ok(())
}

async fn copy_remote_path_recursive<F>(
    source: &SharedSession,
    dest: &SharedSession,
    source_path: &str,
    dest_path: &str,
    is_dir: bool,
    total_bytes: Option<u64>,
    loaded: &mut u64,
    cancel: &AtomicBool,
    on_progress: &mut F,
) -> Result<()>
where
    F: FnMut(u64, Option<u64>) -> Result<()>,
{
    ensure_not_cancelled(cancel)?;
    if is_dir {
        ensure_remote_dir(dest, dest_path).await?;

        let entries = list_dir(source, source_path).await?;
        for entry in entries {
            ensure_not_cancelled(cancel)?;
            let child_dest = join_ui_path(dest_path, &entry.name);
            Box::pin(copy_remote_path_recursive(
                source,
                dest,
                &entry.path,
                &child_dest,
                entry.is_dir,
                total_bytes,
                loaded,
                cancel,
                on_progress,
            ))
            .await?;
        }
        Ok(())
    } else {
        copy_remote_file(
            source,
            dest,
            source_path,
            dest_path,
            total_bytes,
            loaded,
            cancel,
            on_progress,
        )
        .await
    }
}

pub async fn copy_remote_to_remote_with_progress<F>(
    source: &SharedSession,
    dest: &SharedSession,
    source_path: &str,
    dest_path: &str,
    cancel: &AtomicBool,
    mut report: F,
) -> Result<u64>
where
    F: FnMut(TransferProgress) -> Result<()>,
{
    report(TransferProgress {
        phase: "transferring",
        loaded_bytes: 0,
        total_bytes: None,
    })?;
    ensure_not_cancelled(cancel)?;

    // Skip a full recursive size scan (extra RTT per file). Progress shows bytes
    // transferred; total stays unknown unless this is a single file.
    let is_dir = remote_path_is_dir(source, source_path).await?;
    ensure_not_cancelled(cancel)?;
    let total_bytes = if is_dir {
        None
    } else {
        Some(remote_path_total_bytes(source, source_path, false, cancel).await?)
    };
    report(TransferProgress {
        phase: "transferring",
        loaded_bytes: 0,
        total_bytes,
    })?;

    let mut loaded = 0_u64;
    let mut on_progress = |loaded_bytes: u64, total: Option<u64>| {
        report(TransferProgress {
            phase: "transferring",
            loaded_bytes,
            total_bytes: total,
        })
    };
    copy_remote_path_recursive(
        source,
        dest,
        source_path,
        dest_path,
        is_dir,
        total_bytes,
        &mut loaded,
        cancel,
        &mut on_progress,
    )
    .await?;
    Ok(loaded)
}

async fn download_single_remote_file<F>(
    session: &SharedSession,
    remote_path: &str,
    local_path: &str,
    total_bytes: u64,
    loaded: &mut u64,
    cancel: &AtomicBool,
    on_progress: &mut F,
) -> Result<()>
where
    F: FnMut(u64, u64) -> Result<()>,
{
    let remote_sftp_path = {
        let inner = session.lock().await;
        ui_to_sftp(remote_path, &inner.home_path)
    };

    let local = Path::new(local_path);
    if let Some(parent) = local.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| anyhow!("Failed to create local directory: {e}"))?;
    }
    let mut local_file = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| anyhow!("Failed to create local file: {e}"))?;

    let sftp_io = sftp_io_lock(session).await;
    let _sftp_guard = sftp_io.lock().await;
    let mut remote_file = {
        let inner = session.lock().await;
        inner
            .sftp
            .open(&remote_sftp_path)
            .await
            .map_err(|e| anyhow!("Failed to open remote file: {e}"))?
    };

    let mut buffer = vec![0_u8; TRANSFER_CHUNK_SIZE];
    let mut last_reported = *loaded;
    loop {
        ensure_not_cancelled(cancel)?;
        let n = remote_file
            .read(&mut buffer)
            .await
            .map_err(|e| anyhow!("Failed to read remote file: {e}"))?;
        if n == 0 {
            break;
        }
        local_file
            .write_all(&buffer[..n])
            .await
            .map_err(|e| anyhow!("Failed to write local file: {e}"))?;
        *loaded += n as u64;
        if *loaded - last_reported >= PROGRESS_REPORT_EVERY_BYTES {
            on_progress(*loaded, total_bytes)?;
            last_reported = *loaded;
        }
    }
    if *loaded != last_reported {
        on_progress(*loaded, total_bytes)?;
    }
    close_sftp_file(&mut remote_file).await
}

async fn download_remote_path_recursive<F>(
    session: &SharedSession,
    remote_path: &str,
    local_path: &str,
    is_dir: bool,
    total_bytes: u64,
    loaded: &mut u64,
    cancel: &AtomicBool,
    on_progress: &mut F,
) -> Result<()>
where
    F: FnMut(u64, u64) -> Result<()>,
{
    ensure_not_cancelled(cancel)?;
    if is_dir {
        tokio::fs::create_dir_all(local_path)
            .await
            .map_err(|e| anyhow!("Failed to create local directory: {e}"))?;
        let entries = list_dir(session, remote_path).await?;
        for entry in entries {
            ensure_not_cancelled(cancel)?;
            let child_local = Path::new(local_path)
                .join(&entry.name)
                .to_string_lossy()
                .into_owned();
            Box::pin(download_remote_path_recursive(
                session,
                &entry.path,
                &child_local,
                entry.is_dir,
                total_bytes,
                loaded,
                cancel,
                on_progress,
            ))
            .await?;
        }
        Ok(())
    } else {
        download_single_remote_file(
            session,
            remote_path,
            local_path,
            total_bytes,
            loaded,
            cancel,
            on_progress,
        )
        .await
    }
}

pub async fn download_remote_path_with_progress<F>(
    session: &SharedSession,
    remote_path: &str,
    local_path: &str,
    cancel: &AtomicBool,
    mut report: F,
) -> Result<u64>
where
    F: FnMut(TransferProgress) -> Result<()>,
{
    report(TransferProgress {
        phase: "preparing",
        loaded_bytes: 0,
        total_bytes: None,
    })?;
    ensure_not_cancelled(cancel)?;

    let is_dir = remote_path_is_dir(session, remote_path).await?;
    ensure_not_cancelled(cancel)?;
    let total_bytes = remote_path_total_bytes(session, remote_path, is_dir, cancel).await?;
    report(TransferProgress {
        phase: "transferring",
        loaded_bytes: 0,
        total_bytes: Some(total_bytes),
    })?;

    let mut loaded = 0_u64;
    let mut on_progress = |loaded_bytes: u64, total: u64| {
        report(TransferProgress {
            phase: "transferring",
            loaded_bytes,
            total_bytes: Some(total),
        })
    };
    download_remote_path_recursive(
        session,
        remote_path,
        local_path,
        is_dir,
        total_bytes,
        &mut loaded,
        cancel,
        &mut on_progress,
    )
    .await?;
    Ok(total_bytes)
}

pub fn ui_to_sftp(path: &str, home: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed == "~" || trimmed == home {
        return ".".to_string();
    }
    trimmed.to_string()
}

#[cfg(test)]
mod tests {
    use super::is_sftp_transport_error;

    #[test]
    fn transport_errors_are_detected() {
        assert!(is_sftp_transport_error("Timeout"));
        assert!(is_sftp_transport_error("I/O: Connection reset by peer"));
        assert!(is_sftp_transport_error("channel closed"));
        assert!(is_sftp_transport_error("KeepaliveTimeout"));
        assert!(!is_sftp_transport_error("Permission denied"));
        assert!(!is_sftp_transport_error("No such file"));
    }
}
