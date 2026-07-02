use crate::ssh::exec::{run_remote_command, shell_quote};
use crate::ssh::session::SharedSession;
use crate::ssh::sftp::{
    copy_remote_to_remote_with_progress, download_remote_path_with_progress, remove_path,
    remote_path_is_dir, ui_to_sftp, upload_local_path_with_progress, TransferProgress,
};
use anyhow::{anyhow, Result};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use tokio::process::Command;
use uuid::Uuid;

fn report_phase<F>(report: &mut F, phase: &'static str) -> Result<()>
where
    F: FnMut(TransferProgress) -> Result<()>,
{
    report(TransferProgress {
        phase,
        loaded_bytes: 0,
        total_bytes: None,
    })
}

fn split_parent_name(path: &str) -> (String, String) {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() || trimmed == "/" {
        return ("/".to_string(), String::new());
    }
    let idx = trimmed.rfind('/').unwrap_or(0);
    if idx == 0 {
        return ("/".to_string(), trimmed[1..].to_string());
    }
    (
        trimmed[..idx].to_string(),
        trimmed[idx + 1..].to_string(),
    )
}

fn join_ui_path(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", dir.trim_end_matches('/'), name)
    }
}

async fn local_tar_create(source_dir: &str, archive_path: &Path) -> Result<()> {
    let source = Path::new(source_dir);
    let parent = source
        .parent()
        .ok_or_else(|| anyhow!("Invalid local directory path"))?;
    let name = source
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or_else(|| anyhow!("Invalid local directory name"))?;
    let status = Command::new("tar")
        .args([
            "czf",
            archive_path.to_string_lossy().as_ref(),
            "-C",
            parent.to_string_lossy().as_ref(),
            name,
        ])
        .status()
        .await
        .map_err(|e| anyhow!("Failed to run local tar: {e}"))?;
    if !status.success() {
        return Err(anyhow!("Local tar compression failed"));
    }
    Ok(())
}

async fn local_tar_extract(archive_path: &Path, dest_dir: &Path) -> Result<()> {
    tokio::fs::create_dir_all(dest_dir)
        .await
        .map_err(|e| anyhow!("Failed to create local directory: {e}"))?;
    let status = Command::new("tar")
        .args([
            "xzf",
            archive_path.to_string_lossy().as_ref(),
            "-C",
            dest_dir.to_string_lossy().as_ref(),
        ])
        .status()
        .await
        .map_err(|e| anyhow!("Failed to run local tar extract: {e}"))?;
    if !status.success() {
        return Err(anyhow!("Local tar extraction failed"));
    }
    Ok(())
}

async fn remote_tar_create(session: &SharedSession, source_path: &str, archive_path: &str) -> Result<()> {
    let (parent, name) = split_parent_name(source_path);
    if name.is_empty() {
        return Err(anyhow!("Invalid remote directory path"));
    }
    let cmd = format!(
        "tar czf {} -C {} {}",
        shell_quote(archive_path),
        shell_quote(&parent),
        shell_quote(&name)
    );
    let code = run_remote_command(session, &cmd).await?;
    if code != 0 {
        return Err(anyhow!("Remote tar compression failed (exit {code})"));
    }
    Ok(())
}

async fn remote_tar_extract(session: &SharedSession, archive_path: &str, dest_dir: &str) -> Result<()> {
    let cmd = format!(
        "mkdir -p {} && tar xzf {} -C {}",
        shell_quote(dest_dir),
        shell_quote(archive_path),
        shell_quote(dest_dir)
    );
    let code = run_remote_command(session, &cmd).await?;
    if code != 0 {
        return Err(anyhow!("Remote tar extraction failed (exit {code})"));
    }
    Ok(())
}

async fn remote_remove_file(session: &SharedSession, path: &str) -> Result<()> {
    remove_path(session, path, false).await
}

fn temp_local_archive() -> PathBuf {
    std::env::temp_dir().join(format!("mx-txfer-{}.tar.gz", Uuid::new_v4()))
}

fn temp_remote_archive() -> String {
    format!("/tmp/mx-txfer-{}.tar.gz", Uuid::new_v4())
}

pub async fn upload_directory_compressed<F>(
    session: &SharedSession,
    local_dir: &str,
    remote_dir: &str,
    cancel: &AtomicBool,
    mut report: F,
) -> Result<u64>
where
    F: FnMut(TransferProgress) -> Result<()>,
{
    use crate::ssh::sftp::ensure_not_cancelled;

    let (_, name) = split_parent_name(local_dir);
    if name.is_empty() {
        return Err(anyhow!("Invalid local directory path"));
    }

    let local_archive = temp_local_archive();
    let remote_archive = join_ui_path(remote_dir, &format!("{name}.tar.gz"));
    let remote_target_dir = join_ui_path(remote_dir, &name);

    report_phase(&mut report, "compressing")?;
    ensure_not_cancelled(cancel)?;
    local_tar_create(local_dir, &local_archive).await?;

    let total = upload_local_path_with_progress(
        session,
        local_archive.to_string_lossy().as_ref(),
        &remote_archive,
        cancel,
        |progress| {
            report(TransferProgress {
                phase: "transferring",
                loaded_bytes: progress.loaded_bytes,
                total_bytes: progress.total_bytes,
            })
        },
    )
    .await?;

    report_phase(&mut report, "extracting")?;
    ensure_not_cancelled(cancel)?;
    let (parent, _) = split_parent_name(&remote_archive);
    remote_tar_extract(session, &remote_archive, &parent).await?;

    report_phase(&mut report, "cleaning")?;
    let _ = remote_remove_file(session, &remote_archive).await;
    let _ = tokio::fs::remove_file(&local_archive).await;

    report(TransferProgress {
        phase: "transferring",
        loaded_bytes: total,
        total_bytes: Some(total),
    })?;

    let _ = remote_target_dir;
    Ok(total)
}

pub async fn download_directory_compressed<F>(
    session: &SharedSession,
    remote_dir: &str,
    local_parent: &str,
    cancel: &AtomicBool,
    mut report: F,
) -> Result<u64>
where
    F: FnMut(TransferProgress) -> Result<()>,
{
    use crate::ssh::sftp::ensure_not_cancelled;

    let (_, name) = split_parent_name(remote_dir);
    if name.is_empty() {
        return Err(anyhow!("Invalid remote directory path"));
    }

    let remote_archive = temp_remote_archive();
    let local_archive = temp_local_archive();
    let local_target_dir = join_ui_path(local_parent, &name);

    report_phase(&mut report, "compressing")?;
    ensure_not_cancelled(cancel)?;
    remote_tar_create(session, remote_dir, &remote_archive).await?;

    let total = download_remote_path_with_progress(
        session,
        &remote_archive,
        local_archive.to_string_lossy().as_ref(),
        cancel,
        |progress| {
            report(TransferProgress {
                phase: "transferring",
                loaded_bytes: progress.loaded_bytes,
                total_bytes: progress.total_bytes,
            })
        },
    )
    .await?;

    report_phase(&mut report, "extracting")?;
    ensure_not_cancelled(cancel)?;
    local_tar_extract(&local_archive, Path::new(local_parent)).await?;

    report_phase(&mut report, "cleaning")?;
    let _ = remote_remove_file(session, &remote_archive).await;
    let _ = tokio::fs::remove_file(&local_archive).await;

    report(TransferProgress {
        phase: "transferring",
        loaded_bytes: total,
        total_bytes: Some(total),
    })?;

    let _ = local_target_dir;
    Ok(total)
}

pub async fn copy_remote_directory_compressed<F>(
    source: &SharedSession,
    dest: &SharedSession,
    source_dir: &str,
    dest_dir: &str,
    cancel: &AtomicBool,
    mut report: F,
) -> Result<u64>
where
    F: FnMut(TransferProgress) -> Result<()>,
{
    use crate::ssh::sftp::ensure_not_cancelled;

    let (_, name) = split_parent_name(source_dir);
    if name.is_empty() {
        return Err(anyhow!("Invalid source directory path"));
    }

    let source_archive = temp_remote_archive();
    let dest_archive = join_ui_path(dest_dir, &format!("{name}.tar.gz"));

    report_phase(&mut report, "compressing")?;
    ensure_not_cancelled(cancel)?;
    remote_tar_create(source, source_dir, &source_archive).await?;

    let total = copy_remote_to_remote_with_progress(
        source,
        dest,
        &source_archive,
        &dest_archive,
        cancel,
        |progress| {
            report(TransferProgress {
                phase: "transferring",
                loaded_bytes: progress.loaded_bytes,
                total_bytes: progress.total_bytes,
            })
        },
    )
    .await?;

    report_phase(&mut report, "extracting")?;
    ensure_not_cancelled(cancel)?;
    remote_tar_extract(dest, &dest_archive, dest_dir).await?;

    report_phase(&mut report, "cleaning")?;
    let _ = remote_remove_file(source, &source_archive).await;
    let _ = remote_remove_file(dest, &dest_archive).await;

    report(TransferProgress {
        phase: "transferring",
        loaded_bytes: total,
        total_bytes: Some(total),
    })?;

    Ok(total)
}

pub async fn path_is_remote_dir(session: &SharedSession, path: &str) -> Result<bool> {
    remote_path_is_dir(session, path).await
}

pub async fn path_is_local_dir(path: &str) -> Result<bool> {
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|e| anyhow!("Failed to read local path metadata: {e}"))?;
    Ok(meta.is_dir())
}

// Keep ui_to_sftp accessible for future archive size queries if needed.
#[allow(dead_code)]
fn remote_sftp_path(session: &SharedSession, path: &str) -> Result<String> {
    let inner = session
        .try_lock()
        .map_err(|_| anyhow!("Session is busy"))?;
    Ok(ui_to_sftp(path, &inner.home_path))
}
