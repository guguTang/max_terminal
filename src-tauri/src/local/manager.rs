use crate::local::pty::{
    apply_terminal_state, create_local_terminal, query_cwd, resize_terminal, write_input,
    LocalTerminalHandle,
};
use crate::local::{default_home_dir, is_valid_local_cwd_path, LOCAL_SESSION_ID};
use crate::ssh::terminal_meta::TerminalMeta;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::AppHandle;

pub struct LocalTerminalManager {
    terminals: HashMap<String, Arc<LocalTerminalHandle>>,
    terminal_meta: HashMap<String, TerminalMeta>,
    home_path: String,
}

impl LocalTerminalManager {
    pub fn new() -> Self {
        Self {
            terminals: HashMap::new(),
            terminal_meta: HashMap::new(),
            home_path: default_home_dir(),
        }
    }

    pub async fn create(
        &mut self,
        app: AppHandle,
        terminal_id: String,
        cols: u32,
        rows: u32,
        initial_cwd: Option<String>,
        initial_env: HashMap<String, String>,
    ) -> Result<Arc<LocalTerminalHandle>, String> {
        if let Some(existing) = self.terminals.get(&terminal_id) {
            if existing.is_alive() {
                return Ok(existing.clone());
            }
            existing.stop().await;
            self.terminals.remove(&terminal_id);
            self.terminal_meta.remove(&terminal_id);
        }

        let meta_cwd = initial_cwd
            .clone()
            .filter(|path| is_valid_local_cwd_path(path))
            .unwrap_or_else(|| self.home_path.clone());

        let terminal = Arc::new(
            create_local_terminal(
                app.clone(),
                LOCAL_SESSION_ID.to_string(),
                terminal_id.clone(),
                cols,
                rows,
                initial_cwd.clone(),
                initial_env.clone(),
            )
            .await
            .map_err(|e| e.to_string())?,
        );

        self.terminals
            .insert(terminal_id.clone(), terminal.clone());
        self.terminal_meta.insert(
            terminal_id.clone(),
            TerminalMeta {
                cwd: meta_cwd,
                env: initial_env.clone(),
            },
        );

        let has_state = initial_cwd
            .as_ref()
            .map(|path| is_valid_local_cwd_path(path))
            .unwrap_or(false)
            || !initial_env.is_empty();

        if has_state {
            let cwd = initial_cwd.as_deref();
            apply_terminal_state(&terminal, cwd, &initial_env)
                .await
                .map_err(|e| e.to_string())?;
        }

        Ok(terminal)
    }

    pub fn get_meta(&self, terminal_id: &str) -> Option<TerminalMeta> {
        self.terminal_meta.get(terminal_id).cloned()
    }

    pub async fn destroy(&mut self, terminal_id: Option<String>) {
        if let Some(terminal_id) = terminal_id {
            if let Some(terminal) = self.terminals.remove(&terminal_id) {
                terminal.stop().await;
            }
            self.terminal_meta.remove(&terminal_id);
        } else {
            for (_, terminal) in std::mem::take(&mut self.terminals) {
                terminal.stop().await;
            }
            self.terminal_meta.clear();
        }
    }

    pub async fn apply_state(
        &mut self,
        terminal_id: &str,
        cwd: Option<String>,
        env: HashMap<String, String>,
    ) -> Result<(), String> {
        let terminal = self
            .terminals
            .get(terminal_id)
            .cloned()
            .ok_or_else(|| "Terminal not started".to_string())?;

        let cwd_ref = cwd.as_deref().filter(|path| !path.is_empty());
        apply_terminal_state(&terminal, cwd_ref, &env)
            .await
            .map_err(|e| e.to_string())?;

        let meta = self
            .terminal_meta
            .entry(terminal_id.to_string())
            .or_insert_with(|| TerminalMeta {
                cwd: self.home_path.clone(),
                env: HashMap::new(),
            });

        if let Some(cwd) = cwd.filter(|path| is_valid_local_cwd_path(path)) {
            meta.cwd = cwd;
        }
        for (key, value) in env {
            if !key.is_empty() {
                meta.env.insert(key, value);
            }
        }

        Ok(())
    }

    pub fn update_meta(
        &mut self,
        terminal_id: &str,
        cwd: Option<String>,
        env: Option<HashMap<String, String>>,
        unset_env: Option<Vec<String>>,
    ) {
        let meta = self
            .terminal_meta
            .entry(terminal_id.to_string())
            .or_insert_with(|| TerminalMeta {
                cwd: self.home_path.clone(),
                env: HashMap::new(),
            });

        if let Some(cwd) = cwd.filter(|path| is_valid_local_cwd_path(path)) {
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
    }

    pub async fn write_input(&self, terminal_id: &str, data: &str) -> Result<(), String> {
        let terminal = self
            .terminals
            .get(terminal_id)
            .ok_or_else(|| "Terminal not started".to_string())?;
        write_input(terminal, data)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn resize(&self, terminal_id: &str, cols: u32, rows: u32) -> Result<(), String> {
        let terminal = self
            .terminals
            .get(terminal_id)
            .ok_or_else(|| "Terminal not started".to_string())?;
        resize_terminal(terminal, cols, rows)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn query_cwd(&self, terminal_id: &str) -> Result<String, String> {
        let terminal = self
            .terminals
            .get(terminal_id)
            .ok_or_else(|| "Terminal not started".to_string())?;
        query_cwd(terminal).await.map_err(|e| e.to_string())
    }
}

impl Default for LocalTerminalManager {
    fn default() -> Self {
        Self::new()
    }
}
