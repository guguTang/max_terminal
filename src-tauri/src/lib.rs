mod commands;
mod db;
mod local;
mod ssh;
mod state;

use commands::app_state::{clear_app_state_cmd, clear_debug_data_cmd, exit_app, get_app_state, save_app_state_cmd};
use commands::connection::{
    delete_connection_cmd, list_connections_cmd, save_connection_cmd, test_connection_cmd,
};
use commands::sftp::{
    connect_ssh, disconnect_ssh, sftp_list_dir, sftp_read_file, sftp_read_file_base64,
    sftp_remove_path, sftp_rename_path, sftp_write_file, sftp_write_file_base64,
    save_local_file_base64, transfer_cancel, transfer_query, transfer_start_download,
    transfer_start_remote_copy, transfer_start_upload,
};
use commands::terminal::{
    terminal_apply_state, terminal_create, terminal_destroy, terminal_destroy_all_local,
    terminal_get_meta, terminal_input, terminal_query_cwd, terminal_resize, terminal_update_meta,
};
use commands::terminal_context::terminal_query_context;
use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            let db_path = data_dir.join("connections.db");
            let app_state = AppState::new(db_path).expect("failed to initialize database");
            app.manage(app_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_state,
            save_app_state_cmd,
            clear_app_state_cmd,
            clear_debug_data_cmd,
            exit_app,
            list_connections_cmd,
            save_connection_cmd,
            delete_connection_cmd,
            test_connection_cmd,
            connect_ssh,
            disconnect_ssh,
            sftp_list_dir,
            sftp_read_file,
            sftp_read_file_base64,
            sftp_write_file,
            sftp_write_file_base64,
            save_local_file_base64,
            sftp_remove_path,
            sftp_rename_path,
            transfer_start_upload,
            transfer_start_download,
            transfer_start_remote_copy,
            transfer_query,
            transfer_cancel,
            terminal_create,
            terminal_apply_state,
            terminal_destroy,
            terminal_destroy_all_local,
            terminal_get_meta,
            terminal_query_cwd,
            terminal_query_context,
            terminal_input,
            terminal_resize,
            terminal_update_meta,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
