use crate::db::connection::ConnectionRecord;
use crate::ssh::handler::{default_config, SshHandler};
use crate::ssh::terminal_meta::TerminalMeta;
use anyhow::{anyhow, Context, Result};
use russh::client;
use russh::Disconnect;
use russh_keys::key;
use russh_sftp::client::SftpSession;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

pub struct SessionInner {
    pub connection: ConnectionRecord,
    pub home_path: String,
    pub sftp_handle: client::Handle<SshHandler>,
    pub terminal_handle: client::Handle<SshHandler>,
    pub terminal_io_lock: Mutex<()>,
    pub sftp: SftpSession,
    pub terminals: HashMap<String, Arc<crate::ssh::pty::TerminalHandle>>,
    pub terminal_meta: HashMap<String, TerminalMeta>,
}

pub type SharedSession = Arc<Mutex<SessionInner>>;

pub struct SessionManager {
    sessions: HashMap<String, SharedSession>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    pub fn get(&self, session_id: &str) -> Option<SharedSession> {
        self.sessions.get(session_id).cloned()
    }

    pub fn insert(&mut self, session_id: String, session: SharedSession) {
        self.sessions.insert(session_id, session);
    }

    pub async fn remove(&mut self, session_id: &str) {
        if let Some(session) = self.sessions.remove(session_id) {
            let mut inner = session.lock().await;
            for (_, terminal) in std::mem::take(&mut inner.terminals) {
                terminal.stop().await;
            }
            inner
                .terminal_handle
                .disconnect(Disconnect::ByApplication, "", "")
                .await
                .ok();
            inner
                .sftp_handle
                .disconnect(Disconnect::ByApplication, "", "")
                .await
                .ok();
        }
    }
}

impl SessionInner {
    pub async fn reconnect_terminal_transport(&mut self) -> Result<()> {
        self.terminal_handle
            .disconnect(Disconnect::ByApplication, "", "")
            .await
            .ok();
        self.terminal_handle = open_ssh_transport(&self.connection).await?;
        Ok(())
    }
}

pub async fn connect(record: &ConnectionRecord) -> Result<(String, SharedSession)> {
    let sftp_handle = open_ssh_transport(record).await?;

    let channel = sftp_handle
        .channel_open_session()
        .await
        .context("Failed to open SFTP channel")?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .context("Failed to start SFTP subsystem")?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .context("Failed to initialize SFTP session")?;

    let home_path = sftp
        .canonicalize(".")
        .await
        .context("Failed to resolve home directory")?;

    let terminal_handle = open_ssh_transport(record).await?;

    let session_id = Uuid::new_v4().to_string();
    let session = Arc::new(Mutex::new(SessionInner {
        connection: record.clone(),
        home_path,
        sftp_handle,
        terminal_handle,
        terminal_io_lock: Mutex::new(()),
        sftp,
        terminals: HashMap::new(),
        terminal_meta: HashMap::new(),
    }));

    Ok((session_id, session))
}

async fn open_ssh_transport(record: &ConnectionRecord) -> Result<client::Handle<SshHandler>> {
    let config = default_config();
    let addr = (record.host.as_str(), record.port);
    let mut handle = client::connect(config, addr, SshHandler)
        .await
        .with_context(|| format!("Failed to connect to {}:{}", record.host, record.port))?;

    authenticate(&mut handle, record).await?;
    Ok(handle)
}

async fn authenticate(handle: &mut client::Handle<SshHandler>, record: &ConnectionRecord) -> Result<()> {
    let authed = match record.auth_type.as_str() {
        "password" => {
            let password = record
                .password
                .as_deref()
                .ok_or_else(|| anyhow!("Password is required"))?;
            handle
                .authenticate_password(&record.username, password)
                .await
                .context("Password authentication failed")?
        }
        "private_key" => {
            let pem = record
                .private_key
                .as_deref()
                .ok_or_else(|| anyhow!("Private key is required"))?;
            let key_pair = decode_private_key(pem)?;
            handle
                .authenticate_publickey(&record.username, Arc::new(key_pair))
                .await
                .context("Private key authentication failed")?
        }
        other => return Err(anyhow!("Unsupported auth type: {other}")),
    };

    if !authed {
        return Err(anyhow!("Authentication rejected by server"));
    }
    Ok(())
}

fn decode_private_key(pem: &str) -> Result<key::KeyPair> {
    russh_keys::decode_secret_key(pem, None).map_err(|e| anyhow!("Invalid private key: {e}"))
}
