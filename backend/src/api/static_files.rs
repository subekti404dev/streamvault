use std::sync::Arc;
use tower_http::services::ServeDir;
use axum::Router;
use crate::app::AppState;

pub fn static_files_handler() -> Router<Arc<AppState>> {
    let dir = std::env::var("STREAMVAULT_DASHBOARD_DIR")
        .unwrap_or_else(|_| "dashboard/dist".to_string());

    Router::new()
        .fallback_service(ServeDir::new(&dir))
}
