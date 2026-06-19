use axum::{Json, extract::{State, Path}};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;
use crate::{app::AppState, db::queries, error::{AppResult, AppError}, notifications, notifications::telegram::TelegramEvent, pipeline::trigger, pipeline::trigger::get_setting_or_env};

#[derive(Debug, Deserialize)]
pub struct CreateJobRequest {
    pub imdb_id: String,
    pub media_type: String,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub title: Option<String>,
    pub poster_url: Option<String>,
    pub magnet_uri: String,
    pub infohash: String,
    pub torrent_name: String,
    pub file_idx: i64,
    pub file_size_bytes: i64,
}

#[derive(Debug, Serialize)]
pub struct CreateJobResponse {
    pub job_id: String,
    pub status: String,
}

#[derive(Debug, Serialize)]
pub struct QueueListResponse {
    pub processing: Vec<queries::Job>,
    pub queued: Vec<queries::Job>,
    pub completed: Vec<queries::Job>,
    pub failed: Vec<queries::Job>,
}

#[derive(Debug, Serialize)]
pub struct JobDetailResponse {
    pub job: queries::Job,
    pub events: Vec<queries::JobEvent>,
    pub gh_repo: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RetryResponse {
    pub job_id: String,
    pub status: String,
}

pub async fn create_job(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateJobRequest>,
) -> AppResult<Json<CreateJobResponse>> {
    let job_id = Uuid::new_v4().to_string();

    let new_job = queries::NewJob {
        id: job_id.clone(),
        imdb_id: body.imdb_id.clone(),
        media_type: body.media_type.clone(),
        season: body.season,
        episode: body.episode,
        title: body.title,
        poster_url: body.poster_url,
        magnet_uri: Some(body.magnet_uri),
        infohash: Some(body.infohash),
        torrent_name: Some(body.torrent_name),
        file_idx: Some(body.file_idx),
        file_size_bytes: Some(body.file_size_bytes),
    };

    queries::insert_job(&state.db, &new_job).await?;

    // Log event
    queries::insert_job_event(
        &state.db, &job_id, None, "status_change",
        "Job queued", None,
    ).await?;

    // Broadcast
    let _ = state.event_tx.send(crate::api::events::SseEvent::JobCreated {
        job_id: job_id.clone(),
        title: new_job.title.clone().unwrap_or_default(),
    });

    // Telegram notification
    notifications::send_notification(&state, TelegramEvent::JobQueued(
        new_job.title.clone().unwrap_or_default(),
    ));

    Ok(Json(CreateJobResponse {
        job_id,
        status: "queued".to_string(),
    }))
}

pub async fn list_jobs(
    State(state): State<Arc<AppState>>,
) -> AppResult<Json<QueueListResponse>> {
    let all_jobs = queries::list_jobs(&state.db).await?;

    let mut processing = Vec::new();
    let mut queued = Vec::new();
    let mut completed = Vec::new();
    let mut failed = Vec::new();

    let processing_statuses = [
        "processing", "downloading", "checkpoint_download",
        "transcoding", "checkpoint_transcode", "uploading",
    ];

    for job in all_jobs {
        match job.status.as_str() {
            "queued" => queued.push(job),
            "completed" => completed.push(job),
            "failed" => failed.push(job),
            s if processing_statuses.contains(&s) => processing.push(job),
            _ => queued.push(job), // fallback
        }
    }

    Ok(Json(QueueListResponse { processing, queued, completed, failed }))
}
pub async fn get_job(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> AppResult<Json<JobDetailResponse>> {
    let job = queries::get_job(&state.db, &id).await
        .map_err(|_| AppError::NotFound(format!("Job {} not found", id)))?;
    let events = queries::get_job_events(&state.db, &id).await?;
    let gh_repo = get_setting_or_env(&state, "gh_repo").await?.filter(|repo| !repo.is_empty());

    Ok(Json(JobDetailResponse { job, events, gh_repo }))
}

pub async fn retry_job(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> AppResult<Json<RetryResponse>> {
    let job = queries::get_job(&state.db, &id).await
        .map_err(|_| AppError::NotFound(format!("Job {} not found", id)))?;

    if job.status != "failed" {
        return Err(AppError::BadRequest("Can only retry failed jobs".into()));
    }

    let skip_download = job.last_checkpoint.as_deref() == Some("download")
        || job.last_checkpoint.as_deref() == Some("transcode");
    let skip_transcode = job.last_checkpoint.as_deref() == Some("transcode");

    queries::insert_job_event(
        &state.db, &id, None, "status_change",
        &format!("Retry triggered (last checkpoint: {:?}, skip_dl: {}, skip_tc: {})",
            job.last_checkpoint, skip_download, skip_transcode),
        None,
    ).await?;

    // Trigger pipeline with skip flags instead of resetting to queued
    match trigger::trigger_pipeline(&state, &job, skip_download, skip_transcode).await {
        Ok(run_id) => {
            queries::update_job_status(&state.db, &id, "processing").await?;
            queries::insert_job_event(
                &state.db, &id, None, "status_change",
                &format!("Retry pipeline triggered (run_id: {})", run_id), None,
            ).await?;

            let _ = state.event_tx.send(crate::api::events::SseEvent::JobRetried {
                job_id: id.clone(),
            });

            Ok(Json(RetryResponse {
                job_id: id,
                status: "processing".to_string(),
            }))
        }
        Err(e) => Err(e),
    }
}

pub async fn delete_job(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let job = queries::get_job(&state.db, &id).await
        .map_err(|_| AppError::NotFound(format!("Job {} not found", id)))?;

    let active_statuses = [
        "processing", "downloading", "transcoding", "uploading",
        "checkpoint_download", "checkpoint_transcode",
    ];
    let is_active = active_statuses.contains(&job.status.as_str());

    // Cancel GitHub Actions run if the job is active
    if is_active {
        if let Some(ref run_id) = job.gh_run_id {
            if run_id != "pending" && !run_id.is_empty() {
                let config = state.config.read().await;
                let gh_token = crate::pipeline::trigger::get_setting_or_env(&state, "gh_token").await?.unwrap_or_default();
                let gh_repo = crate::pipeline::trigger::get_setting_or_env(&state, "gh_repo").await?.unwrap_or_default();
                drop(config);

                if !gh_token.is_empty() && !gh_repo.is_empty() {
                    match crate::pipeline::trigger::cancel_gh_run(&state.http, &gh_token, &gh_repo, run_id).await {
                        Ok(()) => {
                            eprintln!("[queue] Cancelled GH run {run_id} for job {id}");
                            queries::insert_job_event(
                                &state.db, &id, None, "status_change",
                                &format!("Cancelled GitHub Actions run {run_id}"), None,
                            ).await?;
                        }
                        Err(e) => {
                            eprintln!("[queue] Failed to cancel GH run {run_id}: {e}");
                            // Non-fatal — still proceed with DB deletion
                        }
                    }
                }
            }
        }
    }

    // Delete from DB (cascades to job_events and hls_chunks)
    queries::delete_job(&state.db, &id).await?;

    // Broadcast SSE event
    let _ = state.event_tx.send(crate::api::events::SseEvent::JobRemoved {
        job_id: id.clone(),
    });

    Ok(Json(serde_json::json!({ "removed": true, "cancelled_run": is_active })))
}
