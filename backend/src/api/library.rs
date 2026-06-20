use axum::{Json, extract::{State, Path, Query}};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::{app::AppState, db::queries, error::AppResult};

#[derive(Debug, Deserialize)]
pub struct LibraryQuery {
    pub page: Option<i64>,
    pub limit: Option<i64>,
    pub r#type: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RequeueResponse {
    pub job_id: String,
    pub status: String,
}

pub async fn list_library(
    State(state): State<Arc<AppState>>,
    Query(params): Query<LibraryQuery>,
) -> AppResult<Json<queries::LibraryResponse>> {
    let page = params.page.unwrap_or(1).max(1);
    let limit = params.limit.unwrap_or(20).min(100);
    let media_type = params.r#type.as_deref();

    let response = queries::get_completed_jobs_grouped(&state.db, media_type, page, limit).await?;
    Ok(Json(response))
}

pub async fn requeue_job(
    State(state): State<Arc<AppState>>,
    Path(job_id): Path<String>,
) -> AppResult<Json<RequeueResponse>> {
    queries::requeue_job(&state.db, &job_id).await?;

    Ok(Json(RequeueResponse {
        job_id,
        status: "queued".to_string(),
    }))
}
