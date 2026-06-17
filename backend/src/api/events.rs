use axum::{
    extract::State,
    response::sse::{Event, Sse},
};
use futures::stream::Stream;
use serde::Serialize;
use std::sync::Arc;
use std::convert::Infallible;
use tokio_stream::StreamExt;
use crate::app::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", content = "data")]
pub enum SseEvent {
    JobCreated { job_id: String, title: String },
    JobStarted { job_id: String },
    JobProgress { job_id: String, phase: String, progress_pct: i32 },
    JobCheckpoint { job_id: String, checkpoint: String },
    JobCompleted { job_id: String },
    JobFailed { job_id: String, error: String },
    JobRetried { job_id: String },
    JobRemoved { job_id: String },
    QueueUpdate { processing: usize, queued: usize },
}

fn event_name(event: &SseEvent) -> &'static str {
    match event {
        SseEvent::JobCreated { .. } => "job_created",
        SseEvent::JobStarted { .. } => "job_started",
        SseEvent::JobProgress { .. } => "job_progress",
        SseEvent::JobCheckpoint { .. } => "job_checkpoint",
        SseEvent::JobCompleted { .. } => "job_completed",
        SseEvent::JobFailed { .. } => "job_failed",
        SseEvent::JobRetried { .. } => "job_retried",
        SseEvent::JobRemoved { .. } => "job_removed",
        SseEvent::QueueUpdate { .. } => "queue_update",
    }
}

pub async fn sse_handler(
    State(state): State<Arc<AppState>>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state.event_tx.subscribe();

    let stream = tokio_stream::wrappers::BroadcastStream::new(rx)
        .filter_map(|result| {
            match result {
                Ok(event) => {
                    let data = serde_json::to_string(&event).ok()?;
                    let name = event_name(&event);
                    Some(Ok(Event::default().event(name).data(data)))
                }
                Err(_) => None,
            }
        });

    Sse::new(stream).keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(std::time::Duration::from_secs(15))
            .text("keep-alive"),
    )
}
