use rusqlite::{params, Connection, Result as SqliteResult};

pub fn init_app_state_table(conn: &Connection) -> SqliteResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            json TEXT NOT NULL
        )",
        [],
    )?;
    Ok(())
}

pub fn load_app_state(conn: &Connection) -> SqliteResult<Option<String>> {
    let mut stmt = conn.prepare("SELECT json FROM app_state WHERE id = 1")?;
    let mut rows = stmt.query([])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

pub fn save_app_state(conn: &Connection, json: &str) -> SqliteResult<()> {
    conn.execute(
        "INSERT INTO app_state (id, json) VALUES (1, ?1)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json",
        params![json],
    )?;
    Ok(())
}

pub fn clear_app_state(conn: &Connection) -> SqliteResult<()> {
    clear_debug_data(conn)
}

/// 清空除 `connections` 表外的所有 DB 数据（当前仅 `app_state`）。
pub fn clear_debug_data(conn: &Connection) -> SqliteResult<()> {
    conn.execute("DELETE FROM app_state WHERE id = 1", [])?;
    Ok(())
}
