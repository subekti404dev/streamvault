use std::sync::Arc;
use crate::{app::AppState, db::queries, error::{AppResult, AppError}};

pub const WORKFLOW_FILE: &str = "streamvault-pipeline.yml";

pub async fn fetch_gh_run_id(
    client: &reqwest::Client,
    gh_token: &str,
    gh_repo: &str,
) -> Option<String> {
    let url = format!(
        "https://api.github.com/repos/{}/actions/workflows/{}/runs?status=in_progress&status=queued&per_page=5&sort=created&direction=desc",
        gh_repo, WORKFLOW_FILE
    );
    let resp = client
        .get(&url)
        .bearer_auth(gh_token)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "StreamVault/1.0")
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    let json: serde_json::Value = resp.json().await.ok()?;
    let runs = json.get("workflow_runs")?.as_array()?;
    // Return the first (most recent) run
    let run_id = runs.first()?.get("id")?.as_i64()?;
    Some(run_id.to_string())
}

pub async fn cancel_gh_run(
    client: &reqwest::Client,
    gh_token: &str,
    gh_repo: &str,
    run_id: &str,
) -> Result<(), String> {
    let url = format!(
        "https://api.github.com/repos/{}/actions/runs/{}/cancel",
        gh_repo, run_id
    );
    let resp = client
        .post(&url)
        .bearer_auth(gh_token)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "StreamVault/1.0")
        .send()
        .await
        .map_err(|e| format!("cancel request: {e}"))?;

    let status = resp.status();
    if status.is_success() || status.as_u16() == 204 {
        Ok(())
    } else {
        let text = resp.text().await.unwrap_or_default();
        Err(format!("cancel failed ({status}): {text}"))
    }
}

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

    // Pick channel: try multi-channel IDs, fallback to single channel ID
    let discord_channel = get_discord_channel(state, &job.id).await?;

    let body = serde_json::json!({
        "ref": "main",
        "inputs": {
            "job_id": job.id,
            "magnet_uri": job.magnet_uri,
            "file_idx": job.file_idx.unwrap_or(0).to_string(),
            "torrent_name": job.torrent_name.clone().unwrap_or_default(),
            "callback_url": base_url,
            "callback_token": callback_token,
            "discord_bot_token": discord_token,
            "discord_channel_id": discord_channel,
            "skip_download": skip_download.to_string(),
            "skip_transcode": skip_transcode.to_string(),
            "checkpoint_dl_url": job.gh_artifact_dl_url.clone().unwrap_or_default(),
            "checkpoint_tc_url": job.gh_artifact_tc_url.clone().unwrap_or_default(),
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
    // Poll for the actual run ID (GitHub creates it asynchronously).
    let gh_run_id = {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        fetch_gh_run_id(&state.http, &gh_token, &gh_repo)
            .await
            .unwrap_or_else(|| "pending".to_string())
    };

    queries::update_job_gh_run(&state.db, &job.id, &gh_run_id).await?;
    // Save channel_id to job
    sqlx::query("UPDATE jobs SET discord_channel_id = ? WHERE id = ?")
        .bind(&discord_channel)
        .bind(&job.id)
        .execute(&state.db).await?;
    queries::insert_job_event(
        &state.db, &job.id, None, "status_change",
        &format!("Pipeline triggered (run_id: {gh_run_id}, channel: {discord_channel})"), None,
    ).await?;

    Ok("pending".to_string())
}

/// Resolve Discord channel for a job.
/// 1. Try `discord_channel_ids` (comma-separated) → hash pick
/// 2. Fallback to `discord_channel_id` (single)
async fn get_discord_channel(state: &Arc<AppState>, job_id: &str) -> AppResult<String> {
    let multi = get_setting_or_env(state, "discord_channel_ids").await?;
    if let Some(ids) = multi {
        let channels: Vec<String> = ids.split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if !channels.is_empty() {
            if let Some(ch) = crate::pipeline::channel::pick_channel(job_id, &channels) {
                return Ok(ch);
            }
        }
    }
    // Fallback
    get_setting_or_env(state, "discord_channel_id").await?
        .ok_or_else(|| AppError::BadRequest("No Discord channel configured".into()))
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
