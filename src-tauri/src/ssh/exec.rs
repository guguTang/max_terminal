use crate::ssh::session::SharedSession;
use anyhow::{anyhow, Result};
use russh::ChannelMsg;

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

pub async fn run_remote_command(session: &SharedSession, command: &str) -> Result<i32> {
    let mut channel = {
        let inner = session.lock().await;
        inner
            .sftp_handle
            .channel_open_session()
            .await
            .map_err(|e| anyhow!("Failed to open exec channel: {e}"))?
    };

    channel
        .exec(true, command)
        .await
        .map_err(|e| anyhow!("Failed to execute remote command: {e}"))?;

    let mut exit_status = 1_u32;
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { .. }) | Some(ChannelMsg::ExtendedData { .. }) => {}
            Some(ChannelMsg::ExitStatus { exit_status: status }) => {
                exit_status = status;
                break;
            }
            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => break,
            Some(_) => {}
            None => break,
        }
    }

    Ok(exit_status as i32)
}
