use crate::local::LOCAL_SESSION_ID;
use crate::ssh::pty::{
    apply_terminal_state, create_terminal, install_cwd_hook, query_cwd, resize_terminal, write_input,
    TerminalHandle,
};
use crate::ssh::session::SessionInner;
use crate::ssh::terminal_meta::{is_valid_cwd_path, TerminalMeta};
use crate::state::AppState;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, State};

fn normalize_terminal_id(terminal_id: Option<String>) -> String {
    terminal_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| "main".to_string())
}

fn is_local_session(session_id: &str) -> bool {
    session_id == LOCAL_SESSION_ID
}

async fn create_terminal_for_session(
    inner: &mut SessionInner,
    app: AppHandle,
    session_id: String,
    terminal_id: String,
    cols: u32,
    rows: u32,
) -> Result<TerminalHandle, String> {
    let mut last_error = String::new();
    for attempt in 0..2 {
        let _io_guard = inner.terminal_io_lock.lock().await;
        match create_terminal(
            &mut inner.terminal_handle,
            app.clone(),
            session_id.clone(),
            terminal_id.clone(),
            cols,
            rows,
        )
        .await
        {
            Ok(terminal) => return Ok(terminal),
            Err(err) => {
                let message = err.to_string();
                last_error = message.clone();
                let should_retry = attempt == 0
                    && (message.contains("ConnectFailed") || message.contains("open terminal channel"));
                drop(_io_guard);
                if should_retry {
                    // Reconnecting the transport closes every existing shell channel.
                    // Drop stale handles so later terminal_create/resize don't hit
                    // "channel closed" on zombie PTYs.
                    let stale = std::mem::take(&mut inner.terminals);
                    for (_, terminal) in stale {
                        terminal.stop().await;
                    }
                    inner
                        .reconnect_terminal_transport()
                        .await
                        .map_err(|e| e.to_string())?;
                    continue;
                }
                return Err(message);
            }
        }
    }
    Err(last_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCreateOptions {
    pub initial_cwd: Option<String>,
    #[serde(default)]
    pub initial_env: HashMap<String, String>,
    pub cols: Option<u32>,
    pub rows: Option<u32>,
}

#[tauri::command]
pub async fn terminal_create(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    terminal_id: Option<String>,
    options: Option<TerminalCreateOptions>,
) -> Result<(), String> {
    let terminal_id = normalize_terminal_id(terminal_id);
    let options = options.unwrap_or(TerminalCreateOptions {
        initial_cwd: None,
        initial_env: HashMap::new(),
        cols: None,
        rows: None,
    });
    let cols = options.cols.unwrap_or(120).max(1);
    let rows = options.rows.unwrap_or(40).max(1);

    if is_local_session(&session_id) {
        let mut local = state.local_terminals.lock().await;
        local
            .create(
                app,
                terminal_id,
                cols,
                rows,
                options.initial_cwd,
                options.initial_env,
            )
            .await?;
        return Ok(());
    }

    let session = {
        let sessions = state.sessions.lock().await;
        sessions
            .get(&session_id)
            .map(|s| s.clone())
            .ok_or_else(|| "Session not found".to_string())?
    };

    let has_state = options
        .initial_cwd
        .as_ref()
        .map(|path| is_valid_cwd_path(path))
        .unwrap_or(false)
        || !options.initial_env.is_empty();

    // Replace dead PTY handles left behind after shell/SSH channel exit.
    {
        let dead = {
            let mut inner = session.lock().await;
            match inner.terminals.get(&terminal_id) {
                Some(existing) if existing.is_alive() => {
                    return Ok(());
                }
                Some(_) => inner.terminals.remove(&terminal_id),
                None => None,
            }
        };
        if let Some(dead) = dead {
            dead.stop().await;
        }
    }

    let terminal = {
        let mut inner = session.lock().await;
        if let Some(existing) = inner.terminals.get(&terminal_id) {
            if existing.is_alive() {
                return Ok(());
            }
            inner.terminals.remove(&terminal_id);
        }

        let meta_cwd = options
            .initial_cwd
            .clone()
            .filter(|path| is_valid_cwd_path(path))
            .unwrap_or_else(|| inner.home_path.clone());

        let terminal = Arc::new(
            create_terminal_for_session(&mut inner, app, session_id.clone(), terminal_id.clone(), cols, rows)
                .await
                .map_err(|e| e.to_string())?,
        );

        inner.terminals.insert(terminal_id.clone(), terminal.clone());
        inner.terminal_meta.insert(
            terminal_id.clone(),
            TerminalMeta {
                cwd: meta_cwd.clone(),
                env: options.initial_env.clone(),
            },
        );

        terminal
    };

    if has_state {
        let cwd = options.initial_cwd.as_deref();
        apply_terminal_state(&terminal, cwd, &options.initial_env)
            .await
            .map_err(|e| e.to_string())?;
    }

    let _ = install_cwd_hook(&terminal).await;

    Ok(())
}

#[tauri::command]
pub async fn terminal_apply_state(
    state: State<'_, AppState>,
    session_id: String,
    terminal_id: Option<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
) -> Result<(), String> {
    let terminal_id = normalize_terminal_id(terminal_id);
    let env = env.unwrap_or_default();

    if is_local_session(&session_id) {
        let mut local = state.local_terminals.lock().await;
        return local
            .apply_state(&terminal_id, cwd, env)
            .await;
    }

    let session = {
        let sessions = state.sessions.lock().await;
        sessions
            .get(&session_id)
            .map(|s| s.clone())
            .ok_or_else(|| "Session not found".to_string())?
    };

    let cwd_for_meta = cwd.clone();

    let terminal = {
        let inner = session.lock().await;
        inner
            .terminals
            .get(&terminal_id)
            .cloned()
            .ok_or_else(|| "Terminal not started".to_string())?
    };

    let cwd_ref = cwd_for_meta.as_deref().filter(|path| !path.is_empty());
    apply_terminal_state(&terminal, cwd_ref, &env)
        .await
        .map_err(|e| e.to_string())?;

    let mut inner = session.lock().await;
    let home_path = inner.home_path.clone();
    let meta = inner
        .terminal_meta
        .entry(terminal_id)
        .or_insert_with(|| TerminalMeta {
            cwd: home_path,
            env: HashMap::new(),
        });

    if let Some(cwd) = cwd_for_meta.filter(|path| !path.is_empty()) {
        meta.cwd = cwd;
    }
    for (key, value) in env {
        if !key.is_empty() {
            meta.env.insert(key, value);
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn terminal_get_meta(
    state: State<'_, AppState>,
    session_id: String,
    terminal_id: Option<String>,
) -> Result<TerminalMeta, String> {
    let terminal_id = normalize_terminal_id(terminal_id);

    if is_local_session(&session_id) {
        let local = state.local_terminals.lock().await;
        return local
            .get_meta(&terminal_id)
            .ok_or_else(|| "Terminal metadata not found".to_string());
    }

    let session = {
        let sessions = state.sessions.lock().await;
        sessions
            .get(&session_id)
            .map(|s| s.clone())
            .ok_or_else(|| "Session not found".to_string())?
    };

    let inner = session.lock().await;
    inner
        .terminal_meta
        .get(&terminal_id)
        .cloned()
        .ok_or_else(|| "Terminal metadata not found".to_string())
}

#[tauri::command]
pub async fn terminal_update_meta(
    state: State<'_, AppState>,
    session_id: String,
    terminal_id: Option<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    unset_env: Option<Vec<String>>,
) -> Result<(), String> {
    let terminal_id = normalize_terminal_id(terminal_id);

    if is_local_session(&session_id) {
        let mut local = state.local_terminals.lock().await;
        local.update_meta(&terminal_id, cwd, env, unset_env);
        return Ok(());
    }

    let session = {
        let sessions = state.sessions.lock().await;
        sessions
            .get(&session_id)
            .map(|s| s.clone())
            .ok_or_else(|| "Session not found".to_string())?
    };

    let mut inner = session.lock().await;
    let home_path = inner.home_path.clone();
    let meta = inner
        .terminal_meta
        .entry(terminal_id)
        .or_insert_with(|| TerminalMeta {
            cwd: home_path,
            env: HashMap::new(),
        });

    if let Some(cwd) = cwd.filter(|path| is_valid_cwd_path(path)) {
        meta.cwd = cwd;
    }
    if let Some(env) = env {
        for (key, value) in env {
            if key.is_empty() {
                continue;
            }
            meta.env.insert(key, value);
        }
    }
    if let Some(keys) = unset_env {
        for key in keys {
            meta.env.remove(&key);
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn terminal_query_cwd(
    state: State<'_, AppState>,
    session_id: String,
    terminal_id: Option<String>,
) -> Result<String, String> {
    let terminal_id = normalize_terminal_id(terminal_id);

    if is_local_session(&session_id) {
        let local = state.local_terminals.lock().await;
        return local.query_cwd(&terminal_id).await;
    }

    let session = {
        let sessions = state.sessions.lock().await;
        sessions
            .get(&session_id)
            .map(|s| s.clone())
            .ok_or_else(|| "Session not found".to_string())?
    };

    let terminal = {
        let inner = session.lock().await;
        inner
            .terminals
            .get(&terminal_id)
            .cloned()
            .ok_or_else(|| "Terminal not started".to_string())?
    };

    query_cwd(&terminal).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn terminal_destroy(
    state: State<'_, AppState>,
    session_id: String,
    terminal_id: Option<String>,
) -> Result<(), String> {
    if is_local_session(&session_id) {
        let mut local = state.local_terminals.lock().await;
        local
            .destroy(terminal_id.map(|id| normalize_terminal_id(Some(id))))
            .await;
        return Ok(());
    }

    let session = {
        let sessions = state.sessions.lock().await;
        sessions
            .get(&session_id)
            .map(|s| s.clone())
            .ok_or_else(|| "Session not found".to_string())?
    };

    let mut inner = session.lock().await;
    if let Some(terminal_id) = terminal_id {
        let terminal_id = normalize_terminal_id(Some(terminal_id));
        if let Some(terminal) = inner.terminals.remove(&terminal_id) {
            terminal.stop().await;
        }
        inner.terminal_meta.remove(&terminal_id);
    } else {
        for (_, terminal) in std::mem::take(&mut inner.terminals) {
            terminal.stop().await;
        }
        inner.terminal_meta.clear();
    }
    Ok(())
}

#[tauri::command]
pub async fn terminal_destroy_all_local(state: State<'_, AppState>) -> Result<(), String> {
    let mut local = state.local_terminals.lock().await;
    local.destroy(None).await;
    Ok(())
}

#[tauri::command]
pub async fn terminal_input(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
    terminal_id: Option<String>,
) -> Result<(), String> {
    let terminal_id = normalize_terminal_id(terminal_id);

    if is_local_session(&session_id) {
        let local = state.local_terminals.lock().await;
        return local.write_input(&terminal_id, &data).await;
    }

    let session = {
        let sessions = state.sessions.lock().await;
        sessions
            .get(&session_id)
            .map(|s| s.clone())
            .ok_or_else(|| "Session not found".to_string())?
    };

    let terminal = {
        let inner = session.lock().await;
        inner
            .terminals
            .get(&terminal_id)
            .cloned()
            .ok_or_else(|| "Terminal not started".to_string())?
    };

    write_input(&terminal, &data)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn terminal_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
    terminal_id: Option<String>,
) -> Result<(), String> {
    let terminal_id = normalize_terminal_id(terminal_id);

    if is_local_session(&session_id) {
        let local = state.local_terminals.lock().await;
        return local.resize(&terminal_id, cols, rows).await;
    }

    let session = {
        let sessions = state.sessions.lock().await;
        sessions
            .get(&session_id)
            .map(|s| s.clone())
            .ok_or_else(|| "Session not found".to_string())?
    };

    let terminal = {
        let inner = session.lock().await;
        inner
            .terminals
            .get(&terminal_id)
            .cloned()
            .ok_or_else(|| "Terminal not started".to_string())?
    };

    resize_terminal(&terminal, cols, rows)
        .await
        .map_err(|e| e.to_string())
}
