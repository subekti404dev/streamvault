//! Parallel HLS chunk upload to Discord during transcode.
//!
//! Usage: pipeline-upload --hls-dir /path --discord-token "$TOKEN" \
//!         --discord-channel "$CHANNEL" --callback-base "https://..." \
//!         --job-id "$ID" --callback-token "$TOKEN" [--append] [--reconcile-durations]
//!
//! With --append: reads existing chunk map, skips already-uploaded chunks,
//! uploads only new ones. Used by inline upload watcher during transcode.
//!
//! With --reconcile-durations: after transcode completes, updates chunk map
//! durations from final playlist.m3u8 (no upload).

use reqwest::multipart;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::time::sleep;

// ── Discord upload ─────────────────────────────────────────────────

#[derive(serde::Deserialize, Debug)]
struct DiscordMessageResponse {
    id: String,
    attachments: Vec<DiscordAttachment>,
}

#[derive(serde::Deserialize, Debug)]
struct DiscordAttachment {
    url: String,
}

async fn upload_chunk(
    client: &reqwest::Client,
    token: &str,
    channel: &str,
    file_path: &Path,
    filename: &str,
) -> Result<(String, String), String> {
    let url = format!("https://discord.com/api/v10/channels/{channel}/messages");

    let file_bytes = tokio::fs::read(file_path)
        .await
        .map_err(|e| format!("read chunk: {e}"))?;
    let part = multipart::Part::bytes(file_bytes)
        .file_name(filename.to_string())
        .mime_str("video/mp2t")
        .map_err(|e| format!("mime: {e}"))?;

    let form = multipart::Form::new().part("file", part);

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bot {token}"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("reqwest: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("{status}: {body}"));
    }

    let msg: DiscordMessageResponse = resp.json().await.map_err(|e| format!("json: {e}"))?;
    let att = msg
        .attachments
        .first()
        .ok_or_else(|| "no attachment in response".to_string())?;

    Ok((att.url.clone(), msg.id))
}

// ── Progress callback (StreamVault format) ─────────────────────────

async fn report_progress(
    client: &reqwest::Client,
    base: &str,
    job_id: &str,
    token: &str,
    phase: &str,
    percent: u32,
    detail: &str,
) {
    let url = format!("{base}/api/v1/jobs/{job_id}/progress");
    let payload = serde_json::json!({
        "phase": phase,
        "progress_pct": percent,
        "detail": detail,
    });
    let _ = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("X-Callback-Token", token)
        .json(&payload)
        .send()
        .await;
}

async fn report_chunk_progress(
    client: &reqwest::Client,
    base: &str,
    job_id: &str,
    token: &str,
    chunk_index: usize,
    filename: &str,
    discord_url: &str,
    discord_message_id: &str,
    duration: f64,
    total: usize,
) {
    let url = format!("{base}/api/v1/jobs/{job_id}/progress");
    let pct = (chunk_index * 100 / total) as u32;
    let payload = serde_json::json!({
        "phase": "upload",
        "progress_pct": pct,
        "chunk": {
            "chunk_index": chunk_index,
            "filename": filename,
            "discord_url": discord_url,
            "discord_message_id": discord_message_id,
            "duration_seconds": duration
        }
    });
    let _ = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("X-Callback-Token", token)
        .json(&payload)
        .send()
        .await;
}

// ── Upload with retry ──────────────────────────────────────────────

async fn upload_with_retry(
    client: &reqwest::Client,
    token: &str,
    channel: &str,
    path: &Path,
    filename: &str,
) -> Result<(String, String), String> {
    let max_retries = 5;
    for attempt in 1..=max_retries {
        match upload_chunk(client, token, channel, path, filename).await {
            Ok(result) => return Ok(result),
            Err(e) => {
                if e.contains("429") {
                    eprintln!("[pipeline] Rate limited (attempt {attempt})");
                    sleep(Duration::from_secs(2)).await;
                } else {
                    eprintln!("[pipeline] Upload error (attempt {attempt}): {e}");
                    if attempt == max_retries {
                        return Err(e);
                    }
                    sleep(Duration::from_secs(attempt * 2)).await;
                }
            }
        }
    }
    Err("Rate limited after max retries".into())
}

// ── Chunk map helpers ──────────────────────────────────────────────

fn read_existing_map(path: &str) -> (Vec<String>, HashSet<String>) {
    let content = std::fs::read_to_string(path).unwrap_or_default();
    let mut lines = Vec::new();
    let mut uploaded = HashSet::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(filename) = line.split('|').next() {
            uploaded.insert(filename.to_string());
        }
        lines.push(line.to_string());
    }
    (lines, uploaded)
}

fn parse_playlist_durations(hls_dir: &Path, playlist_name: &str) -> HashMap<String, f64> {
    let playlist_path = hls_dir.join(playlist_name);
    let content = match std::fs::read_to_string(&playlist_path) {
        Ok(c) => c,
        Err(_) => return Default::default(),
    };

    let mut map = HashMap::new();
    let mut pending_duration: Option<f64> = None;
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("#EXTINF:") {
            pending_duration = rest.split(',').next().and_then(|v| v.parse::<f64>().ok());
        } else if trimmed.ends_with(".ts") {
            if let Some(dur) = pending_duration.take() {
                let filename = Path::new(trimmed)
                    .file_name()
                    .and_then(|f| f.to_str())
                    .unwrap_or(trimmed)
                    .to_string();
                map.insert(filename, dur);
            }
        }
    }
    map
}

fn append_to_map(path: &str, line: &str) {
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{line}");
    }
}

fn reconcile_durations(chunk_map_path: &str, hls_dir: &Path, playlist_name: &str) {
    let playlist_durs = parse_playlist_durations(hls_dir, playlist_name);
    let content = std::fs::read_to_string(chunk_map_path).unwrap_or_default();
    let mut updated = Vec::new();
    let mut changed = 0usize;

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() < 4 {
            updated.push(line.to_string());
            continue;
        }
        let filename = parts[0];
        let old_dur: f64 = parts[3].parse().unwrap_or(0.0);

        if let Some(&real) = playlist_durs.get(filename) {
            if (old_dur - real).abs() > 0.01 {
                let new_line = format!("{}|{}|{}|{real}", parts[0], parts[1], parts[2]);
                updated.push(new_line);
                changed += 1;
                continue;
            }
        }
        updated.push(line.to_string());
    }

    if changed > 0 {
        let _ = std::fs::write(chunk_map_path, updated.join("\n") + "\n");
        eprintln!("[pipeline] Updated {changed} chunk durations from playlist");
    }
}

// ── Main ───────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let mut hls_dir = String::from("/tmp/hls");
    let mut chunk_map = String::from("/tmp/chunk_map.txt");
    let mut discord_token = String::new();
    let mut discord_channel = String::new();
    let mut callback_base = String::new();
    let mut job_id = String::new();
    let mut callback_token = String::new();
    let mut append_mode = false;
    let mut reconcile_mode = false;
    let mut playlist_name = String::from("master.m3u8");

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--hls-dir" => {
                i += 1;
                hls_dir = args[i].clone();
            }
            "--chunk-map" => {
                i += 1;
                chunk_map = args[i].clone();
            }
            "--discord-token" => {
                i += 1;
                discord_token = args[i].clone();
            }
            "--discord-channel" => {
                i += 1;
                discord_channel = args[i].clone();
            }
            "--callback-base" => {
                i += 1;
                callback_base = args[i].clone();
            }
            "--job-id" => {
                i += 1;
                job_id = args[i].clone();
            }
            "--callback-token" => {
                i += 1;
                callback_token = args[i].clone();
            }
            "--playlist" => {
                i += 1;
                playlist_name = args[i].clone();
            }
            "--append" => {
                append_mode = true;
            }
            "--reconcile-durations" => {
                reconcile_mode = true;
            }
            _ => {
                eprintln!("Unknown flag: {}", args[i]);
                std::process::exit(1);
            }
        }
        i += 1;
    }

    if discord_token.is_empty() || discord_channel.is_empty() {
        eprintln!("--discord-token and --discord-channel are required");
        std::process::exit(1);
    }

    let client = reqwest::Client::new();

    if reconcile_mode {
        let dir = PathBuf::from(&hls_dir);
        reconcile_durations(&chunk_map, &dir, &playlist_name);
        return Ok(());
    }

    let (_existing_lines, already_uploaded) = if append_mode {
        read_existing_map(&chunk_map)
    } else {
        let _ = std::fs::write(&chunk_map, "");
        (Vec::new(), HashSet::new())
    };

    let dir = PathBuf::from(&hls_dir);
    let mut all_chunks: Vec<PathBuf> = std::fs::read_dir(&dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with(".ts"))
        })
        .collect();
    all_chunks.sort();

    let chunks: Vec<PathBuf> = all_chunks
        .into_iter()
        .filter(|p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            !already_uploaded.contains(name)
        })
        .collect();

    let total = chunks.len();
    let grand_total = already_uploaded.len() + total;

    if total == 0 {
        eprintln!("[pipeline] No new chunks to upload (all {grand_total} already uploaded)");
        return Ok(());
    }

    let durations = parse_playlist_durations(&dir, &playlist_name);

    eprintln!("[pipeline] Uploading {total} new chunks of {grand_total} total to Discord");

    if !append_mode {
        report_progress(
            &client,
            &callback_base,
            &job_id,
            &callback_token,
            "upload",
            0,
            &format!("Uploading 0/{total} chunks..."),
        )
        .await;
    }

    let upload_delay = Duration::from_millis(350);
    for (idx, chunk) in chunks.iter().enumerate() {
        let filename = chunk.file_name().unwrap().to_str().unwrap().to_string();

        match upload_with_retry(&client, &discord_token, &discord_channel, chunk, &filename).await {
            Ok((url, msg_id)) => {
                let duration = durations.get(&filename).copied().unwrap_or(6.0);
                let line = format!("{filename}|{url}|{msg_id}|{duration}");
                append_to_map(&chunk_map, &line);

                let chunk_num = already_uploaded.len() + idx + 1;
                report_chunk_progress(
                    &client,
                    &callback_base,
                    &job_id,
                    &callback_token,
                    chunk_num,
                    &filename,
                    &url,
                    &msg_id,
                    duration,
                    grand_total,
                )
                .await;
            }
            Err(e) => {
                eprintln!(
                    "[pipeline] Upload failed at chunk {}/{total}: {e}",
                    idx + 1
                );
                std::process::exit(1);
            }
        }

        if idx + 1 < total {
            sleep(upload_delay).await;
        }
    }

    eprintln!("[pipeline] Upload complete: {total} new chunks ({grand_total} total)");
    report_progress(
        &client,
        &callback_base,
        &job_id,
        &callback_token,
        "upload",
        100,
        &format!("Upload complete — {grand_total} chunks"),
    )
    .await;

    Ok(())
}
