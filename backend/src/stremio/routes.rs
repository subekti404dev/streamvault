use axum::{Json, extract::State};
use std::sync::Arc;
use crate::{app::AppState, db::queries, stremio::models::*};

pub async fn manifest_handler(
    State(state): State<Arc<AppState>>,
) -> Json<Manifest> {
    let _config = state.config.read().await;
    Json(Manifest {
        id: "com.streamvault.addon".to_string(),
        version: "1.0.0".to_string(),
        name: "StreamVault".to_string(),
        description: "Personal media library powered by StreamVault".to_string(),
        resources: vec!["catalog".into(), "meta".into(), "stream".into()],
        types_: vec!["movie".into(), "series".into()],
        catalogs: vec![
            CatalogDescriptor { type_: "movie".into(), id: "streamvault-movies".into(), name: "Movies".into() },
            CatalogDescriptor { type_: "series".into(), id: "streamvault-series".into(), name: "Series".into() },
        ],
        id_prefixes: vec!["tt".into()],
        behavior_hints: BehaviorHints {
            configurable: false,
            configuration_required: false,
        },
    })
}

pub async fn catalog_handler(
    State(state): State<Arc<AppState>>,
    axum::extract::Path((type_, _catalog_id)): axum::extract::Path<(String, String)>,
) -> Json<MetaResponse> {
    let completed = queries::list_jobs_by_status(&state.db, "completed").await
        .unwrap_or_default();

    let metas: Vec<MetaPreview> = match type_.as_str() {
        "movie" => {
            let mut seen = std::collections::HashSet::new();
            completed.iter()
                .filter(|j| j.media_type == "movie" && seen.insert(&j.imdb_id))
                .map(|j| MetaPreview {
                    id: j.imdb_id.clone(),
                    type_: "movie".into(),
                    name: j.title.clone().unwrap_or_else(|| "Unknown".to_string()),
                    poster: j.poster_url.clone(),
                    year: None,
                })
                .collect()
        }
        "series" => {
            let mut seen = std::collections::HashSet::new();
            completed.iter()
                .filter(|j| j.media_type == "series" && seen.insert(&j.imdb_id))
                .map(|j| MetaPreview {
                    id: j.imdb_id.clone(),
                    type_: "series".into(),
                    name: j.title.clone().unwrap_or_else(|| "Unknown".to_string()),
                    poster: j.poster_url.clone(),
                    year: None,
                })
                .collect()
        }
        _ => vec![],
    };

    Json(MetaResponse { metas })
}

pub async fn meta_handler(
    State(state): State<Arc<AppState>>,
    axum::extract::Path((type_, imdb_id)): axum::extract::Path<(String, String)>,
) -> Json<serde_json::Value> {
    let imdb_id = imdb_id.strip_suffix(".json").unwrap_or(&imdb_id);
    let url = format!("https://v3-cinemeta.strem.io/meta/{}/{}.json", type_, imdb_id);

    match state.http.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
            let mut body: serde_json::Value = resp.json().await.unwrap_or_default();
            // Mark as available in StreamVault
            if let Some(meta) = body.get_mut("meta") {
                if let Some(obj) = meta.as_object_mut() {
                    obj.insert("streamVault".into(), serde_json::json!({"available": true}));
                }
            }
            Json(body)
        }
        _ => Json(serde_json::json!({"meta": {}})),
    }
}

pub async fn stream_handler(
    State(state): State<Arc<AppState>>,
    axum::extract::Path((_type_, id)): axum::extract::Path<(String, String)>,
) -> Json<StreamResponse> {
    // Strip .json suffix if present (Axum captures it as part of the parameter)
    let id = id.strip_suffix(".json").unwrap_or(&id).to_string();
    let (imdb_id, season, episode) = parse_stream_id(&id);
    tracing::info!("stream_handler: imdb_id={}, season={:?}, episode={:?}", imdb_id, season, episode);

    // Find completed job matching imdb_id + optional season/episode
    let job = if let Some(s) = season {
        if let Some(e) = episode {
            sqlx::query_as::<_, crate::db::queries::Job>(
                "SELECT * FROM jobs WHERE status = 'completed' AND imdb_id = ? AND season = ? AND episode = ? LIMIT 1"
            )
            .bind(&imdb_id).bind(s).bind(e)
            .fetch_optional(&state.db).await
            .map_err(|e| tracing::error!("stream_handler query error: {}", e))
            .ok()
            .flatten()
        } else {
            sqlx::query_as::<_, crate::db::queries::Job>(
                "SELECT * FROM jobs WHERE status = 'completed' AND imdb_id = ? AND season = ? LIMIT 1"
            )
            .bind(&imdb_id).bind(s)
            .fetch_optional(&state.db).await
            .map_err(|e| tracing::error!("stream_handler query error: {}", e))
            .ok()
            .flatten()
        }
    } else {
        sqlx::query_as::<_, crate::db::queries::Job>(
            "SELECT * FROM jobs WHERE status = 'completed' AND imdb_id = ? LIMIT 1"
        )
        .bind(&imdb_id)
        .fetch_optional(&state.db).await
        .map_err(|e| tracing::error!("stream_handler query error: {}", e))
        .ok()
        .flatten()
    };

    tracing::info!("stream_handler: found job: {:?}", job.as_ref().map(|j| &j.id));

    let streams = match job {
        Some(j) => {
            let base_url = state.config.read().await.public_base_url.clone();
            let resolution = j.video_resolution.as_deref().unwrap_or("HD");
            let desc = if let (Some(s), Some(e)) = (j.season, j.episode) {
                format!("S{:02}E{:02} • {} • H.264 / AAC", s, e, resolution)
            } else {
                format!("{} • H.264 / AAC", resolution)
            };
            vec![Stream {
                name: format!("StreamVault\n{} H.264", resolution),
                url: format!("{}/proxy/hls/{}/master.m3u8", base_url, j.id),
                description: Some(desc),
            }]
        }
        None => vec![],
    };

    Json(StreamResponse { streams })
}

/// Parse Stremio stream ID into (imdb_id, season?, episode?)
/// Supports: "tt1234567" (movie) or "tt1234567:1:3" (series)
fn parse_stream_id(id: &str) -> (String, Option<i64>, Option<i64>) {
    let parts: Vec<&str> = id.split(':').collect();
    match parts.len() {
        3 => {
            let imdb_id = parts[0].to_string();
            let season = parts[1].parse().ok();
            let episode = parts[2].parse().ok();
            (imdb_id, season, episode)
        }
        _ => (id.to_string(), None, None),
    }
}
