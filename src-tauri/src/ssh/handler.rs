use async_trait::async_trait;
use russh::client;
use std::sync::Arc;
use std::time::Duration;

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
    let mut config = client::Config::default();
    // NAT / sshd ClientAlive / idle firewalls drop silent TCP within minutes.
    // Without client keepalives the UI stays "connected" while PTY/SFTP are dead.
    config.keepalive_interval = Some(Duration::from_secs(20));
    config.keepalive_max = 4;
    Arc::new(config)
}

#[cfg(test)]
mod tests {
    use super::default_config;
    use std::time::Duration;

    #[test]
    fn ssh_config_enables_keepalive() {
        let cfg = default_config();
        assert_eq!(cfg.keepalive_interval, Some(Duration::from_secs(20)));
        assert_eq!(cfg.keepalive_max, 4);
        assert_eq!(cfg.inactivity_timeout, None);
    }
}
