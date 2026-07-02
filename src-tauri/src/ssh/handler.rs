use async_trait::async_trait;
use russh::client;
use std::sync::Arc;

pub struct SshHandler;

#[async_trait]
impl client::Handler for SshHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh_keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

pub fn default_config() -> Arc<client::Config> {
    Arc::new(client::Config::default())
}
