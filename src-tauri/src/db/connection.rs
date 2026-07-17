use crate::db::app_state::init_app_state_table;
use rusqlite::{params, Connection, Result as SqliteResult};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionRecord {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub created_at: i64,
    /// 前端字段名为 `group`；DB 列名为 `group_name`（避开 SQL 保留字）
    #[serde(default, rename = "group")]
    pub group_name: Option<String>,
}

fn normalize_group_name(value: &Option<String>) -> Option<String> {
    value
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn migrate_connections_table(conn: &Connection) -> SqliteResult<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(connections)")?;
    let columns: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .collect();
    if !columns.iter().any(|c| c == "group_name") {
        conn.execute("ALTER TABLE connections ADD COLUMN group_name TEXT", [])?;
    }
    Ok(())
}

pub fn init_db(path: &Path) -> SqliteResult<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let conn = Connection::open(path)?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS connections (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL DEFAULT 22,
            username TEXT NOT NULL,
            auth_type TEXT NOT NULL,
            password TEXT,
            private_key TEXT,
            created_at INTEGER NOT NULL,
            group_name TEXT
        )",
        [],
    )?;
    migrate_connections_table(&conn)?;
    init_app_state_table(&conn)?;
    Ok(conn)
}

fn map_connection_row(row: &rusqlite::Row<'_>) -> SqliteResult<ConnectionRecord> {
    Ok(ConnectionRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        host: row.get(2)?,
        port: row.get::<_, i64>(3)? as u16,
        username: row.get(4)?,
        auth_type: row.get(5)?,
        password: row.get(6)?,
        private_key: row.get(7)?,
        created_at: row.get(8)?,
        group_name: normalize_group_name(&row.get::<_, Option<String>>(9)?),
    })
}

pub fn list_connections(conn: &Connection) -> SqliteResult<Vec<ConnectionRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, host, port, username, auth_type, password, private_key, created_at, group_name
         FROM connections
         ORDER BY COALESCE(group_name, '') ASC, created_at DESC",
    )?;
    let rows = stmt.query_map([], map_connection_row)?;
    rows.collect()
}

pub fn get_connection(conn: &Connection, id: &str) -> SqliteResult<Option<ConnectionRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, host, port, username, auth_type, password, private_key, created_at, group_name
         FROM connections WHERE id = ?1",
    )?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(map_connection_row(row)?))
    } else {
        Ok(None)
    }
}

pub fn save_connection(conn: &Connection, record: &ConnectionRecord) -> SqliteResult<()> {
    let group_name = normalize_group_name(&record.group_name);
    conn.execute(
        "INSERT INTO connections (id, name, host, port, username, auth_type, password, private_key, created_at, group_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            host = excluded.host,
            port = excluded.port,
            username = excluded.username,
            auth_type = excluded.auth_type,
            password = excluded.password,
            private_key = excluded.private_key,
            group_name = excluded.group_name",
        params![
            record.id,
            record.name,
            record.host,
            record.port,
            record.username,
            record.auth_type,
            record.password,
            record.private_key,
            record.created_at,
            group_name,
        ],
    )?;
    Ok(())
}

pub fn delete_connection(conn: &Connection, id: &str) -> SqliteResult<()> {
    conn.execute("DELETE FROM connections WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn new_connection_id() -> String {
    Uuid::new_v4().to_string()
}

pub fn now_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
