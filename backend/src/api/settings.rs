use axum::{Json, extract::State};
use serde_json::{json, Value};
use std::sync::Arc;
use std::collections::HashMap;
use crate::{app::AppState, db::queries, error::AppResult};

pub async fn get_settings(
    State(state): State<Arc<AppState>>,
) -> AppResult<Json<Value>> {
    let settings = queries::get_all_settings(&state.db).await?;
    let mut map = HashMap::new();
    for s in settings {
        // Mask sensitive values
        let display = match s.key.as_str() {
            "gh_token" | "discord_bot_token" | "telegram_bot_token" | "auth_secret" => {
                mask_token(&s.value)
            }
            _ => s.value,
        };
        map.insert(s.key, display);
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

fn mask_token(token: &str) -> String {
    if token.len() <= 8 {
        return "****".to_string();
    }
    format!("{}****{}", &token[..4], &token[token.len()-4..])
}
