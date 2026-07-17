use crate::db::connection::{
    delete_connection, list_connections, new_connection_id, now_timestamp, save_connection,
    ConnectionRecord,
};
use crate::ssh::session::connect;
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub fn list_connections_cmd(state: State<'_, AppState>) -> Result<Vec<ConnectionRecord>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    list_connections(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_connection_cmd(
    state: State<'_, AppState>,
    mut connection: ConnectionRecord,
) -> Result<ConnectionRecord, String> {
    if connection.id.is_empty() {
        connection.id = new_connection_id();
        connection.created_at = now_timestamp();
    }
    if let Some(group) = connection.group_name.as_mut() {
        let trimmed = group.trim();
        if trimmed.is_empty() {
            connection.group_name = None;
        } else {
            *group = trimmed.to_string();
        }
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    save_connection(&conn, &connection).map_err(|e| e.to_string())?;
    Ok(connection)
}

#[tauri::command]
pub fn delete_connection_cmd(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    delete_connection(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn test_connection_cmd(connection: ConnectionRecord) -> Result<(), String> {
    let (_session_id, session) = connect(&connection).await.map_err(|e| e.to_string())?;
    let inner = session.lock().await;
    inner
        .terminal_handle
        .disconnect(russh::Disconnect::ByApplication, "test complete", "")
        .await
        .ok();
    inner
        .sftp_handle
        .disconnect(russh::Disconnect::ByApplication, "test complete", "")
        .await
        .ok();
    Ok(())
}
