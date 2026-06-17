use axum::{Json, extract::State};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::{app::AppState, error::AppResult};

#[derive(Debug, Deserialize)]
pub struct SearchRequest {
    pub imdb_id: String,
    pub media_type: String,
    pub season: Option<i64>,
    pub episode: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct SearchResponse {
    pub meta: SearchMeta,
    pub torrents: Vec<TorrentEntry>,
}

#[derive(Debug, Serialize)]
pub struct SearchMeta {
    pub title: String,
    pub poster: Option<String>,
    pub year: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct TorrentEntry {
    pub name: String,
    pub title: String,
    pub filename: String,
    pub size_bytes: i64,
    pub infohash: String,
    pub magnet_uri: String,
    pub file_idx: i64,
}

const LOW_QUALITY_KEYWORDS: &[&str] = &[
    "cam", "screener", "3d", "ts", "tc", "hdcam", "hdts",
    "r5", "dvdscr", "hdscr", "telecine", "telesync", "hdtc",
    "dvdscreener", "bdscr", "ppv", "dvdrip", "vhsrip",
];

/// Score torrent quality by resolution (higher = better)
fn quality_score(title: &str) -> i32 {
    let lower = title.to_lowercase();
    if lower.contains("2160p") || lower.contains("4k") || lower.contains("uhd") {
        return 50;
    }
    if lower.contains("1080p") || lower.contains("fhd") {
        return 40;
    }
    if lower.contains("720p") || lower.contains("hd") {
        return 30;
    }
    if lower.contains("480p") || lower.contains("sd") {
        return 20;
    }
    // Default: assume SD
    10
}

/// Check if title contains low-quality keywords
fn is_low_quality(title: &str) -> bool {
    let lower = title.to_lowercase();
    // Remove spaces for keyword matching ("hd cam" -> "hdcam")
    let compact: String = lower.chars().filter(|c| !c.is_whitespace()).collect();
    LOW_QUALITY_KEYWORDS.iter().any(|&kw| compact.contains(kw))
}

/// Filter, sort by quality, and limit torrents
fn filter_torrents(mut torrents: Vec<TorrentEntry>, limit: usize) -> Vec<TorrentEntry> {
    // Step 1: Filter out low quality
    torrents.retain(|t| {
        !is_low_quality(&t.title) && !is_low_quality(&t.name)
    });

    // Step 2: Sort by quality (descending) then by size (descending) as tiebreaker
    torrents.sort_by(|a, b| {
        let score_a = quality_score(&a.title);
        let score_b = quality_score(&b.title);
        score_b.cmp(&score_a)
            .then(b.size_bytes.cmp(&a.size_bytes))
    });

    // Step 3: Limit
    torrents.truncate(limit);
    torrents
}

pub async fn search_handler(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SearchRequest>,
) -> AppResult<Json<SearchResponse>> {
    // Validate IMDB ID
    if !body.imdb_id.starts_with("tt") {
        return Err(crate::error::AppError::BadRequest("Invalid IMDB ID format".into()));
    }

    // Fetch metadata from Cinemeta
    let meta = fetch_cinemeta(&state, &body.imdb_id, &body.media_type).await?;

    // Build torrent search ID
    let stream_id = match body.media_type.as_str() {
        "series" => {
            let s = body.season.unwrap_or(1);
            let e = body.episode.unwrap_or(1);
            format!("{}:{}:{}", body.imdb_id, s, e)
        }
        _ => body.imdb_id.clone(),
    };

    // Search Torrentio
    let torrents = search_torrentio(&state, &body.media_type, &stream_id).await?;

    // Apply quality filter + sort + limit
    let torrents = filter_torrents(torrents, 5);

    Ok(Json(SearchResponse {
        meta: SearchMeta {
            title: meta.title.unwrap_or(body.imdb_id.clone()),
            poster: meta.poster_url,
            year: meta.year,
        },
        torrents,
    }))
}

async fn fetch_cinemeta(
    state: &Arc<AppState>,
    imdb_id: &str,
    media_type: &str,
) -> AppResult<crate::db::queries::CinemetaCache> {
    // Check cache first
    if let Some(cached) = crate::db::queries::get_cached_meta(&state.db, imdb_id, media_type).await? {
        return Ok(cached);
    }

    // Fetch from Cinemeta
    let url = format!("https://v3-cinemeta.strem.io/meta/{}/{}.json", media_type, imdb_id);
    let resp = state.http.get(&url).send().await?;
    let json: serde_json::Value = resp.json().await?;

    let meta = json.get("meta").ok_or_else(|| {
        crate::error::AppError::NotFound("Title not found in Cinemeta".into())
    })?;

    let record = crate::db::queries::CinemetaCache {
        imdb_id: imdb_id.to_string(),
        media_type: media_type.to_string(),
        title: meta.get("name").and_then(|v| v.as_str()).map(String::from),
        poster_url: meta.get("poster").and_then(|v| v.as_str()).map(String::from),
        overview: meta.get("overview").and_then(|v| v.as_str()).map(String::from),
        year: meta.get("year").and_then(|v| v.as_i64()),
        total_seasons: meta.get("totalSeasons").and_then(|v| v.as_i64()).or({
            if media_type == "series" {
                meta.get("meta").and_then(|m| m.get("totalSeasons")).and_then(|v| v.as_i64())
            } else {
                None
            }
        }),
        cached_at: None,
    };

    // Cache the result
    crate::db::queries::upsert_cached_meta(&state.db, &record).await?;

    Ok(record)
}

async fn search_torrentio(
    state: &Arc<AppState>,
    media_type: &str,
    stream_id: &str,
) -> AppResult<Vec<TorrentEntry>> {
    let base_url = state.config.read().await.torrentio_base_url.clone()
        .unwrap_or_else(|| "https://torrentio.strem.fun".to_string());

    let url = format!("{}/stream/{}/{}.json", base_url, media_type, stream_id);

    let resp = state.http.get(&url)
        .header("User-Agent", "StreamVault/1.0")
        .send()
        .await?;

    let json: serde_json::Value = resp.json().await?;
    let mut torrents = Vec::new();

    if let Some(streams) = json.get("streams").and_then(|v| v.as_array()) {
        for stream in streams {
            if let Some(info_hash) = stream.get("infoHash").and_then(|v| v.as_str()) {
                let name = stream.get("name").and_then(|v| v.as_str()).unwrap_or("Unknown");
                let title = stream.get("title").and_then(|v| v.as_str()).unwrap_or(info_hash);
                let file_idx = stream.get("fileIdx").and_then(|v| v.as_i64()).unwrap_or(0);
                
                // Extract filename from behaviorHints
                let filename = stream.get("behaviorHints")
                    .and_then(|bh| bh.get("filename"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                // Build magnet URI
                let magnet = format!("magnet:?xt=urn:btih:{}", info_hash);

                torrents.push(TorrentEntry {
                    name: name.to_string(),
                    title: title.to_string(),
                    filename,
                    size_bytes: stream.get("size").and_then(|v| v.as_i64()).unwrap_or(0),
                    infohash: info_hash.to_string(),
                    magnet_uri: magnet,
                    file_idx,
                });
            }
        }
    }

    Ok(torrents)
}
