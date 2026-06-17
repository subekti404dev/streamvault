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
    // Check Bearer header first
    let header_token = req
        .headers()
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|v| v.to_string());

    // Fall back to ?token= query param (for SSE EventSource)
    let query_token = req.uri().query().and_then(|q| {
        q.split('&').find_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            let key = parts.next()?;
            let value = parts.next()?;
            if key == "token" { Some(value.to_string()) } else { None }
        })
    });

    let secret = state.config.read().await.auth_secret.clone();
    let token = header_token.or(query_token);

    match token {
        Some(t) if t == secret => Ok(next.run(req).await),
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
