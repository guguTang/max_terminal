use crate::local::LOCAL_SESSION_ID;
use crate::ssh::context::{query_terminal_context, TerminalContextResult};
use crate::state::AppState;
use std::collections::HashMap;
use tauri::State;

#[tauri::command]
pub async fn terminal_query_context(
    state: State<'_, AppState>,
    session_id: String,
    cwd: String,
    env: Option<HashMap<String, String>>,
    providers: Option<Vec<String>>,
) -> Result<TerminalContextResult, String> {
    let env = env.unwrap_or_default();
    let providers = providers.unwrap_or_else(|| {
        vec![
            "git".to_string(),
            "svn".to_string(),
            "k8s".to_string(),
            "pyenv".to_string(),
            "node".to_string(),
        ]
    });

    let session = if session_id == LOCAL_SESSION_ID {
        None
    } else {
        let sessions = state.sessions.lock().await;
        Some(
            sessions
                .get(&session_id)
                .ok_or_else(|| "Session not found".to_string())?
                .clone(),
        )
    };

    query_terminal_context(
        &session_id,
        session.as_ref(),
        &cwd,
        &env,
        &providers,
    )
    .await
    .map_err(|e| e.to_string())
}
