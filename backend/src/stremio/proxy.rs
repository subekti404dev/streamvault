// ── HLS Proxy ─────────────────────────────────────────────────────────
// Serve HLS playlist (regenerated on-the-fly) and proxy segments from Discord.
// Reference: cachy/backend/src/hls/serve.rs, playlist.rs

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use futures::TryStreamExt;
use std::sync::Arc;

use crate::{app::AppState, db::queries, error::AppResult};

/// Resolve base URL from request headers (supports reverse proxy).
fn resolve_base_url(state: &Arc<AppState>, headers: &HeaderMap) -> String {
    // Try X-Forwarded-Host + X-Forwarded-Proto first (reverse proxy)
    if let (Some(host), Some(proto)) = (
        headers.get("x-forwarded-host").and_then(|v| v.to_str().ok()),
        headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()),
    ) {
        return format!("{}://{}", proto, host);
    }

    // Try Host header
    if let Some(host) = headers.get("host").and_then(|v| v.to_str().ok()) {
        let proto = if headers
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
            == Some("https")
        {
            "https"
        } else {
            "http"
        };
        return format!("{}://{}", proto, host);
    }

    // Fallback to config
    let config = state.config.try_read();
    if let Ok(c) = config {
        return c.public_base_url.clone();
    }

    "http://localhost:8080".to_string()
}

/// Serve the HLS playlist for a completed job.
/// Regenerated on every request so segment URLs are always fresh.
pub async fn playlist_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(job_id): Path<String>,
) -> AppResult<impl IntoResponse> {
    let _job = queries::get_job(&state.db, &job_id).await?;
    let all_chunks = queries::get_hls_chunks(&state.db, &job_id).await?;

    // Filter only .ts segments (exclude .m3u8 playlists)
    let chunks: Vec<_> = all_chunks
        .into_iter()
        .filter(|c| c.filename.ends_with(".ts"))
        .collect();

    if chunks.is_empty() {
        return Err(crate::error::AppError::NotFound(
            "No HLS segments found for this job".into(),
        ));
    }

    let base_url = resolve_base_url(&state, &headers);

    // Build playlist from stored chunk data
    let target_duration = chunks
        .iter()
        .filter_map(|c| c.duration_seconds)
        .map(|d| d.ceil() as i64)
        .max()
        .unwrap_or(6)
        .max(1);

    let mut playlist = String::with_capacity(256 + chunks.len() * 120);
    playlist.push_str("#EXTM3U\n");
    playlist.push_str("#EXT-X-VERSION:3\n");
    playlist.push_str(&format!("#EXT-X-TARGETDURATION:{}\n", target_duration));
    playlist.push_str("#EXT-X-MEDIA-SEQUENCE:0\n");
    playlist.push_str("#EXT-X-PLAYLIST-TYPE:VOD\n");

    for chunk in &chunks {
        let duration = chunk.duration_seconds.unwrap_or(6.0);
        playlist.push_str(&format!("#EXTINF:{:.6},\n", duration));
        playlist.push_str(&format!(
            "{}/proxy/hls/{}/{}\n",
            base_url, job_id, chunk.filename
        ));
    }

    playlist.push_str("#EXT-X-ENDLIST\n");

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/vnd.apple.mpegurl"),
            (header::CACHE_CONTROL, "no-cache"),
            (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
        ],
        playlist,
    ))
}

/// Proxy a single HLS segment from Discord CDN with streaming.
/// Falls back to Discord API refresh if the stored URL has expired.
pub async fn chunk_handler(
    State(state): State<Arc<AppState>>,
    Path((job_id, filename)): Path<(String, String)>,
) -> Response {
    // Look up chunk metadata: (discord_url, discord_message_id)
    let chunk: Option<(Option<String>, Option<String>)> = sqlx::query_as::<_, (Option<String>, Option<String>)>(
        "SELECT discord_url, discord_message_id FROM hls_chunks WHERE job_id = ?1 AND filename = ?2",
    )
    .bind(&job_id)
    .bind(&filename)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();

    let Some((Some(stored_url), msg_id)) = chunk else {
        return (StatusCode::NOT_FOUND, "segment not found").into_response();
    };

    // Try stored URL first with streaming
    match fetch_segment_stream(&stored_url).await {
        Ok(stream) => serve_segment_stream(stream),
        Err(_) => {
            // URL likely expired — try refreshing via Discord API
            if let Some(refresh_url) = refresh_cdn_url(&state, &msg_id).await {
                if let Ok(stream) = fetch_segment_stream(&refresh_url).await {
                    // Update stored URL for future requests
                    let _ = sqlx::query(
                        "UPDATE hls_chunks SET discord_url = ?1 WHERE job_id = ?2 AND filename = ?3",
                    )
                    .bind(&refresh_url)
                    .bind(&job_id)
                    .bind(&filename)
                    .execute(&state.db)
                    .await;
                    return serve_segment_stream(stream);
                }
            }

            (
                StatusCode::BAD_GATEWAY,
                "failed to fetch segment from Discord",
            )
                .into_response()
        }
    }
}

async fn fetch_segment_stream(
    url: &str,
) -> Result<
    impl futures::Stream<Item = Result<axum::body::Bytes, std::io::Error>>,
    (),
> {
    let resp = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|e| {
            tracing::warn!("chunk_handler: discord request error: {e}");
        })?;

    if !resp.status().is_success() {
        tracing::warn!("chunk_handler: discord returned {}", resp.status());
        return Err(());
    }

    Ok(resp.bytes_stream().map_err(std::io::Error::other))
}

fn serve_segment_stream(
    stream: impl futures::Stream<Item = Result<axum::body::Bytes, std::io::Error>>
        + Send
        + 'static,
) -> Response {
    let body = axum::body::Body::from_stream(stream);
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "video/mp2t"),
            (header::CACHE_CONTROL, "public, max-age=31536000"),
            (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
        ],
        body,
    )
        .into_response()
}

/// Refresh a Discord CDN URL by fetching the message again.
/// Discord CDN URLs expire after ~24 hours.
async fn refresh_cdn_url(state: &Arc<AppState>, msg_id: &Option<String>) -> Option<String> {
    let mid = msg_id.as_ref()?;

    // Get Discord credentials from settings
    let channel_id = sqlx::query_scalar::<_, String>(
        "SELECT value FROM app_settings WHERE key = 'discord_channel_id'",
    )
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
    .unwrap_or_default();

    let bot_token = sqlx::query_scalar::<_, String>(
        "SELECT value FROM app_settings WHERE key = 'discord_bot_token'",
    )
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
    .unwrap_or_default();

    if channel_id.is_empty() || bot_token.is_empty() {
        // Try env vars as fallback
        let channel_id = std::env::var("DISCORD_CHANNEL_ID").unwrap_or_default();
        let bot_token = std::env::var("DISCORD_BOT_TOKEN").unwrap_or_default();
        if channel_id.is_empty() || bot_token.is_empty() {
            tracing::warn!("refresh_cdn_url: Discord credentials not configured");
            return None;
        }
        return refresh_cdn_url_with_creds(&bot_token, &channel_id, mid).await;
    }

    refresh_cdn_url_with_creds(&bot_token, &channel_id, mid).await
}

async fn refresh_cdn_url_with_creds(
    bot_token: &str,
    channel_id: &str,
    msg_id: &str,
) -> Option<String> {
    let url = format!(
        "https://discord.com/api/v10/channels/{channel_id}/messages/{msg_id}"
    );
    let resp = reqwest::Client::new()
        .get(&url)
        .header("Authorization", format!("Bot {bot_token}"))
        .send()
        .await
        .ok()?;

    let body: serde_json::Value = resp.json().await.ok()?;
    let attachments = body.get("attachments")?.as_array()?;
    let cdn_url = attachments.first()?.get("url")?.as_str()?;
    tracing::info!("Refreshed CDN URL for message {msg_id}");
    Some(cdn_url.to_string())
}
