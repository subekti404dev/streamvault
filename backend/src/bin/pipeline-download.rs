//! Torrent download binary using librqbit.
//!
//! Usage: pipeline-download <job_id> <callback_url> <callback_token> <magnet_uri> <file_idx>
//!
//! Environment:
//!   MAX_IDLE_SECONDS  - abort if no progress (default: 600)
//!   MAX_TOTAL_SECONDS - abort overall (default: 7200)

use std::path::PathBuf;
use std::time::{Duration, Instant};

use librqbit::{AddTorrent, AddTorrentOptions, PeerConnectionOptions, Session};

const FALLBACK_TRACKERS: &[&str] = &[
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://open.tracker.cl:1337/announce",
    "udp://tracker.altrosky.nl:6969/announce",
    "http://tracker.bt4g.com:2095/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.tiny-vps.com:6969/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
    "udp://tracker.dler.org:6969/announce",
    "udp://opentracker.i2p.rocks:6969/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://tracker.openbittorrent.com:80/announce",
    "udp://tracker.moeking.me:6969/announce",
    "udp://tracker.itame.org:6969/announce",
    "udp://tracker1.bt.moack.co.kr:80/announce",
    "udp://tracker2.dler.org:80/announce",
    "https://tracker.tamersunion.org:443/announce",
    "https://tracker.gbitt.info:443/announce",
    "http://tracker.files.fm:6969/announce",
    "http://openbittorrent.com:80/announce",
];

async fn fetch_trackers() -> Vec<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap_or_default();

    match client
        .get("https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt")
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            let text = resp.text().await.unwrap_or_default();
            let trackers: Vec<String> = text
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect();
            if trackers.is_empty() {
                eprintln!("Trackers list empty, using fallback");
                FALLBACK_TRACKERS.iter().map(|s| s.to_string()).collect()
            } else {
                eprintln!("Fetched {} trackers from trackerslist", trackers.len());
                trackers
            }
        }
        _ => {
            eprintln!("Failed to fetch trackers, using fallback list");
            FALLBACK_TRACKERS.iter().map(|s| s.to_string()).collect()
        }
    }
}

async fn send_progress(
    client: &reqwest::Client,
    base_url: &str,
    token: &str,
    job_id: &str,
    pct: u32,
) {
    let url = format!("{base_url}/api/v1/jobs/{job_id}/progress");
    let payload = serde_json::json!({
        "phase": "download",
        "progress_pct": pct
    });
    let _ = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("X-Callback-Token", token)
        .json(&payload)
        .send()
        .await;
}

async fn run_download(
    job_id: &str,
    callback_url: &str,
    callback_token: &str,
    magnet_uri: &str,
    file_idx: usize,
    max_idle: Duration,
    max_total: Duration,
) -> Result<(), String> {
    let output_dir = PathBuf::from("./downloads");
    std::fs::create_dir_all(&output_dir).map_err(|e| format!("mkdir downloads: {e}"))?;

    let session = Session::new(output_dir)
        .await
        .map_err(|e| format!("create session: {e}"))?;

    let trackers = fetch_trackers().await;

    let mut options = AddTorrentOptions::default();
    if file_idx > 0 {
        options.only_files = Some(vec![file_idx - 1]);
    }
    options.overwrite = true;
    options.trackers = Some(trackers);
    options.force_tracker_interval = Some(Duration::from_secs(30));
    options.peer_opts = Some(PeerConnectionOptions {
        connect_timeout: Some(Duration::from_secs(15)),
        read_write_timeout: Some(Duration::from_secs(30)),
        keep_alive_interval: Some(Duration::from_secs(60)),
    });

    let handle = session
        .add_torrent(AddTorrent::from_url(magnet_uri), Some(options))
        .await
        .map_err(|e| format!("add torrent: {e}"))?
        .into_handle()
        .ok_or_else(|| "torrent already managed".to_string())?;

    let client = reqwest::Client::new();
    send_progress(&client, callback_url, callback_token, job_id, 0).await;

    let start = Instant::now();
    let mut last_progress = Instant::now();
    let mut last_pct: u32 = 0;
    let mut last_progress_bytes: u64 = 0;

    loop {
        tokio::time::sleep(Duration::from_secs(3)).await;

        let stats = handle.stats();

        let pct = if stats.total_bytes > 0 {
            ((stats.progress_bytes as f64 / stats.total_bytes as f64) * 100.0).min(99.0) as u32
        } else if stats.progress_bytes > 0 {
            1
        } else {
            0
        };

        // Track real progress
        if stats.progress_bytes > last_progress_bytes {
            last_progress_bytes = stats.progress_bytes;
            last_progress = Instant::now();
        }

        // Check idle timeout
        if last_progress.elapsed() > max_idle {
            eprintln!(
                "No download progress for {}s. Aborting.",
                max_idle.as_secs()
            );
            return Err("idle timeout".to_string());
        }

        // Check total timeout
        if start.elapsed() > max_total {
            eprintln!("Download timed out after {}s", max_total.as_secs());
            return Err("total timeout".to_string());
        }

        // Check completion
        if stats.finished {
            send_progress(&client, callback_url, callback_token, job_id, 100).await;
            eprintln!("Download complete: {} bytes", stats.progress_bytes);
            return Ok(());
        }

        // Periodic progress callback
        if pct != last_pct {
            last_pct = pct;
            send_progress(&client, callback_url, callback_token, job_id, pct).await;
            let peers = if stats.live.is_some() { "some" } else { "none" };
            eprintln!(
                "Download: {}% ({}/{} bytes, {peers} peers)",
                pct, stats.progress_bytes, stats.total_bytes,
            );
        }
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 6 {
        eprintln!(
            "Usage: pipeline-download <job_id> <callback_url> <callback_token> <magnet_uri> <file_idx>"
        );
        std::process::exit(1);
    }

    let job_id = &args[1];
    let callback_url = &args[2];
    let callback_token = &args[3];
    let magnet_uri = &args[4];
    let file_idx: usize = args[5].parse().unwrap_or(1);

    let max_idle = std::env::var("MAX_IDLE_SECONDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .map(Duration::from_secs)
        .unwrap_or(Duration::from_secs(600));

    let max_total = std::env::var("MAX_TOTAL_SECONDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .map(Duration::from_secs)
        .unwrap_or(Duration::from_secs(7200));

    eprintln!("pipeline-download: job={job_id}, file_idx={file_idx}");
    eprintln!(
        "Max idle: {}s, Max total: {}s",
        max_idle.as_secs(),
        max_total.as_secs()
    );

    match run_download(
        job_id,
        callback_url,
        callback_token,
        magnet_uri,
        file_idx,
        max_idle,
        max_total,
    )
    .await
    {
        Ok(()) => eprintln!("Download complete"),
        Err(e) => {
            eprintln!("Download failed: {e}");
            std::process::exit(1);
        }
    }
}
