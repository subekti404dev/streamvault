use std::sync::Arc;
use crate::{app::AppState, db::queries, pipeline::trigger::get_setting_or_env};

pub enum TelegramEvent {
    JobQueued(String),
    JobStarted(String),
    CheckpointSaved(String, String),
    JobCompleted(String, String),
    JobFailed(String, String, String),
}

pub async fn send_telegram_notification(state: Arc<AppState>, event: TelegramEvent) {
    // Check if notifications enabled
    let enabled = queries::get_setting(&state.db, "notifications_enabled").await
        .ok()
        .flatten()
        .map(|v| v == "true")
        .unwrap_or(false);
    if !enabled { return; }

    let bot_token = match get_setting_or_env(&state, "telegram_bot_token").await {
        Ok(Some(t)) => t,
        _ => return,
    };
    let channel_id = match get_setting_or_env(&state, "telegram_channel_id").await {
        Ok(Some(c)) => c,
        _ => return,
    };

    let message = format_telegram_message(&event);

    let url = format!("https://api.telegram.org/bot{}/sendMessage", bot_token);
    let _ = state.http.post(&url)
        .json(&serde_json::json!({
            "chat_id": channel_id,
            "text": message,
            "parse_mode": "HTML"
        }))
        .send()
        .await;
}

fn format_telegram_message(event: &TelegramEvent) -> String {
    match event {
        TelegramEvent::JobQueued(title) => {
            format!("🎬 <b>Added to queue:</b> {}", title)
        }
        TelegramEvent::JobStarted(title) => {
            format!("⚙️ <b>Processing started:</b> {}", title)
        }
        TelegramEvent::CheckpointSaved(title, phase) => {
            format!("💾 <b>Checkpoint saved:</b> {} — {}", title, phase)
        }
        TelegramEvent::JobCompleted(title, details) => {
            format!(
                "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ <b>StreamVault - Download Complete</b>\n\n🎬 {}\n{}",
                title, details
            )
        }
        TelegramEvent::JobFailed(title, phase, error) => {
            format!("❌ <b>Failed:</b> {} at {} — {}", title, phase, error)
        }
    }
}
