use std::sync::Arc;
use tokio::time::{interval, Duration};
use crate::{app::AppState, db::queries, api::events::SseEvent, pipeline::trigger};
use crate::notifications::{self, telegram::TelegramEvent};

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
    let channel_count = get_channel_count(&state).await;
    let max_concurrent = std::cmp::max(1, channel_count);
    let active_count = queries::count_jobs_by_statuses(&state.db, ACTIVE_STATUSES).await?;
    let slots = max_concurrent.saturating_sub(active_count as usize);

    if slots == 0 {
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

/// Count configured Discord channels.
/// `discord_channel_ids` → comma-count, fallback `discord_channel_id` → 1, else 1.
/// ponytail: global cap, per-account caps if multi-user needed later
async fn get_channel_count(state: &Arc<AppState>) -> usize {
    if let Ok(Some(ids)) = trigger::get_setting_or_env(state, "discord_channel_ids").await {
        let count = ids.split(',').filter(|c| !c.trim().is_empty()).count();
        if count > 0 { return count; }
    }
    if let Ok(Some(id)) = trigger::get_setting_or_env(state, "discord_channel_id").await {
        if !id.is_empty() { return 1; }
    }
    1
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
