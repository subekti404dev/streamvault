use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use crate::error::AppResult;

// ── DB Models ──

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Job {
    pub id: String,
    pub imdb_id: String,
    pub media_type: String,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub title: Option<String>,
    pub poster_url: Option<String>,
    pub magnet_uri: Option<String>,
    pub infohash: Option<String>,
    pub torrent_name: Option<String>,
    pub file_idx: Option<i64>,
    pub file_size_bytes: Option<i64>,
    pub status: String,
    pub current_phase: Option<String>,
    pub progress_pct: Option<i64>,
    pub transcode_pct: Option<i64>,
    pub upload_pct: Option<i64>,
    pub last_checkpoint: Option<String>,
    pub gh_run_id: Option<String>,
    pub gh_artifact_id_dl: Option<String>,
    pub gh_artifact_id_tc: Option<String>,
    pub gh_artifact_dl_url: Option<String>,
    pub gh_artifact_tc_url: Option<String>,
    pub discord_channel_id: Option<String>,
    pub video_resolution: Option<String>,
    pub duration_seconds: Option<f64>,
    pub error_message: Option<String>,
    pub created_at: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct JobEvent {
    pub id: i64,
    pub job_id: String,
    pub phase: Option<String>,
    pub event_type: String,
    pub message: Option<String>,
    pub progress_pct: Option<i64>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct HlsChunk {
    pub id: i64,
    pub job_id: String,
    pub chunk_index: i64,
    pub filename: String,
    pub discord_url: Option<String>,
    pub discord_message_id: Option<String>,
    pub duration_seconds: Option<f64>,
    pub file_size_bytes: Option<i64>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, sqlx::FromRow)]
pub struct CinemetaCache {
    pub imdb_id: String,
    pub media_type: String,
    pub title: Option<String>,
    pub poster_url: Option<String>,
    pub overview: Option<String>,
    pub year: Option<i64>,
    pub total_seasons: Option<i64>,
    pub cached_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct AppSetting {
    pub key: String,
    pub value: String,
}

// ── Insert structs ──

#[derive(Debug, Serialize, Deserialize)]
pub struct NewJob {
    pub id: String,
    pub imdb_id: String,
    pub media_type: String,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub title: Option<String>,
    pub poster_url: Option<String>,
    pub magnet_uri: Option<String>,
    pub infohash: Option<String>,
    pub torrent_name: Option<String>,
    pub file_idx: Option<i64>,
    pub file_size_bytes: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NewHlsChunk {
    pub job_id: String,
    pub chunk_index: i64,
    pub filename: String,
    pub discord_url: Option<String>,
    pub discord_message_id: Option<String>,
    pub duration_seconds: Option<f64>,
    pub file_size_bytes: Option<i64>,
}

// ── Jobs ──

pub async fn insert_job(pool: &SqlitePool, job: &NewJob) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO jobs (id, imdb_id, media_type, season, episode, title, poster_url, magnet_uri, infohash, torrent_name, file_idx, file_size_bytes, status, progress_pct, transcode_pct, upload_pct, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 0, 0, datetime('now'), datetime('now'))"
    )
    .bind(&job.id).bind(&job.imdb_id).bind(&job.media_type)
    .bind(job.season).bind(job.episode).bind(&job.title)
    .bind(&job.poster_url).bind(&job.magnet_uri).bind(&job.infohash)
    .bind(&job.torrent_name).bind(job.file_idx).bind(job.file_size_bytes)
    .execute(pool).await?;
    Ok(())
}

pub async fn get_job(pool: &SqlitePool, id: &str) -> AppResult<Job> {
    Ok(sqlx::query_as::<_, Job>("SELECT * FROM jobs WHERE id = ?")
        .bind(id).fetch_one(pool).await?)
}

pub async fn list_jobs(pool: &SqlitePool) -> AppResult<Vec<Job>> {
    Ok(sqlx::query_as::<_, Job>("SELECT * FROM jobs ORDER BY created_at DESC")
        .fetch_all(pool).await?)
}

pub async fn list_jobs_by_status(pool: &SqlitePool, status: &str) -> AppResult<Vec<Job>> {
    Ok(sqlx::query_as::<_, Job>("SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC")
        .bind(status).fetch_all(pool).await?)
}

pub async fn list_jobs_by_statuses(pool: &SqlitePool, statuses: &[&str]) -> AppResult<Vec<Job>> {
    let placeholders: Vec<String> = statuses.iter().enumerate()
        .map(|(i, _)| format!("?{}", i + 1)).collect();
    let sql = format!(
        "SELECT * FROM jobs WHERE status IN ({}) ORDER BY created_at ASC",
        placeholders.join(",")
    );
    let mut q = sqlx::query_as::<_, Job>(&sql);
    for s in statuses {
        q = q.bind(s);
    }
    Ok(q.fetch_all(pool).await?)
}


pub async fn count_jobs_by_statuses(pool: &SqlitePool, statuses: &[&str]) -> AppResult<i64> {
    let placeholders: Vec<String> = (0..statuses.len()).map(|_| "?".to_string()).collect();
    let sql = format!(
        "SELECT COUNT(*) FROM jobs WHERE status IN ({})",
        placeholders.join(",")
    );
    let mut q = sqlx::query_scalar::<_, i64>(&sql);
    for s in statuses {
        q = q.bind(s);
    }
    Ok(q.fetch_one(pool).await?)
}
pub async fn get_next_queued_job(pool: &SqlitePool) -> AppResult<Option<Job>> {
    Ok(sqlx::query_as::<_, Job>(
        "SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1"
    ).fetch_optional(pool).await?)
}

pub async fn update_job_status(pool: &SqlitePool, id: &str, status: &str) -> AppResult<()> {
    sqlx::query("UPDATE jobs SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(status).bind(id).execute(pool).await?;
    Ok(())
}

pub async fn update_job_progress(pool: &SqlitePool, id: &str, phase: &str, pct: i32) -> AppResult<()> {
    let col = match phase {
        "transcode" => "transcode_pct",
        "upload" => "upload_pct",
        _ => "progress_pct",
    };
    let sql = format!("UPDATE jobs SET {} = ?, updated_at = datetime('now') WHERE id = ?", col);
    sqlx::query(&sql).bind(pct).bind(id).execute(pool).await?;
    Ok(())
}

pub async fn update_job_checkpoint(pool: &SqlitePool, id: &str, checkpoint: &str, artifact_id: Option<&str>, file_url: Option<&str>) -> AppResult<()> {
    if !["download", "transcode"].contains(&checkpoint) {
        return Ok(());
    }
    let new_status = format!("checkpoint_{}", checkpoint);
    let artifact_id_col = match checkpoint {
        "download" => "gh_artifact_id_dl",
        "transcode" => "gh_artifact_id_tc",
        _ => unreachable!(),
    };
    let artifact_url_col = match checkpoint {
        "download" => "gh_artifact_dl_url",
        "transcode" => "gh_artifact_tc_url",
        _ => unreachable!(),
    };
    let sql = format!(
        "UPDATE jobs SET last_checkpoint = ?, status = ?, {} = ?, {} = ?, updated_at = datetime('now') WHERE id = ?",
        artifact_id_col, artifact_url_col
    );
    sqlx::query(&sql)
        .bind(checkpoint)
        .bind(&new_status)
        .bind(artifact_id)
        .bind(file_url)
        .bind(id)
        .execute(pool).await?;
    Ok(())
}

pub async fn update_job_gh_run(pool: &SqlitePool, id: &str, run_id: &str) -> AppResult<()> {
    sqlx::query("UPDATE jobs SET gh_run_id = ?, status = 'processing', started_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
        .bind(run_id).bind(id).execute(pool).await?;
    Ok(())
}

pub async fn update_job_completed(pool: &SqlitePool, id: &str, resolution: &str, duration: f64) -> AppResult<()> {
    sqlx::query(
        "UPDATE jobs SET status = 'completed', video_resolution = ?, duration_seconds = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).bind(resolution).bind(duration).bind(id).execute(pool).await?;
    Ok(())
}

pub async fn update_job_failed(pool: &SqlitePool, id: &str, error_msg: &str) -> AppResult<()> {
    sqlx::query("UPDATE jobs SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(error_msg).bind(id).execute(pool).await?;
    Ok(())
}

pub async fn delete_job(pool: &SqlitePool, id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM jobs WHERE id = ?").bind(id).execute(pool).await?;
    Ok(())
}

pub async fn update_job_phase(pool: &SqlitePool, id: &str, phase: &str) -> AppResult<()> {
    sqlx::query("UPDATE jobs SET current_phase = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(phase).bind(id).execute(pool).await?;
    Ok(())
}

pub async fn count_jobs_by_status(pool: &SqlitePool, status: &str) -> AppResult<i64> {
    Ok(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM jobs WHERE status = ?")
        .bind(status).fetch_one(pool).await?)
}

// ── Job Events ──

pub async fn insert_job_event(
    pool: &SqlitePool,
    job_id: &str,
    phase: Option<&str>,
    event_type: &str,
    message: &str,
    progress_pct: Option<i64>,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO job_events (job_id, phase, event_type, message, progress_pct, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    )
    .bind(job_id).bind(phase).bind(event_type).bind(message).bind(progress_pct)
    .execute(pool).await?;
    Ok(())
}

pub async fn get_job_events(pool: &SqlitePool, job_id: &str) -> AppResult<Vec<JobEvent>> {
    Ok(sqlx::query_as::<_, JobEvent>(
        "SELECT * FROM job_events WHERE job_id = ? ORDER BY created_at ASC"
    ).bind(job_id).fetch_all(pool).await?)
}

// ── HLS Chunks ──

pub async fn insert_hls_chunk(pool: &SqlitePool, chunk: &NewHlsChunk) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO hls_chunks (job_id, chunk_index, filename, discord_url, discord_message_id, duration_seconds, file_size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))"
    )
    .bind(&chunk.job_id).bind(chunk.chunk_index).bind(&chunk.filename)
    .bind(&chunk.discord_url).bind(&chunk.discord_message_id)
    .bind(chunk.duration_seconds).bind(chunk.file_size_bytes)
    .execute(pool).await?;
    Ok(())
}

pub async fn get_hls_chunks(pool: &SqlitePool, job_id: &str) -> AppResult<Vec<HlsChunk>> {
    Ok(sqlx::query_as::<_, HlsChunk>(
        "SELECT * FROM hls_chunks WHERE job_id = ? ORDER BY chunk_index ASC"
    ).bind(job_id).fetch_all(pool).await?)
}

// ── Cinemeta Cache ──

pub async fn get_cached_meta(pool: &SqlitePool, imdb_id: &str, media_type: &str) -> AppResult<Option<CinemetaCache>> {
    Ok(sqlx::query_as::<_, CinemetaCache>(
        "SELECT * FROM cinemeta_cache WHERE imdb_id = ? AND media_type = ?"
    ).bind(imdb_id).bind(media_type).fetch_optional(pool).await?)
}

pub async fn upsert_cached_meta(pool: &SqlitePool, meta: &CinemetaCache) -> AppResult<()> {
    sqlx::query(
        "INSERT OR REPLACE INTO cinemeta_cache (imdb_id, media_type, title, poster_url, overview, year, total_seasons, cached_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))"
    )
    .bind(&meta.imdb_id).bind(&meta.media_type).bind(&meta.title)
    .bind(&meta.poster_url).bind(&meta.overview).bind(meta.year)
    .bind(meta.total_seasons)
    .execute(pool).await?;
    Ok(())
}

// ── App Settings ──

pub async fn get_all_settings(pool: &SqlitePool) -> AppResult<Vec<AppSetting>> {
    Ok(sqlx::query_as::<_, AppSetting>("SELECT * FROM app_settings")
        .fetch_all(pool).await?)
}

pub async fn get_setting(pool: &SqlitePool, key: &str) -> AppResult<Option<String>> {
    Ok(sqlx::query_scalar::<_, String>(
        "SELECT value FROM app_settings WHERE key = ?"
    ).bind(key).fetch_optional(pool).await?)
}

pub async fn upsert_setting(pool: &SqlitePool, key: &str, value: &str) -> AppResult<()> {
    sqlx::query("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)")
        .bind(key).bind(value).execute(pool).await?;
    Ok(())
}
