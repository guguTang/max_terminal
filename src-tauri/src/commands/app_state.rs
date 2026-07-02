use crate::db::app_state::{clear_app_state, load_app_state, save_app_state};
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub fn get_app_state(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    load_app_state(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_app_state_cmd(state: State<'_, AppState>, json: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    save_app_state(&conn, &json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_app_state_cmd(state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    clear_app_state(&conn).map_err(|e| e.to_string())
}
