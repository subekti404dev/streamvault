use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub database_url: String,
    pub auth_secret: String,
    pub public_base_url: String,
    pub gh_token: Option<String>,
    pub gh_repo: Option<String>,
    pub discord_bot_token: Option<String>,
    pub discord_channel_id: Option<String>,
    pub discord_channel_ids: Option<String>,
    pub telegram_bot_token: Option<String>,
    pub telegram_channel_id: Option<String>,
    pub torrentio_base_url: Option<String>,
    pub dashboard_dir: PathBuf,
}

impl Config {
    pub fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        let config = Config {
            database_url: std::env::var("STREAMVAULT_DATABASE_URL")
                .unwrap_or_else(|_| "sqlite:data/streamvault.db?mode=rwc".to_string()),
            auth_secret: std::env::var("STREAMVAULT_AUTH_SECRET")
                .unwrap_or_else(|_| "streamvault-dev-secret".to_string()),
            public_base_url: std::env::var("STREAMVAULT_PUBLIC_BASE_URL")
                .unwrap_or_else(|_| "http://localhost:8080".to_string()),
            gh_token: std::env::var("STREAMVAULT_GH_TOKEN").ok(),
            gh_repo: std::env::var("STREAMVAULT_GH_REPO").ok(),
            discord_bot_token: std::env::var("STREAMVAULT_DISCORD_BOT_TOKEN").ok(),
            discord_channel_id: std::env::var("STREAMVAULT_DISCORD_CHANNEL_ID").ok(),
            discord_channel_ids: std::env::var("STREAMVAULT_DISCORD_CHANNEL_IDS").ok(),
            telegram_bot_token: std::env::var("STREAMVAULT_TELEGRAM_BOT_TOKEN").ok(),
            telegram_channel_id: std::env::var("STREAMVAULT_TELEGRAM_CHANNEL_ID").ok(),
            torrentio_base_url: std::env::var("STREAMVAULT_TORRENTIO_BASE_URL").ok(),
            dashboard_dir: std::env::var("STREAMVAULT_DASHBOARD_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("dashboard/dist")),
        };
        Ok(config)
    }
}