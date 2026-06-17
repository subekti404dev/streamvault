use axum::{Json, extract::{State, Path}};
use serde_json::{json, Value};
use std::sync::Arc;
use crate::{app::AppState, db::queries, error::{AppResult, AppError}};

pub async fn list_library(
    State(state): State<Arc<AppState>>,
) -> AppResult<Json<Value>> {
    let completed = queries::list_jobs_by_status(&state.db, "completed").await?;
    Ok(Json(json!(completed)))
}

pub async fn delete_library(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let job = queries::get_job(&state.db, &id).await
        .map_err(|_| AppError::NotFound(format!("Job {} not found", id)))?;

    if job.status != "completed" {
        return Err(AppError::BadRequest("Can only delete completed jobs from library".into()));
    }

    queries::delete_job(&state.db, &id).await?;

    Ok(Json(json!({ "removed": true })))
}
