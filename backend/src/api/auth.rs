use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::Response,
};
use std::sync::Arc;
use crate::app::AppState;

pub async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Result<Response, (StatusCode, &'static str)> {
    let auth_header = req
        .headers()
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|v| v.to_string());

    let secret = state.config.read().await.auth_secret.clone();

    match auth_header {
        Some(token) if token == secret => Ok(next.run(req).await),
        _ => Err((StatusCode::UNAUTHORIZED, "Unauthorized")),
    }
}

pub async fn callback_auth_middleware(
    State(state): State<Arc<AppState>>,
    req: Request,
    next: Next,
) -> Result<Response, (StatusCode, &'static str)> {
    let header_token = req
        .headers()
        .get("X-Callback-Token")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string());

    let secret = state.config.read().await.auth_secret.clone();

    match header_token {
        Some(token) if token == secret => Ok(next.run(req).await),
        _ => Err((StatusCode::UNAUTHORIZED, "Unauthorized")),
    }
}
