use axum::{
    extract::{State, Path},
    response::IntoResponse,
};
use std::sync::Arc;
use crate::{app::AppState, db::queries, error::AppResult};

pub async fn playlist_handler(
    State(state): State<Arc<AppState>>,
    Path(job_id): Path<String>,
) -> AppResult<impl IntoResponse> {
    let _job = queries::get_job(&state.db, &job_id).await?;
    let chunks = queries::get_hls_chunks(&state.db, &job_id).await?;

    let base_url = state.config.read().await.public_base_url.clone();

    let mut playlist = String::from(
        "#EXTM3U\n#EXT-X-VERSION:3\n"
    );

    if let Some(max_duration) = chunks.iter()
        .filter_map(|c| c.duration_seconds)
        .map(|d| d.ceil() as i64)
        .max()
    {
        playlist.push_str(&format!("#EXT-X-TARGETDURATION:{}\n", max_duration));
    }

    playlist.push_str("#EXT-X-MEDIA-SEQUENCE:0\n");

    for chunk in &chunks {
        let duration = chunk.duration_seconds.unwrap_or(6.0);
        playlist.push_str(&format!("#EXTINF:{:.3},\n", duration));
        playlist.push_str(&format!("{}/proxy/hls/{}/{}\n", base_url, job_id, chunk.filename));
    }

    playlist.push_str("#EXT-X-ENDLIST\n");

    Ok((
        [(axum::http::header::CONTENT_TYPE, "application/vnd.apple.mpegurl")],
        playlist,
    ))
}

pub async fn chunk_handler(
    State(state): State<Arc<AppState>>,
    Path((job_id, filename)): Path<(String, String)>,
) -> AppResult<impl IntoResponse> {
    let chunks = queries::get_hls_chunks(&state.db, &job_id).await?;

    let chunk = chunks.into_iter()
        .find(|c| c.filename == filename)
        .ok_or_else(|| crate::error::AppError::NotFound(format!("Chunk {} not found", filename)))?;

    let url = chunk.discord_url
        .ok_or_else(|| crate::error::AppError::NotFound("Chunk URL not available".into()))?;

    // Proxy the chunk from Discord CDN
    let resp = state.http.get(&url).send().await
        .map_err(|_| crate::error::AppError::Internal("Failed to fetch chunk from Discord".into()))?;

    let bytes = resp.bytes().await
        .map_err(|_| crate::error::AppError::Internal("Failed to read chunk data".into()))?;

    let content_type = if filename.ends_with(".ts") {
        "video/mp2t"
    } else if filename.ends_with(".m3u8") {
        "application/vnd.apple.mpegurl"
    } else {
        "application/octet-stream"
    };

    Ok((
        [
            (axum::http::header::CONTENT_TYPE, content_type),
            (axum::http::header::CACHE_CONTROL, "public, max-age=31536000"),
            (axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
        ],
        bytes,
    ))
}
