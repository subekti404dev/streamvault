use std::sync::Arc;
use crate::{app::AppState, db::queries};

/// Recover jobs that were in progress when the server stopped.
pub async fn recover_stale_jobs(state: &Arc<AppState>) {
    let processing_statuses = [
        "processing", "downloading", "checkpoint_download",
        "transcoding", "checkpoint_transcode", "uploading",
    ];

    let stale = match queries::list_jobs_by_statuses(&state.db, &processing_statuses).await {
        Ok(jobs) => jobs,
        Err(e) => {
            tracing::error!("Failed to query stale jobs: {}", e);
            return;
        }
    };

    let count = stale.len();

    for job in &stale {
        tracing::warn!("Recovering stale job {} (status: {})", job.id, job.status);
        queries::update_job_failed(
            &state.db, &job.id,
            "Server restarted — job interrupted, please retry",
        ).await.ok();

        queries::insert_job_event(
            &state.db, &job.id, None, "error",
            "Server restarted while job was in progress", None,
        ).await.ok();
    }

    if count == 0 {
        tracing::info!("No stale jobs to recover");
    } else {
        tracing::info!("Recovered {} stale job(s)", count);
    }
}
