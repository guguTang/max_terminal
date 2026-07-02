use crate::ssh::session::SharedSession;
use crate::ssh::sftp::{
    ensure_not_cancelled, join_ui_path, list_dir, read_file_bytes, remote_path_total_bytes,
    ui_to_sftp, write_file_bytes,
};
use anyhow::{anyhow, Result};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tar::{Builder, EntryType, Header};

struct RemoteTarEntry {
    relative_path: String,
    is_dir: bool,
    remote_path: Option<String>,
}

struct LocalTarEntry {
    path: String,
    is_dir: bool,
    data: Vec<u8>,
}

async fn collect_remote_tar_entries(
    session: &SharedSession,
    remote_dir: &str,
    prefix: &str,
    out: &mut Vec<RemoteTarEntry>,
) -> Result<()> {
    out.push(RemoteTarEntry {
        relative_path: prefix.to_string(),
        is_dir: true,
        remote_path: None,
    });
    let entries = list_dir(session, remote_dir).await?;
    for entry in entries {
        let rel = format!("{}/{}", prefix, entry.name);
        if entry.is_dir {
            Box::pin(collect_remote_tar_entries(session, &entry.path, &rel, out)).await?;
        } else {
            out.push(RemoteTarEntry {
                relative_path: rel,
                is_dir: false,
                remote_path: Some(entry.path),
            });
        }
    }
    Ok(())
}

async fn ensure_remote_directory(session: &SharedSession, ui_path: &str) -> Result<()> {
    let sftp_path = {
        let inner = session.lock().await;
        ui_to_sftp(ui_path, &inner.home_path)
    };
    if sftp_path == "." {
        return Ok(());
    }

    let is_abs = sftp_path.starts_with('/');
    let parts: Vec<&str> = sftp_path.split('/').filter(|part| !part.is_empty()).collect();
    let mut current = if is_abs { String::new() } else { ".".to_string() };

    for part in parts {
        current = if current.is_empty() {
            format!("/{part}")
        } else if current == "." {
            part.to_string()
        } else {
            format!("{current}/{part}")
        };
        let inner = session.lock().await;
        if inner.sftp.metadata(&current).await.is_err() {
            inner
                .sftp
                .create_dir(&current)
                .await
                .map_err(|e| anyhow!("Failed to create remote directory {ui_path}: {e}"))?;
        }
    }
    Ok(())
}

fn parent_ui_paths(path: &str) -> Vec<String> {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return Vec::new();
    }
    let mut parents = Vec::new();
    let mut current = trimmed.to_string();
    while let Some(idx) = current.rfind('/') {
        if idx == 0 {
            break;
        }
        current = current[..idx].to_string();
        parents.push(current.clone());
    }
    parents.reverse();
    parents
}

pub async fn create_local_tar_gz_from_remote_dir(
    session: &SharedSession,
    remote_dir: &str,
    archive_path: &Path,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(u64, u64) -> Result<()>,
) -> Result<u64> {
    ensure_not_cancelled(cancel)?;

    let trimmed = remote_dir.trim_end_matches('/');
    let top_name = trimmed
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| anyhow!("Invalid remote directory path"))?;

    let total_bytes = remote_path_total_bytes(session, remote_dir, true, cancel).await?;
    on_progress(0, total_bytes)?;

    let mut entries = Vec::new();
    collect_remote_tar_entries(session, remote_dir, top_name, &mut entries).await?;

    let archive_path = archive_path.to_path_buf();
    let session = session.clone();

    let builder = Arc::new(Mutex::new(None::<Builder<GzEncoder<std::fs::File>>>));
    {
        let file = std::fs::File::create(&archive_path)
            .map_err(|e| anyhow!("Failed to create local archive: {e}"))?;
        let enc = GzEncoder::new(file, Compression::default());
        *builder.lock().unwrap() = Some(Builder::new(enc));
    }

    let mut loaded = 0_u64;
    for entry in entries {
        ensure_not_cancelled(cancel)?;
        if entry.is_dir {
            let relative_path = entry.relative_path.clone();
            let builder = builder.clone();
            tokio::task::spawn_blocking(move || -> Result<()> {
                let mut header = Header::new_gnu();
                header.set_path(&relative_path)?;
                header.set_entry_type(EntryType::Directory);
                header.set_mode(0o755);
                header.set_size(0);
                header.set_cksum();
                let mut builder = builder.lock().unwrap();
                let builder = builder
                    .as_mut()
                    .ok_or_else(|| anyhow!("Archive builder not initialized"))?;
                builder.append(&header, &mut std::io::empty())?;
                Ok(())
            })
            .await
            .map_err(|e| anyhow!("Archive task failed: {e}"))??;
            continue;
        }

        let remote_path = entry
            .remote_path
            .as_ref()
            .ok_or_else(|| anyhow!("Missing remote file path for archive entry"))?;
        let data = read_file_bytes(&session, remote_path).await?;
        loaded += data.len() as u64;
        on_progress(loaded, total_bytes)?;

        let relative_path = entry.relative_path;
        let builder = builder.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut header = Header::new_gnu();
            header.set_path(&relative_path)?;
            header.set_mode(0o644);
            header.set_size(data.len() as u64);
            header.set_cksum();
            let mut builder = builder.lock().unwrap();
            let builder = builder
                .as_mut()
                .ok_or_else(|| anyhow!("Archive builder not initialized"))?;
            builder.append_data(&mut header, &relative_path, &mut Cursor::new(data))?;
            Ok(())
        })
        .await
        .map_err(|e| anyhow!("Archive task failed: {e}"))??;
    }

    let archive_path_for_finish = archive_path.clone();
    tokio::task::spawn_blocking(move || -> Result<u64> {
        let mut guard = builder.lock().unwrap();
        let builder = guard
            .take()
            .ok_or_else(|| anyhow!("Archive builder not initialized"))?;
        let mut enc = builder
            .into_inner()
            .map_err(|e| anyhow!("Failed to finalize archive: {e}"))?;
        enc.flush()
            .map_err(|e| anyhow!("Failed to flush archive: {e}"))?;
        let size = std::fs::metadata(&archive_path_for_finish)
            .map_err(|e| anyhow!("Failed to read archive metadata: {e}"))?
            .len();
        Ok(size)
    })
    .await
    .map_err(|e| anyhow!("Archive task failed: {e}"))?
}

fn read_local_tar_entries(archive_path: &Path) -> Result<Vec<LocalTarEntry>> {
    let file = std::fs::File::open(archive_path)
        .map_err(|e| anyhow!("Failed to open archive: {e}"))?;
    let decoder = GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    let mut entries = Vec::new();
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry
            .path()?
            .to_string_lossy()
            .replace('\\', "/");
        let is_dir = entry.header().entry_type().is_dir();
        let mut data = Vec::new();
        if !is_dir {
            entry.read_to_end(&mut data)?;
        }
        entries.push(LocalTarEntry { path, is_dir, data });
    }
    Ok(entries)
}

pub async fn extract_local_tar_gz_to_remote_dir(
    session: &SharedSession,
    archive_path: &Path,
    remote_dest: &str,
    cancel: &AtomicBool,
) -> Result<()> {
    ensure_not_cancelled(cancel)?;
    let archive_path = archive_path.to_path_buf();
    let entries = tokio::task::spawn_blocking(move || read_local_tar_entries(&archive_path))
        .await
        .map_err(|e| anyhow!("Archive task failed: {e}"))??;

    let mut dir_paths = Vec::new();
    for entry in &entries {
        if entry.is_dir {
            dir_paths.push(entry.path.clone());
        } else {
            dir_paths.extend(parent_ui_paths(&entry.path));
        }
    }
    dir_paths.sort();
    dir_paths.dedup();

    for dir in dir_paths {
        ensure_not_cancelled(cancel)?;
        let remote_path = join_ui_path(remote_dest, &dir);
        ensure_remote_directory(session, &remote_path).await?;
    }

    for entry in entries {
        ensure_not_cancelled(cancel)?;
        if entry.is_dir {
            continue;
        }
        let remote_path = join_ui_path(remote_dest, &entry.path);
        for parent in parent_ui_paths(&entry.path) {
            ensure_remote_directory(session, &join_ui_path(remote_dest, &parent)).await?;
        }
        write_file_bytes(session, &remote_path, &entry.data).await?;
    }
    Ok(())
}

pub fn temp_local_archive() -> PathBuf {
    std::env::temp_dir().join(format!("mx-txfer-{}.tar.gz", uuid::Uuid::new_v4()))
}
