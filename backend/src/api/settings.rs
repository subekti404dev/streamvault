use axum::{Json, extract::State};
use serde_json::{json, Value};
use std::sync::Arc;
use std::collections::HashMap;
use crate::{app::AppState, db::queries, error::{AppResult, AppError}};

pub async fn get_settings(
    State(state): State<Arc<AppState>>,
) -> AppResult<Json<Value>> {
    let settings = queries::get_all_settings(&state.db).await?;
    let db_map: HashMap<String, String> = settings.into_iter().map(|s| (s.key, s.value)).collect();

    let config = state.config.read().await;

    // Merge DB settings with env/Config settings (DB takes priority)
    let keys = [
        "gh_token", "gh_repo",
        "discord_bot_token", "discord_channel_id", "discord_channel_ids",
        "telegram_bot_token", "telegram_channel_id",
        "notifications_enabled",
        "torrentio_base_url",
        "public_base_url",
        "stremio_addon_id", "stremio_addon_name", "stremio_metadata_url",
    ];

    let mut map: HashMap<String, String> = HashMap::new();
    for &key in &keys {
        let value = db_map.get(key).cloned().or_else(|| {
            match key {
                "gh_token" => config.gh_token.clone(),
                "gh_repo" => config.gh_repo.clone(),
                "discord_bot_token" => config.discord_bot_token.clone(),
                "discord_channel_id" => config.discord_channel_id.clone(),
                "telegram_bot_token" => config.telegram_bot_token.clone(),
                "telegram_channel_id" => config.telegram_channel_id.clone(),
                "torrentio_base_url" => config.torrentio_base_url.clone(),
                "public_base_url" => Some(config.public_base_url.clone()),
                _ => None,
            }
        });

        if let Some(v) = value {
            let display = match key {
                "gh_token" | "discord_bot_token" | "telegram_bot_token" | "auth_secret" => {
                    mask_token(&v)
                }
                _ => v,
            };
            map.insert(key.to_string(), display);
        }
    }

    Ok(Json(json!(map)))
}

pub async fn update_settings(
    State(state): State<Arc<AppState>>,
    Json(body): Json<HashMap<String, String>>,
) -> AppResult<Json<Value>> {
    for (key, value) in &body {
        queries::upsert_setting(&state.db, key, value).await?;
    }

    // Reload config from DB
    {
        let mut config = state.config.write().await;
        if let Some(v) = queries::get_setting(&state.db, "gh_token").await? {
            config.gh_token = Some(v);
        }
        if let Some(v) = queries::get_setting(&state.db, "gh_repo").await? {
            config.gh_repo = Some(v);
        }
        if let Some(v) = queries::get_setting(&state.db, "discord_bot_token").await? {
            config.discord_bot_token = Some(v);
        }
        if let Some(v) = queries::get_setting(&state.db, "discord_channel_id").await? {
            config.discord_channel_id = Some(v);
        }
        if let Some(v) = queries::get_setting(&state.db, "telegram_bot_token").await? {
            config.telegram_bot_token = Some(v);
        }
        if let Some(v) = queries::get_setting(&state.db, "telegram_channel_id").await? {
            config.telegram_channel_id = Some(v);
        }
        if let Some(v) = queries::get_setting(&state.db, "torrentio_base_url").await? {
            config.torrentio_base_url = Some(v);
        }
        if let Some(v) = queries::get_setting(&state.db, "public_base_url").await? {
            config.public_base_url = v;
        }
    }

    Ok(Json(json!({ "status": "saved" })))
}

pub async fn test_notification(
    State(state): State<Arc<AppState>>,
) -> AppResult<Json<Value>> {
    // Verify Telegram is configured before sending
    let bot_token = queries::get_setting(&state.db, "telegram_bot_token").await?
        .filter(|t| !t.is_empty())
        .or_else(|| state.config.blocking_read().telegram_bot_token.clone())
        .ok_or_else(|| AppError::BadRequest("Telegram bot token not configured".into()))?;

    let channel_id = queries::get_setting(&state.db, "telegram_channel_id").await?
        .filter(|t| !t.is_empty())
        .or_else(|| state.config.blocking_read().telegram_channel_id.clone())
        .ok_or_else(|| AppError::BadRequest("Telegram channel ID not configured".into()))?;

    // Send a test message directly
    let url = format!("https://api.telegram.org/bot{}/sendMessage", bot_token);
    let resp = state.http.post(&url)
        .json(&serde_json::json!({
            "chat_id": channel_id,
            "text": "🔔 <b>StreamVault</b>\n\nTest notification — if you see this, Telegram is working!",
            "parse_mode": "HTML"
        }))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Telegram API request failed: {}", e)))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "Telegram API error ({}): {}", status, body
        )));
    }

    Ok(Json(json!({ "ok": true })))
}

fn mask_token(token: &str) -> String {
    if token.len() <= 8 {
        return "****".to_string();
    }
    format!("{}****{}", &token[..4], &token[token.len()-4..])
}
