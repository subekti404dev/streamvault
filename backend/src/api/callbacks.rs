use axum::{Json, extract::{State, Path}};
use serde_json::Value;
use std::sync::Arc;
use crate::{app::AppState, db::queries, error::{AppResult, AppError}, api::events::SseEvent, notifications, notifications::telegram::TelegramEvent};

pub async fn progress_callback(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    let phase = body.get("phase").and_then(|v| v.as_str()).unwrap_or("download");
    let progress_pct = body.get("progress_pct").and_then(|v| v.as_i64()).unwrap_or(0) as i32;

    queries::update_job_progress(&state.db, &id, phase, progress_pct).await?;
    queries::update_job_phase(&state.db, &id, phase).await?;

    // Insert chunk info if present
    if let Some(chunk) = body.get("chunk") {
        if let (Some(filename), Some(discord_url)) = (
            chunk.get("filename").and_then(|v| v.as_str()),
            chunk.get("discord_url").and_then(|v| v.as_str()),
        ) {
            let chunk_idx = chunk.get("chunk_index").and_then(|v| v.as_i64()).unwrap_or(0);
            let duration = chunk.get("duration_seconds").and_then(|v| v.as_f64());
            queries::insert_hls_chunk(&state.db, &queries::NewHlsChunk {
                job_id: id.clone(),
                chunk_index: chunk_idx,
                filename: filename.to_string(),
                discord_url: Some(discord_url.to_string()),
                discord_message_id: chunk.get("discord_message_id").and_then(|v| v.as_str()).map(String::from),
                duration_seconds: duration,
                file_size_bytes: None,
            }).await?;
        }
    }

    // Log event
    queries::insert_job_event(
        &state.db, &id, Some(phase), "progress",
        &format!("Progress: {}%", progress_pct), Some(progress_pct as i64),
    ).await?;

    // Broadcast
    let _ = state.event_tx.send(SseEvent::JobProgress {
        job_id: id,
        phase: phase.to_string(),
        progress_pct,
    });

    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn checkpoint_callback(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    let checkpoint = body.get("checkpoint")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::BadRequest("Missing checkpoint field".into()))?;
    let artifact_id = body.get("artifact_id")
        .and_then(|v| v.as_str());
    let file_url = body.get("file_url")
        .and_then(|v| v.as_str());

    queries::update_job_checkpoint(&state.db, &id, checkpoint, artifact_id, file_url).await?;

    queries::insert_job_event(
        &state.db, &id, Some(checkpoint), "checkpoint",
        &format!("Checkpoint saved: {}", checkpoint), None,
    ).await?;

    let _ = state.event_tx.send(SseEvent::JobCheckpoint {
        job_id: id.clone(),
        checkpoint: checkpoint.to_string(),
    });

    // Telegram notification
    let title = queries::get_job(&state.db, &id).await
        .ok()
        .and_then(|j| j.title)
        .unwrap_or_default();
    notifications::send_notification(&state, TelegramEvent::CheckpointSaved(
        title, checkpoint.to_string(),
    ));

    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn complete_callback(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    let resolution = body.get("video_resolution")
        .and_then(|v| v.as_str())
        .unwrap_or("1080p");
    let duration = body.get("duration_seconds")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);

    // Get job before updating to capture gh_run_id
    let job = queries::get_job(&state.db, &id).await.ok();
    let gh_run_id = job.as_ref().and_then(|j| j.gh_run_id.clone());

    queries::update_job_completed(&state.db, &id, resolution, duration).await?;

    queries::insert_job_event(
        &state.db, &id, None, "status_change",
        &format!("Completed: {} resolution, {:.0}s duration", resolution, duration), None,
    ).await?;

    let _ = state.event_tx.send(SseEvent::JobCompleted {
        job_id: id.clone(),
    });

    // Telegram notification
    let title = job.as_ref().and_then(|j| j.title.clone()).unwrap_or_default();
    let details = format!("{} resolution, {:.0}s duration", resolution, duration);
    notifications::send_notification(&state, TelegramEvent::JobCompleted(title, details));

    // Delete GitHub Actions run if configured
    if let Some(run_id) = gh_run_id {
        let config = state.config.read().await;
        if let (Some(token), Some(repo)) = (&config.gh_token, &config.gh_repo) {
            let token = token.clone();
            let repo = repo.clone();
            drop(config);
            if let Some((owner, repo_name)) = repo.split_once('/') {
                let url = format!("https://api.github.com/repos/{}/{}/actions/runs/{}", owner, repo_name, run_id);
                let _ = state.http.delete(&url)
                    .bearer_auth(&token)
                    .header("Accept", "application/vnd.github+json")
                    .header("X-GitHub-Api-Version", "2022-11-28")
                    .send()
                    .await;
                queries::insert_job_event(
                    &state.db, &id, None, "cleanup",
                    &format!("GitHub Actions run {} deleted", run_id), None,
                ).await.ok();
            }
        }
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn failed_callback(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    let error_msg = body.get("error_message")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown error");

    queries::update_job_failed(&state.db, &id, error_msg).await?;

    queries::insert_job_event(
        &state.db, &id, None, "error",
        &format!("Failed: {}", error_msg), None,
    ).await?;

    let _ = state.event_tx.send(SseEvent::JobFailed {
        job_id: id.clone(),
        error: error_msg.to_string(),
    });

    // Telegram notification
    let job = queries::get_job(&state.db, &id).await.ok();
    let title = job.as_ref().and_then(|j| j.title.clone()).unwrap_or_default();
    let phase = job.as_ref().and_then(|j| j.current_phase.clone()).unwrap_or_default();
    notifications::send_notification(&state, TelegramEvent::JobFailed(
        title, phase, error_msg.to_string(),
    ));

    Ok(Json(serde_json::json!({ "ok": true })))
}
