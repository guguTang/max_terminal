use crate::db::connection::get_connection;
use crate::ssh::session::connect;
use crate::ssh::archive_transfer::{
    copy_remote_directory_compressed, download_directory_compressed, path_is_local_dir,
    path_is_remote_dir, upload_directory_compressed,
};
use crate::ssh::sftp::{
    copy_remote_to_remote_with_progress, download_remote_path_with_progress, list_dir,
    read_file, read_file_bytes, remove_path, rename_path, upload_local_path_with_progress,
    write_file, write_file_bytes,
};
use crate::state::AppState;
use anyhow::anyhow;
use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use tauri::State;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    pub session_id: String,
    pub connection_id: String,
    pub home_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferTaskSnapshot {
    pub task_id: String,
    pub session_id: String,
    pub direction: String,
    pub remote_path: String,
    pub local_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dest_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dest_remote_path: Option<String>,
    pub loaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub phase: String,
    pub status: String,
    pub error: Option<String>,
    pub started_at: u64,
    pub ended_at: Option<u64>,
}

#[derive(Clone)]
struct TransferTaskRuntime {
    snapshot: TransferTaskSnapshot,
    cancel: Arc<AtomicBool>,
}

static TRANSFER_TASKS: LazyLock<Mutex<HashMap<String, TransferTaskRuntime>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn unix_ms_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn apply_transfer_progress(
    task_id: &str,
    progress: crate::ssh::sftp::TransferProgress,
) -> Result<(), anyhow::Error> {
    let mut tasks = TRANSFER_TASKS
        .lock()
        .map_err(|e| anyhow!("Transfer lock poisoned: {e}"))?;
    if let Some(runtime) = tasks.get_mut(task_id) {
        runtime.snapshot.phase = progress.phase.to_string();
        runtime.snapshot.loaded_bytes = progress.loaded_bytes;
        runtime.snapshot.total_bytes = progress.total_bytes;
    }
    Ok(())
}

async fn get_session(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<crate::ssh::session::SharedSession, String> {
    let sessions = state.sessions.lock().await;
    sessions
        .get(session_id)
        .map(|s| s.clone())
        .ok_or_else(|| "Session not found".to_string())
}

#[tauri::command]
pub async fn connect_ssh(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<ConnectResult, String> {
    let record = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        get_connection(&conn, &connection_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Connection not found".to_string())?
    };

    let (session_id, session) = connect(&record).await.map_err(|e| e.to_string())?;

    let home_path = {
        let inner = session.lock().await;
        inner.home_path.clone()
    };

    {
        let mut sessions = state.sessions.lock().await;
        sessions.insert(session_id.clone(), session);
    }

    Ok(ConnectResult {
        session_id,
        connection_id,
        home_path,
    })
}

#[tauri::command]
pub async fn disconnect_ssh(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    sessions.remove(&session_id).await;
    Ok(())
}

#[tauri::command]
pub async fn sftp_list_dir(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<Vec<crate::ssh::sftp::FileEntry>, String> {
    let session = get_session(&state, &session_id).await?;
    list_dir(&session, &path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_read_file(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<String, String> {
    let session = get_session(&state, &session_id).await?;
    read_file(&session, &path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_write_file(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let session = get_session(&state, &session_id).await?;
    write_file(&session, &path, &content)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_read_file_base64(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<String, String> {
    let session = get_session(&state, &session_id).await?;
    let bytes = read_file_bytes(&session, &path)
        .await
        .map_err(|e| e.to_string())?;
    Ok(general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
pub async fn sftp_write_file_base64(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    content_base64: String,
) -> Result<(), String> {
    let session = get_session(&state, &session_id).await?;
    let bytes = general_purpose::STANDARD
        .decode(content_base64)
        .map_err(|e| format!("Invalid base64 content: {e}"))?;
    write_file_bytes(&session, &path, &bytes)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_local_file_base64(path: String, content_base64: String) -> Result<(), String> {
    let bytes = general_purpose::STANDARD
        .decode(content_base64)
        .map_err(|e| format!("Invalid base64 content: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("Failed to save local file: {e}"))
}

#[tauri::command]
pub async fn sftp_remove_path(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let session = get_session(&state, &session_id).await?;
    remove_path(&session, &path, is_dir)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_rename_path(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    new_path: String,
) -> Result<(), String> {
    let session = get_session(&state, &session_id).await?;
    rename_path(&session, &path, &new_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn transfer_start_upload(
    state: State<'_, AppState>,
    session_id: String,
    local_path: String,
    remote_path: String,
    compress: Option<bool>,
) -> Result<TransferTaskSnapshot, String> {
    let session = get_session(&state, &session_id).await?;
    let task_id = Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    let started_at = unix_ms_now();
    let snapshot = TransferTaskSnapshot {
        task_id: task_id.clone(),
        session_id: session_id.clone(),
        direction: "upload".to_string(),
        remote_path: remote_path.clone(),
        local_path: local_path.clone(),
        dest_session_id: None,
        dest_remote_path: None,
        loaded_bytes: 0,
        total_bytes: None,
        phase: "preparing".to_string(),
        status: "running".to_string(),
        error: None,
        started_at,
        ended_at: None,
    };
    {
        let mut tasks = TRANSFER_TASKS.lock().map_err(|e| e.to_string())?;
        tasks.insert(
            task_id.clone(),
            TransferTaskRuntime {
                snapshot: snapshot.clone(),
                cancel: cancel.clone(),
            },
        );
    }

    let task_id_for_spawn = task_id.clone();
    let use_compress = compress.unwrap_or(false);
    tokio::spawn(async move {
        let result = async {
            if use_compress && path_is_local_dir(&local_path).await.unwrap_or(false) {
                upload_directory_compressed(
                    &session,
                    &local_path,
                    &remote_path,
                    &cancel,
                    |progress| {
                        if cancel.load(Ordering::Relaxed) {
                            return Err(anyhow!("Cancelled"));
                        }
                        apply_transfer_progress(&task_id_for_spawn, progress)
                    },
                )
                .await
            } else {
                upload_local_path_with_progress(
                    &session,
                    &local_path,
                    &remote_path,
                    &cancel,
                    |progress| {
                        if cancel.load(Ordering::Relaxed) {
                            return Err(anyhow!("Cancelled"));
                        }
                        apply_transfer_progress(&task_id_for_spawn, progress)
                    },
                )
                .await
            }
        }
        .await;

        let mut tasks = match TRANSFER_TASKS.lock() {
            Ok(lock) => lock,
            Err(_) => return,
        };
        if let Some(runtime) = tasks.get_mut(&task_id_for_spawn) {
            match result {
                Ok(total) => {
                    runtime.snapshot.phase = "transferring".to_string();
                    runtime.snapshot.total_bytes = Some(total);
                    runtime.snapshot.loaded_bytes = total;
                    runtime.snapshot.status = "success".to_string();
                    runtime.snapshot.ended_at = Some(unix_ms_now());
                    runtime.snapshot.error = None;
                }
                Err(err) => {
                    if runtime.cancel.load(Ordering::Relaxed) {
                        runtime.snapshot.status = "cancelled".to_string();
                        runtime.snapshot.error = None;
                    } else {
                        runtime.snapshot.status = "failed".to_string();
                        runtime.snapshot.error = Some(err.to_string());
                    }
                    runtime.snapshot.ended_at = Some(unix_ms_now());
                }
            }
        }
    });

    Ok(snapshot)
}

#[tauri::command]
pub async fn transfer_start_download(
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    local_path: String,
    compress: Option<bool>,
) -> Result<TransferTaskSnapshot, String> {
    let session = get_session(&state, &session_id).await?;
    let task_id = Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    let started_at = unix_ms_now();
    let snapshot = TransferTaskSnapshot {
        task_id: task_id.clone(),
        session_id: session_id.clone(),
        direction: "download".to_string(),
        remote_path: remote_path.clone(),
        local_path: local_path.clone(),
        dest_session_id: None,
        dest_remote_path: None,
        loaded_bytes: 0,
        total_bytes: None,
        phase: "preparing".to_string(),
        status: "running".to_string(),
        error: None,
        started_at,
        ended_at: None,
    };
    {
        let mut tasks = TRANSFER_TASKS.lock().map_err(|e| e.to_string())?;
        tasks.insert(
            task_id.clone(),
            TransferTaskRuntime {
                snapshot: snapshot.clone(),
                cancel: cancel.clone(),
            },
        );
    }

    let task_id_for_spawn = task_id.clone();
    let use_compress = compress.unwrap_or(false);
    tokio::spawn(async move {
        let result = async {
            if use_compress && path_is_remote_dir(&session, &remote_path).await.unwrap_or(false) {
                download_directory_compressed(
                    &session,
                    &remote_path,
                    &local_path,
                    &cancel,
                    |progress| {
                        if cancel.load(Ordering::Relaxed) {
                            return Err(anyhow!("Cancelled"));
                        }
                        apply_transfer_progress(&task_id_for_spawn, progress)
                    },
                )
                .await
            } else {
                download_remote_path_with_progress(
                    &session,
                    &remote_path,
                    &local_path,
                    &cancel,
                    |progress| {
                        if cancel.load(Ordering::Relaxed) {
                            return Err(anyhow!("Cancelled"));
                        }
                        apply_transfer_progress(&task_id_for_spawn, progress)
                    },
                )
                .await
            }
        }
        .await;

        let mut tasks = match TRANSFER_TASKS.lock() {
            Ok(lock) => lock,
            Err(_) => return,
        };
        if let Some(runtime) = tasks.get_mut(&task_id_for_spawn) {
            match result {
                Ok(total) => {
                    runtime.snapshot.phase = "transferring".to_string();
                    runtime.snapshot.total_bytes = Some(total);
                    runtime.snapshot.loaded_bytes = total;
                    runtime.snapshot.status = "success".to_string();
                    runtime.snapshot.ended_at = Some(unix_ms_now());
                    runtime.snapshot.error = None;
                }
                Err(err) => {
                    if runtime.cancel.load(Ordering::Relaxed) {
                        runtime.snapshot.status = "cancelled".to_string();
                        runtime.snapshot.error = None;
                    } else {
                        runtime.snapshot.status = "failed".to_string();
                        runtime.snapshot.error = Some(err.to_string());
                    }
                    runtime.snapshot.ended_at = Some(unix_ms_now());
                }
            }
        }
    });

    Ok(snapshot)
}

#[tauri::command]
pub async fn transfer_start_remote_copy(
    state: State<'_, AppState>,
    source_session_id: String,
    dest_session_id: String,
    source_path: String,
    dest_path: String,
    compress: Option<bool>,
) -> Result<TransferTaskSnapshot, String> {
    if source_session_id == dest_session_id {
        return Err("Source and destination sessions must be different".to_string());
    }
    let source_session = get_session(&state, &source_session_id).await?;
    let dest_session = get_session(&state, &dest_session_id).await?;
    let task_id = Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    let started_at = unix_ms_now();
    let snapshot = TransferTaskSnapshot {
        task_id: task_id.clone(),
        session_id: source_session_id.clone(),
        direction: "remote-copy".to_string(),
        remote_path: source_path.clone(),
        local_path: String::new(),
        dest_session_id: Some(dest_session_id.clone()),
        dest_remote_path: Some(dest_path.clone()),
        loaded_bytes: 0,
        total_bytes: None,
        phase: "preparing".to_string(),
        status: "running".to_string(),
        error: None,
        started_at,
        ended_at: None,
    };
    {
        let mut tasks = TRANSFER_TASKS.lock().map_err(|e| e.to_string())?;
        tasks.insert(
            task_id.clone(),
            TransferTaskRuntime {
                snapshot: snapshot.clone(),
                cancel: cancel.clone(),
            },
        );
    }

    let task_id_for_spawn = task_id.clone();
    let use_compress = compress.unwrap_or(false);
    tokio::spawn(async move {
        let result = async {
            if use_compress
                && path_is_remote_dir(&source_session, &source_path)
                    .await
                    .unwrap_or(false)
            {
                copy_remote_directory_compressed(
                    &source_session,
                    &dest_session,
                    &source_path,
                    &dest_path,
                    &cancel,
                    |progress| {
                        if cancel.load(Ordering::Relaxed) {
                            return Err(anyhow!("Cancelled"));
                        }
                        apply_transfer_progress(&task_id_for_spawn, progress)
                    },
                )
                .await
            } else {
                copy_remote_to_remote_with_progress(
                    &source_session,
                    &dest_session,
                    &source_path,
                    &dest_path,
                    &cancel,
                    |progress| {
                        if cancel.load(Ordering::Relaxed) {
                            return Err(anyhow!("Cancelled"));
                        }
                        apply_transfer_progress(&task_id_for_spawn, progress)
                    },
                )
                .await
            }
        }
        .await;

        let mut tasks = match TRANSFER_TASKS.lock() {
            Ok(lock) => lock,
            Err(_) => return,
        };
        if let Some(runtime) = tasks.get_mut(&task_id_for_spawn) {
            match result {
                Ok(total) => {
                    runtime.snapshot.phase = "transferring".to_string();
                    runtime.snapshot.total_bytes = Some(total);
                    runtime.snapshot.loaded_bytes = total;
                    runtime.snapshot.status = "success".to_string();
                    runtime.snapshot.ended_at = Some(unix_ms_now());
                    runtime.snapshot.error = None;
                }
                Err(err) => {
                    if runtime.cancel.load(Ordering::Relaxed) {
                        runtime.snapshot.status = "cancelled".to_string();
                        runtime.snapshot.error = None;
                    } else {
                        runtime.snapshot.status = "failed".to_string();
                        runtime.snapshot.error = Some(err.to_string());
                    }
                    runtime.snapshot.ended_at = Some(unix_ms_now());
                }
            }
        }
    });

    Ok(snapshot)
}

#[tauri::command]
pub async fn transfer_query(task_id: String) -> Result<TransferTaskSnapshot, String> {
    let tasks = TRANSFER_TASKS.lock().map_err(|e| e.to_string())?;
    let runtime = tasks
        .get(&task_id)
        .ok_or_else(|| "Transfer task not found".to_string())?;
    Ok(runtime.snapshot.clone())
}

#[tauri::command]
pub async fn transfer_cancel(task_id: String) -> Result<(), String> {
    let mut tasks = TRANSFER_TASKS.lock().map_err(|e| e.to_string())?;
    let runtime = tasks
        .get_mut(&task_id)
        .ok_or_else(|| "Transfer task not found".to_string())?;
    runtime.cancel.store(true, Ordering::Relaxed);
    if runtime.snapshot.status == "running" {
        runtime.snapshot.phase = "transferring".to_string();
        runtime.snapshot.status = "cancelled".to_string();
        runtime.snapshot.ended_at = Some(unix_ms_now());
    }
    Ok(())
}
