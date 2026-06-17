pub mod api;
pub mod stremio;
pub mod pipeline;
pub mod notifications;
pub mod db;
pub mod config;
pub mod error;
pub mod worker;

pub mod app;

use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::sync::broadcast;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    // Load config
    dotenvy::dotenv().ok();
    let config = config::Config::from_env()?;
    tracing::info!("Starting StreamVault...");

    // Database
    let pool = db::create_pool(&config.database_url).await?;
    tracing::info!("Database connected");

    // SSE broadcast channel
    let (event_tx, _) = broadcast::channel(1024);

    // App state
    let state = Arc::new(app::AppState {
        db: pool,
        config: Arc::new(RwLock::new(config)),
        event_tx,
        http: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()?,
    });

    // Recover stale jobs from previous run
    worker::monitor::recover_stale_jobs(&state).await;

    // Start scheduler worker
    let state_clone = state.clone();
    tokio::spawn(async move {
        worker::scheduler::scheduler_loop(state_clone).await;
    });
    tracing::info!("Scheduler worker started");

    // Build router
    let router = app::create_router(state.clone());

    // Start server
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await?;
    tracing::info!("Server listening on http://0.0.0.0:8080");

    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("Failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("Failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => tracing::info!("Ctrl+C received, shutting down"),
        _ = terminate => tracing::info!("SIGTERM received, shutting down"),
    }
}
