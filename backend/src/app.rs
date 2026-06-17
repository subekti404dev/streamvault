use std::sync::Arc;
use axum::{
    Router,
    routing::{get, post, put, delete},
    middleware,
};
use tokio::sync::{broadcast, RwLock};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use crate::api::events::SseEvent;
use crate::config::Config;
use sqlx::SqlitePool;

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub config: Arc<RwLock<Config>>,
    pub event_tx: broadcast::Sender<SseEvent>,
    pub http: reqwest::Client,
}

pub fn create_router(state: Arc<AppState>) -> Router {
    let auth_router = Router::new()
        .route("/api/v1/search", post(crate::api::search::search_handler))
        .route("/api/v1/queue", post(crate::api::queue::create_job))
        .route("/api/v1/queue", get(crate::api::queue::list_jobs))
        .route("/api/v1/queue/:id", get(crate::api::queue::get_job))
        .route("/api/v1/queue/:id/retry", post(crate::api::queue::retry_job))
        .route("/api/v1/queue/:id", delete(crate::api::queue::delete_job))
        .route("/api/v1/events", get(crate::api::events::sse_handler))
        .route("/api/v1/settings", get(crate::api::settings::get_settings))
        .route("/api/v1/settings", put(crate::api::settings::update_settings))
        .route("/api/v1/library", get(crate::api::library::list_library))
        .route("/api/v1/library/:id", delete(crate::api::library::delete_library))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            crate::api::auth::auth_middleware,
        ));

    let callback_router = Router::new()
        .route("/api/v1/jobs/:id/progress", post(crate::api::callbacks::progress_callback))
        .route("/api/v1/jobs/:id/checkpoint", post(crate::api::callbacks::checkpoint_callback))
        .route("/api/v1/jobs/:id/complete", post(crate::api::callbacks::complete_callback))
        .route("/api/v1/jobs/:id/failed", post(crate::api::callbacks::failed_callback))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            crate::api::auth::callback_auth_middleware,
        ));

    let public_router = Router::new()
        .route("/manifest.json", get(crate::stremio::routes::manifest_handler))
        .route("/catalog/:type_/:catalog_id.json", get(crate::stremio::routes::catalog_handler))
        .route("/meta/:type_/:imdb_id.json", get(crate::stremio::routes::meta_handler))
        .route("/stream/:type_/:id.json", get(crate::stremio::routes::stream_handler))
        .route("/proxy/hls/:job_id/master.m3u8", get(crate::stremio::proxy::playlist_handler))
        .route("/proxy/hls/:job_id/*filename", get(crate::stremio::proxy::chunk_handler));

    let dashboard_dir = std::env::var("STREAMVAULT_DASHBOARD_DIR")
        .unwrap_or_else(|_| "dashboard/dist".to_string());

    Router::new()
        .merge(auth_router)
        .merge(callback_router)
        .merge(public_router)
        .fallback_service(tower_http::services::ServeDir::new(&dashboard_dir))
        .with_state(state)
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
}
