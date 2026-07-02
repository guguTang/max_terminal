use crate::db::connection::init_db;
use crate::local::LocalTerminalManager;
use crate::ssh::session::SessionManager;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct AppState {
    pub db: Mutex<Connection>,
    pub sessions: tokio::sync::Mutex<SessionManager>,
    pub local_terminals: tokio::sync::Mutex<LocalTerminalManager>,
}

impl AppState {
    pub fn new(db_path: PathBuf) -> Result<Self, rusqlite::Error> {
        let db = init_db(&db_path)?;
        Ok(Self {
            db: Mutex::new(db),
            sessions: tokio::sync::Mutex::new(SessionManager::new()),
            local_terminals: tokio::sync::Mutex::new(LocalTerminalManager::new()),
        })
    }
}
