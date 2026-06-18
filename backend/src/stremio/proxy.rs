// ── HLS Proxy ─────────────────────────────────────────────────────────
// Serve HLS playlist (regenerated on-the-fly) and proxy segments from Discord.
// Reference: cachy/backend/src/hls/serve.rs, playlist.rs

use axum::{
    extract::{Path, State, Request},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use futures::TryStreamExt;
use std::sync::Arc;

use crate::{app::AppState, db::queries, error::AppResult};

/// Resolve base URL from request headers (supports reverse proxy).
fn resolve_base_url(state: &Arc<AppState>, headers: &HeaderMap) -> String {
    if let (Some(host), Some(proto)) = (
        headers.get("x-forwarded-host").and_then(|v| v.to_str().ok()),
        headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()),
    ) {
        return format!("{}://{}", proto, host);
    }

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

    let config = state.config.try_read();
    if let Ok(c) = config {
        return c.public_base_url.clone();
    }

    "http://localhost:8080".to_string()
}

/// Serve the HLS playlist for a completed job.
pub async fn playlist_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(job_id): Path<String>,
) -> AppResult<impl IntoResponse> {
    let _job = queries::get_job(&state.db, &job_id).await?;
    let all_chunks = queries::get_hls_chunks(&state.db, &job_id).await?;

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
/// Supports HTTP Range requests for efficient seeking.
pub async fn chunk_handler(
    State(state): State<Arc<AppState>>,
    Path((job_id, filename)): Path<(String, String)>,
    req: Request,
) -> Response {
    // Look up chunk metadata
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

    // Get Range header from request
    let range_header = req.headers().get("range")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| parse_range(v));

    // Try stored URL first, then refresh if expired
    match try_fetch_chunk(&stored_url, range_header.as_ref()).await {
        Ok(resp) => resp,
        Err(_) => {
            // Try refreshing the CDN URL
            if let Some(refresh_url) = refresh_cdn_url(&state, &msg_id).await {
                if let Ok(resp) = try_fetch_chunk(&refresh_url, range_header.as_ref()).await {
                    // Update stored URL for future requests
                    let _ = sqlx::query(
                        "UPDATE hls_chunks SET discord_url = ?1 WHERE job_id = ?2 AND filename = ?3",
                    )
                    .bind(&refresh_url)
                    .bind(&job_id)
                    .bind(&filename)
                    .execute(&state.db)
                    .await;
                    return resp;
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

/// Parse HTTP Range header value: "bytes=0-1023" or "bytes=500-"
fn parse_range(value: &str) -> Option<String> {
    let range_part = value.strip_prefix("bytes=")?;
    Some(range_part.to_string())
}

/// Try fetching chunk from Discord with optional Range header.
async fn try_fetch_chunk(
    discord_url: &str,
    range: Option<&String>,
) -> Result<Response, ()> {
    let client = reqwest::Client::new();
    let mut req_builder = client.get(discord_url);

    if let Some(range_val) = range {
        req_builder = req_builder.header("Range", format!("bytes={}", range_val));
    }

    let resp = req_builder.send().await.map_err(|e| {
        tracing::warn!("chunk_proxy: discord request error: {e}");
    })?;

    let status = resp.status();
    let content_type = resp.headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("video/mp2t")
        .to_string();

    // Check if Discord supports range requests (206 = partial content)
    if status == StatusCode::PARTIAL_CONTENT || status == StatusCode::OK {
        let content_length = resp.headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok());

        let content_range = resp.headers()
            .get("content-range")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.to_string());

        let stream = resp.bytes_stream().map_err(std::io::Error::other);
        let body = axum::body::Body::from_stream(stream);

        let mut response = Response::builder()
            .status(if status == StatusCode::PARTIAL_CONTENT {
                StatusCode::PARTIAL_CONTENT
            } else {
                StatusCode::OK
            })
            .header(header::CONTENT_TYPE, &content_type)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range")
            .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Content-Range, Content-Length, Accept-Ranges, Content-Type")
            .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, OPTIONS")
            .header("Accept-Ranges", "bytes");

        if let Some(len) = content_length {
            response = response.header(header::CONTENT_LENGTH, len);
        }
        if let Some(ref cr) = content_range {
            response = response.header(header::CONTENT_RANGE, cr.as_str());
        }

        // Cache short chunks differently
        if status == StatusCode::PARTIAL_CONTENT {
            response = response.header(header::CACHE_CONTROL, "public, max-age=31536000");
        }

        Ok(response.body(body).unwrap())
    } else {
        tracing::warn!("chunk_proxy: discord returned status {}", status);
        Err(())
    }
}

/// Refresh a Discord CDN URL by fetching the message again.
async fn refresh_cdn_url(state: &Arc<AppState>, msg_id: &Option<String>) -> Option<String> {
    let mid = msg_id.as_ref()?;

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
