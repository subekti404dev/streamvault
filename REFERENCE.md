# StreamVault Reference: MagnetVault (cachy)

This document summarizes key architectural patterns and solutions from the MagnetVault project that are relevant to StreamVault.

## Project Overview

**MagnetVault** is a similar Stremio addon + Rust backend + Svelte dashboard project that:
- Downloads torrents using librqbit (in-process, no external pipeline)
- Caches files locally on filesystem
- Uses SQLite for state management
- Has proper worker lifecycle with cancel, timeout, recovery
- Uses a Torrentio proxy to bypass Cloudflare blocking

## Key Differences from StreamVault

| Aspect | MagnetVault | StreamVault |
|--------|-------------|-------------|
| Download method | librqbit (in-process) | GitHub Actions + aria2c (external) |
| Storage | Local filesystem cache | Discord CDN (via HLS upload) |
| Concurrency | Multiple worker loops | Single GHA workflow per job |
| Cancel mechanism | DB flag + polling | Cancel GHA workflow |
| Torrentio access | Vercel proxy | Direct (may be blocked) |

## Torrentio Integration

### The Cloudflare Problem

Cloudflare blocks datacenter IP ranges (OCI, AWS, etc.) from accessing `torrentio.strem.fun`. This affects:
- StreamVault backend running on VPS
- GitHub Actions runners
- Any server-side fetch from Torrentio

### MagnetVault's Solution: Vercel Proxy

MagnetVault deploys a lightweight Vercel serverless function as a reverse proxy:

```
Backend (VPS) → torrentio-proxy.vercel.app → torrentio.strem.fun
```

**Why it works:**
- Vercel edge functions pass Cloudflare's JS challenge
- Proxy sets browser-like headers (Firefox UA, Stremio Referer/Origin)
- Edge caching with `s-maxage=3600`

**Implementation:**
- `torrentio-proxy/api/proxy.js` - Vercel serverless function
- `torrentio-proxy/vercel.json` - Rewrite rules and CORS headers
- Backend uses proxy URL instead of direct Torrentio URL

**Proxy headers:**
```javascript
headers: {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:151.0) Gecko/20100101 Firefox/151.0',
  'Accept': '*/*',
  'Referer': 'https://web.stremio.com/',
  'Origin': 'https://web.stremio.com',
}
```

### StreamVault's Current Approach

StreamVault currently fetches directly from Torrentio in `backend/src/api/search.rs`:
```rust
let url = format!("https://torrentio.strem.fun/stream/{}/{}.json", ...);
```

**Potential issues:**
- May fail if VPS IP is blocked by Cloudflare
- No fallback mechanism

**Recommended improvement:**
- Deploy similar Vercel proxy
- Configure `TORRENTIO_BASE_URL` env var to use proxy
- Add error handling for blocked requests

## Torrentio Response Parsing

### Proper Model Structure

MagnetVault uses proper Rust structs with serde for type-safe parsing:

```rust
#[derive(Debug, Deserialize)]
pub struct TorrentioResponse {
    pub streams: Vec<TorrentioStream>,
}

#[derive(Debug, Deserialize)]
pub struct TorrentioStream {
    pub name: String,
    pub title: String,
    #[serde(rename = "infoHash")]
    pub info_hash: String,
    #[serde(rename = "fileIdx")]
    pub file_idx: i64,
    #[serde(rename = "behaviorHints")]
    pub behavior_hints: Option<TorrentioBehaviorHints>,
}

#[derive(Debug, Deserialize)]
pub struct TorrentioBehaviorHints {
    pub filename: Option<String>,
    #[serde(rename = "bingeGroup")]
    pub binge_group: Option<String>,
}
```

### StreamVault's Current Approach

StreamVault uses manual JSON parsing with `serde_json::Value`:
```rust
let filename = stream.get("behaviorHints")
    .and_then(|bh| bh.get("filename"))
    .and_then(|v| v.as_str())
```

**Works but less type-safe.** Consider adopting MagnetVault's struct-based approach for better maintainability.

## File Detection Strategy

### MagnetVault's Approach

MagnetVault doesn't need complex file detection because:
- Downloads are managed by librqbit in-process
- Files are stored in predictable location: `/data/cache/{infohash}/`
- Torrent metadata is parsed immediately after download
- File list is stored in `torrent_files` table

### StreamVault's Approach

StreamVault needs robust file detection because:
- Downloads happen externally (GHA + aria2c)
- Files are uploaded to Discord
- Need to identify which file to transcode

**Current 3-tier strategy:**
1. Match by `torrent_name` (exact filename from `behaviorHints.filename`)
2. Match by video extension (.mp4, .mkv, etc.)
3. Match large file >100MB

**Improvement from MagnetVault:**
- Use exact `behaviorHints.filename` (✓ already implemented)
- Store filename in job record for reference

## Worker Lifecycle Patterns

### MagnetVault's Worker Supervisor

```rust
// Reads job_concurrency from DB every 15s
// Maintains N worker loops by spawning/aborting as needed
spawn_worker_supervisor(db, concurrency);
```

**Features:**
- Dynamic concurrency adjustment
- Automatic worker restart on panic
- Graceful shutdown with cancellation tokens

### StreamVault's Scheduler

```rust
// Simple loop that checks for queued jobs
scheduler_loop(state).await;
```

**Current limitations:**
- Single worker (no concurrency)
- No graceful shutdown
- No panic recovery

**Potential improvements:**
- Add concurrency support (multiple parallel jobs)
- Add cancellation tokens for graceful shutdown
- Add supervisor pattern for crash recovery

## Cancel Mechanism

### MagnetVault's Approach

```rust
// DB flag approach
UPDATE downloads SET cancelled_at = NOW() WHERE id = ?;

// Worker polls every 2s
if check_job_cancelled(db, job_id).await? {
    return Err(TorrentEngineError::Cancelled);
}
```

**Benefits:**
- No shared mutable state
- Survives restarts
- Clean separation of concerns

### StreamVault's Approach

```rust
// Cancel GHA workflow via GitHub API
gh run cancel <run_id>
```

**Benefits:**
- Stops external process immediately
- No polling needed

**Trade-offs:**
- Requires storing GHA run_id
- Network dependency on GitHub API
- No local state tracking

## Timeout and Recovery

### MagnetVault's Patterns

**Per-job timeout:**
```rust
tokio::select! {
    result = download => result,
    _ = sleep(timeout) => Err(TorrentEngineError::Timeout),
}
```

**Restart recovery:**
```rust
// On startup, reset stuck downloads
UPDATE downloads 
SET status = 'queued' 
WHERE status = 'downloading';
```

### StreamVault's Patterns

**GHA workflow timeout:**
```yaml
timeout-minutes: 360
```

**Idle timeout in download script:**
```bash
MAX_IDLE_SECONDS=300  # Abort if no progress for 5 min
```

**Restart recovery:**
```rust
// monitor.rs checks for stale jobs on startup
recover_stale_jobs(state).await;
```

## Database Schema Patterns

### MagnetVault's Download States

```
queued → downloading → completed
                   → failed
                   → cancelled
                   → evicted
                   → deleted
```

**Terminal states:** completed, failed, cancelled, evicted, deleted

### StreamVault's Job States

```
queued → processing → downloading → checkpoint_download
                                  → transcoding → checkpoint_transcode
                                                → uploading → completed
                                                            → failed
```

**More granular phases** for better progress tracking.

## Notification System

### MagnetVault's Telegram Integration

```rust
// Called after successful download
if notifications_enabled {
    send_download_complete(
        bot_token,
        channel_id,
        torrent_name,
        infohash,
        file_count,
        total_size,
    ).await;
}
```

**Non-blocking:** Errors are logged, not propagated.

### StreamVault's Notification System

Currently has:
- `notifications/telegram.rs` - Telegram sender
- `notifications/discord.rs` - Discord webhook

**Similar pattern:** Non-blocking, best-effort delivery.

## Cache Management

### MagnetVault's Eviction

```rust
// Enforce max_cached_entries limit
if completed_count > max_entries {
    let oldest = select_oldest_completed(limit);
    for entry in oldest {
        delete_directory(entry.path);
        mark_as_evicted(entry.id);
    }
}
```

### StreamVault's Approach

- Discord has unlimited storage (per-channel)
- No eviction needed
- Can delete old jobs manually via dashboard

## Key Takeaways for StreamVault

### Immediate Improvements

1. **Deploy Torrentio proxy** to avoid Cloudflare blocking
2. **Use exact filename** from `behaviorHints.filename` (✓ done)
3. **Add proper error handling** for Torrentio fetch failures

### Medium-term Improvements

1. **Type-safe Torrentio models** instead of manual JSON parsing
2. **Worker concurrency** to process multiple jobs in parallel
3. **Graceful shutdown** with cancellation tokens

### Long-term Considerations

1. **In-process downloads** using librqbit (eliminates GHA dependency)
2. **Local caching** before Discord upload (faster retries)
3. **Supervisor pattern** for worker crash recovery

## Code References

- Torrentio proxy: `/Volumes/SSD/Projects/cachy/torrentio-proxy/`
- Torrentio client: `/Volumes/SSD/Projects/cachy/backend/src/stremio/torrentio.rs`
- Response models: `/Volumes/SSD/Projects/cachy/backend/src/stremio/models.rs`
- Worker lifecycle: `/Volumes/SSD/Projects/cachy/backend/src/worker/`
- Architecture docs: `/Volumes/SSD/Projects/cachy/ARCHITECTURE.md`
