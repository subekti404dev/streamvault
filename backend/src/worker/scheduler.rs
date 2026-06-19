use std::sync::Arc;
use tokio::time::{interval, Duration};
use crate::{app::AppState, db::queries, api::events::SseEvent, pipeline::trigger};
use crate::notifications::{self, telegram::TelegramEvent};

const MAX_CONCURRENT: usize = 5;
const ACTIVE_STATUSES: &[&str] = &[
    "processing", "downloading", "checkpoint_download",
    "transcoding", "checkpoint_transcode", "uploading",
];

pub async fn scheduler_loop(state: Arc<AppState>) {
    let mut ticker = interval(Duration::from_secs(15));
    loop {
        ticker.tick().await;
        if let Err(e) = scheduler_tick(state.clone()).await {
            tracing::error!("Scheduler tick error: {}", e);
        }
    }
}

async fn scheduler_tick(state: Arc<AppState>) -> Result<(), Box<dyn std::error::Error>> {
    let active_count = queries::count_jobs_by_statuses(&state.db, ACTIVE_STATUSES).await?;
    let slots = MAX_CONCURRENT.saturating_sub(active_count as usize);

    if slots == 0 {
        // All slots full — nothing to do
        broadcast_queue_update(&state).await?;
        return Ok(());
    }

    tracing::info!("Active: {}, slots remaining: {}", active_count, slots);

    for _ in 0..slots {
        let job = match queries::get_next_queued_job(&state.db).await? {
            Some(j) => j,
            None => break,
        };

        queries::update_job_status(&state.db, &job.id, "processing").await?;
        queries::insert_job_event(
            &state.db, &job.id, None, "status_change",
            "Pipeline started by scheduler", None,
        ).await?;

        let _ = state.event_tx.send(SseEvent::JobStarted {
            job_id: job.id.clone(),
        });

        let title = job.title.clone().unwrap_or_default();
        notifications::send_notification(&state, TelegramEvent::JobStarted(title));

        // Trigger GHA pipeline
        match trigger::trigger_pipeline(&state, &job, false, false).await {
            Ok(run_id) => {
                tracing::info!("Triggered GHA run {} for job {}", run_id, job.id);
            }
            Err(e) => {
                tracing::error!("Failed to trigger pipeline for job {}: {}", job.id, e);
                queries::update_job_failed(&state.db, &job.id, &format!("Trigger failed: {}", e)).await?;
            }
        }
    }

    broadcast_queue_update(&state).await?;
    Ok(())
}

async fn broadcast_queue_update(state: &Arc<AppState>) -> Result<(), Box<dyn std::error::Error>> {
    let processing_count = queries::count_jobs_by_status(&state.db, "processing").await?;
    let queued_count = queries::count_jobs_by_status(&state.db, "queued").await?;
    let _ = state.event_tx.send(SseEvent::QueueUpdate {
        processing: processing_count as usize,
        queued: queued_count as usize,
    });
    Ok(())
}
