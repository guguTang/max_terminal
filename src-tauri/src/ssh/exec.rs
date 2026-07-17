#![allow(dead_code)]

use crate::ssh::session::SharedSession;
use anyhow::{anyhow, Result};
use russh::ChannelMsg;

pub struct RemoteCommandResult {
    pub exit_code: i32,
    pub output: String,
}

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

pub async fn run_remote_command(session: &SharedSession, command: &str) -> Result<i32> {
    Ok(run_remote_command_with_output(session, command).await?.exit_code)
}

pub async fn run_remote_command_with_output(
    session: &SharedSession,
    command: &str,
) -> Result<RemoteCommandResult> {
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

    let mut exit_status: Option<i32> = None;
    let mut output = String::new();
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { data }) => {
                output.push_str(&String::from_utf8_lossy(&data));
            }
            Some(ChannelMsg::ExtendedData { data, ext: 1 }) => {
                output.push_str(&String::from_utf8_lossy(&data));
            }
            Some(ChannelMsg::ExtendedData { .. }) => {}
            Some(ChannelMsg::ExitStatus { exit_status: status }) => {
                // Do not break early: more Data/Eof may still arrive after ExitStatus.
                exit_status = Some(status as i32);
            }
            Some(ChannelMsg::Eof) => {}
            Some(ChannelMsg::Close) | None => break,
            Some(_) => {}
        }
    }

    Ok(RemoteCommandResult {
        // If the channel closed without ExitStatus (race), prefer 0 over a false failure.
        exit_code: exit_status.unwrap_or(0),
        output,
    })
}
