use std::sync::Arc;
use crate::{app::AppState, db::queries, error::{AppResult, AppError}};

pub async fn trigger_pipeline(
    state: &Arc<AppState>,
    job: &queries::Job,
    skip_download: bool,
    skip_transcode: bool,
) -> AppResult<String> {
    let config = state.config.read().await;
    let gh_token = get_setting_or_env(state, "gh_token").await?
        .ok_or_else(|| AppError::BadRequest("GitHub token not configured".into()))?;
    let gh_repo = get_setting_or_env(state, "gh_repo").await?
        .ok_or_else(|| AppError::BadRequest("GitHub repo not configured".into()))?;
    let base_url = config.public_base_url.clone();
    let callback_token = config.auth_secret.clone();
    drop(config);

    let url = format!(
        "https://api.github.com/repos/{}/actions/workflows/streamvault-pipeline.yml/dispatches",
        gh_repo
    );

    let discord_token = get_setting_or_env(state, "discord_bot_token").await?.unwrap_or_default();
    let discord_channel = get_setting_or_env(state, "discord_channel_id").await?.unwrap_or_default();

    let body = serde_json::json!({
        "ref": "main",
        "inputs": {
            "job_id": job.id,
            "magnet_uri": job.magnet_uri,
            "file_idx": job.file_idx.unwrap_or(0).to_string(),
            "callback_url": base_url,
            "callback_token": callback_token,
            "discord_bot_token": discord_token,
            "discord_channel_id": discord_channel,
            "skip_download": skip_download.to_string(),
            "skip_transcode": skip_transcode.to_string(),
        }
    });

    let resp = state.http
        .post(&url)
        .bearer_auth(&gh_token)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "StreamVault/1.0")
        .json(&body)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "GitHub API error ({}): {}",
            status, text
        )));
    }

    // GitHub returns 204 No Content on success.
    // We store the run ID as best-effort.
    queries::update_job_gh_run(&state.db, &job.id, "pending").await?;
    queries::insert_job_event(
        &state.db, &job.id, None, "status_change",
        "Pipeline triggered via GitHub Actions", None,
    ).await?;

    Ok("pending".to_string())
}

pub async fn get_setting_or_env(state: &Arc<AppState>, key: &str) -> AppResult<Option<String>> {
    // Try DB first
    if let Some(val) = queries::get_setting(&state.db, key).await? {
        if !val.is_empty() {
            return Ok(Some(val));
        }
    }

    // Fall back to env config
    let config = state.config.read().await;
    Ok(match key {
        "gh_token" => config.gh_token.clone(),
        "gh_repo" => config.gh_repo.clone(),
        "discord_bot_token" => config.discord_bot_token.clone(),
        "discord_channel_id" => config.discord_channel_id.clone(),
        "telegram_bot_token" => config.telegram_bot_token.clone(),
        "telegram_channel_id" => config.telegram_channel_id.clone(),
        "torrentio_base_url" => config.torrentio_base_url.clone(),
        _ => None,
    })
}
