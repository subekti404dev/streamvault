# StreamVault Design Spec

**Date:** 2025-06-17  
**Status:** Approved  
**Architecture:** Monolith (Rust + Svelte + Docker)  
**Inspiration:** MagnetVault

---

## 1. Overview

StreamVault is a personal media streaming pipeline that serves as a Stremio addon. Users search for movies/series by IMDB ID, select a torrent, and the system automatically downloads, transcodes to HLS, uploads to Discord for permanent storage, and generates a Stremio-compatible manifest for playback.

### Core Value Proposition

- **Search by IMDB ID** — intuitive, universal movie/series identifier
- **Torrentio integration** — access to a wide range of torrent sources
- **Automated pipeline** — download → transcode → upload → playable in Stremio
- **Checkpoint-based retry** — failed pipelines can resume from the last successful checkpoint
- **Discord as storage** — unlimited, free, permanent storage for HLS chunks
- **Stremio native** — proper addon with catalog, metadata, and HLS streaming via proxy

### Architecture

Single Docker container running a Rust (Axum) backend with Svelte dashboard served as static files. Heavy processing (download, transcode, upload) is offloaded to GitHub Actions CI runners.

```
┌─────────────────────────────────────────────────────────────┐
│                    Docker Container                          │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              Rust Backend (Axum)                        │ │
│  │  • API endpoints (search, queue, settings)             │ │
│  │  • Queue scheduler (poll every 30s, trigger GHA)       │ │
│  │  • Stremio addon manifest + HLS proxy                  │ │
│  │  • Telegram notifications                              │ │
│  │  • GHA callback receiver                               │ │
│  │  • SQLite database                                     │ │
│  └────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────┐ │
│  │           Svelte Dashboard (static files)              │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                        │
                        ▼
              ┌─────────────────┐
              │ GitHub Actions  │
              │ • Download      │
              │ • Transcode     │
              │ • Upload Discord│
              └─────────────────┘
```

---

## 2. Data Flow

### Main Flow

```
User (Dashboard)                     Backend (Rust)                    GitHub CI
     │                                    │                                │
     │  1. Input IMDB ID + S/E            │                                │
     │───────────────────────────────────►│                                │
     │                                    │  2. Fetch metadata (Cinemeta)  │
     │                                    │  3. Search Torrentio           │
     │  4. Return torrent list            │                                │
     │◄───────────────────────────────────│                                │
     │                                    │                                │
     │  5. Select torrent                 │                                │
     │───────────────────────────────────►│                                │
     │                                    │  6. Add to queue (DB)          │
     │                                    │                                │
     │                                    │  7. Scheduler picks up queue   │
     │                                    │     → trigger GHA workflow     │
     │                                    │───────────────────────────────►│
     │                                    │                                │
     │                                    │         8. Download torrent    │
     │                                    │         9. Upload checkpoint   │
     │                                    │            (GH Artifact)       │
     │                                    │        10. Transcode → HLS     │
     │                                    │        11. Upload checkpoint   │
     │  12. Progress updates (SSE)        │            (GH Artifact)       │
     │◄───────────────────────────────────│◄──────────────────────────────│
     │                                    │        13. Upload to Discord   │
     │                                    │        14. Callback complete   │
     │                                    │◄──────────────────────────────│
     │                                    │ 15. Generate manifest          │
     │                                    │ 16. Update status + dequeue    │
     │  17. Telegram notification         │                                │
     │◄ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│                                │
     │                                    │ 18. Process next queue item    │
```

### Stremio Playback Flow

```
Stremio App
    │
    │ GET /stream/series/tt1234567:1:3.json
    │
    ▼
Backend → lookup completed job by imdb_id + season + episode
    │
    │ return HLS manifest URL
    │
    ▼
Stremio → GET /proxy/hls/{job_id}/master.m3u8
    │
    ▼
Backend proxy → fetch chunks from Discord CDN
    │
    ▼
Stremio plays video
```

### Retry from Checkpoint

```
Phase:     Download ──► Transcode ──► Upload
Checkpoint:    ✅            ✅           ❌

User clicks "Retry" → Backend checks last_checkpoint = "transcode"
                    → Re-trigger GHA with skip_download=true, skip_transcode=true
                    → GHA restores transcode checkpoint from GH Artifact
                    → Re-runs upload phase only
```

---

## 3. Database Schema

### jobs

Primary table tracking all media processing jobs from queue to completion.

| Column | Type | Description |
|---|---|---|
| `id` | TEXT (UUID) PK | Unique job identifier |
| `imdb_id` | TEXT NOT NULL | IMDB ID (e.g., "tt1234567") |
| `media_type` | TEXT NOT NULL | "movie" or "series" |
| `season` | INTEGER | Season number (nullable, series only) |
| `episode` | INTEGER | Episode number (nullable, series only) |
| `title` | TEXT | Display title from Cinemeta |
| `poster_url` | TEXT | Poster image URL |
| `magnet_uri` | TEXT | Selected magnet link |
| `infohash` | TEXT | Torrent infohash |
| `torrent_name` | TEXT | Torrent display name |
| `file_idx` | INTEGER | File index within torrent |
| `file_size_bytes` | BIGINT | Source file size |
| `status` | TEXT NOT NULL | Current status (see state machine) |
| `current_phase` | TEXT | "download", "transcode", or "upload" |
| `progress_pct` | INTEGER | Overall progress 0-100 |
| `transcode_pct` | INTEGER | Transcode phase progress 0-100 |
| `upload_pct` | INTEGER | Upload phase progress 0-100 |
| `last_checkpoint` | TEXT | "download" or "transcode" (nullable) |
| `gh_run_id` | TEXT | GitHub Actions run ID (nullable) |
| `gh_artifact_id_dl` | TEXT | Download checkpoint artifact ID |
| `gh_artifact_id_tc` | TEXT | Transcode checkpoint artifact ID |
| `discord_channel_id` | TEXT | Discord channel for HLS uploads |
| `video_resolution` | TEXT | Output resolution (e.g., "1080p") |
| `duration_seconds` | REAL | Video duration in seconds |
| `error_message` | TEXT | Error details if failed |
| `created_at` | TEXT NOT NULL | Job creation timestamp |
| `started_at` | TEXT | Pipeline start timestamp |
| `completed_at` | TEXT | Completion timestamp |
| `updated_at` | TEXT NOT NULL | Last update timestamp |

### job_events

Audit trail for all job status changes and progress updates.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Auto-increment ID |
| `job_id` | TEXT FK | Reference to jobs.id |
| `phase` | TEXT | "download", "transcode", "upload" |
| `event_type` | TEXT | "status_change", "progress", "error", "checkpoint" |
| `message` | TEXT | Human-readable event description |
| `progress_pct` | INTEGER | Progress at time of event |
| `created_at` | TEXT NOT NULL | Event timestamp |

### hls_chunks

HLS chunk files uploaded to Discord for each completed job.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Auto-increment ID |
| `job_id` | TEXT FK | Reference to jobs.id |
| `chunk_index` | INTEGER | Chunk sequence number |
| `filename` | TEXT | Original filename (e.g., "seg_00001.ts") |
| `discord_url` | TEXT | Discord CDN URL |
| `discord_message_id` | TEXT | Discord message ID for the chunk |
| `duration_seconds` | REAL | Chunk duration |
| `file_size_bytes` | BIGINT | Chunk file size |
| `created_at` | TEXT NOT NULL | Upload timestamp |

### cinemeta_cache

Cached metadata from Cinemeta API to reduce external calls.

| Column | Type | Description |
|---|---|---|
| `imdb_id` | TEXT PK | IMDB ID |
| `media_type` | TEXT PK | "movie" or "series" |
| `title` | TEXT | Title |
| `poster_url` | TEXT | Poster image URL |
| `overview` | TEXT | Synopsis |
| `year` | INTEGER | Release year |
| `total_seasons` | INTEGER | Number of seasons (series only) |
| `cached_at` | TEXT | Cache timestamp |

### app_settings

Key-value configuration store.

| Column | Type | Description |
|---|---|---|
| `key` | TEXT PK | Setting key |
| `value` | TEXT | Setting value |

### Job State Machine

```
  queued ──► processing ──► downloading ──► checkpoint_download
                                                  │
                                             transcoding ──► checkpoint_transcode
                                                  │
                                              uploading ──► completed
                                                  │
                                               failed ──► (retry) ──► queued
```

**Status values:**

| Status | Phase | Description |
|---|---|---|
| `queued` | — | Waiting in queue |
| `processing` | download | GHA triggered, pipeline starting |
| `downloading` | download | Torrent downloading in progress |
| `checkpoint_download` | download | Download saved as GH Artifact |
| `transcoding` | transcode | HLS transcoding in progress |
| `checkpoint_transcode` | transcode | HLS chunks saved as GH Artifact |
| `uploading` | upload | Uploading chunks to Discord |
| `completed` | — | Done, manifest generated |
| `failed` | — | Error occurred |

### Indexes

```sql
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_imdb_id ON jobs(imdb_id);
CREATE INDEX idx_jobs_created_at ON jobs(created_at DESC);
CREATE INDEX idx_job_events_job_id ON job_events(job_id);
CREATE INDEX idx_hls_chunks_job_id ON hls_chunks(job_id);
```

---

## 4. API Design

### REST API Endpoints (authenticated)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/v1/search` | Search torrents by IMDB ID |
| `POST` | `/api/v1/queue` | Add selected torrent to queue |
| `GET` | `/api/v1/queue` | List all jobs (queued + processing + completed) |
| `GET` | `/api/v1/queue/:id` | Get job detail + events |
| `POST` | `/api/v1/queue/:id/retry` | Retry failed job from last checkpoint |
| `DELETE` | `/api/v1/queue/:id` | Cancel/remove job |
| `GET` | `/api/v1/events` | SSE stream for real-time progress |
| `GET` | `/api/v1/settings` | Get app settings |
| `PUT` | `/api/v1/settings` | Update app settings |
| `GET` | `/api/v1/library` | List completed media |
| `DELETE` | `/api/v1/library/:id` | Remove completed media |

### GHA Callback Endpoints (server-authenticated)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/v1/jobs/:id/progress` | Update progress from GHA |
| `POST` | `/api/v1/jobs/:id/checkpoint` | Report checkpoint saved |
| `POST` | `/api/v1/jobs/:id/complete` | Pipeline completed successfully |
| `POST` | `/api/v1/jobs/:id/failed` | Pipeline failed |

### Stremio Addon Endpoints (public, no auth)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/manifest.json` | Stremio addon manifest |
| `GET` | `/catalog/:type/streamvault.json` | Catalog listing (user's library) |
| `GET` | `/meta/:type/:imdb_id.json` | Metadata for a specific title |
| `GET` | `/stream/:type/:id.json` | Stream URLs (HLS manifest) |

**Stremio Stream ID format:**
- Movie: `tt1234567`
- Series: `tt1234567:1:3` (imdb_id:season:episode)

### HLS Proxy Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/proxy/hls/:job_id/master.m3u8` | Master HLS playlist |
| `GET` | `/proxy/hls/:job_id/:filename` | Serve HLS chunk via Discord CDN proxy |

### Request/Response Examples

**Search:**
```
POST /api/v1/search
{
  "imdb_id": "tt0903747",
  "media_type": "series",
  "season": 1,
  "episode": 3
}

Response: {
  "meta": {
    "title": "Breaking Bad",
    "poster": "https://image.tmdb.org/...",
    "year": 2008
  },
  "torrents": [
    {
      "name": "RARBG",
      "title": "Breaking.Bad.S01E03.1080p.BluRay.x264",
      "size_bytes": 4500000000,
      "infohash": "abc123...",
      "magnet_uri": "magnet:?xt=urn:btih:abc123...",
      "file_idx": 0
    }
  ]
}
```

**Queue:**
```
POST /api/v1/queue
{
  "imdb_id": "tt0903747",
  "media_type": "series",
  "season": 1,
  "episode": 3,
  "magnet_uri": "magnet:?xt=urn:btih:abc123...",
  "infohash": "abc123...",
  "torrent_name": "Breaking.Bad.S01E03.1080p.BluRay.x264",
  "file_idx": 0,
  "file_size_bytes": 4500000000
}

Response: { "job_id": "uuid-...", "status": "queued" }
```

**Stremio Stream Response:**
```json
{
  "streams": [
    {
      "name": "StreamVault\n1080p H.264",
      "url": "https://server.com/proxy/hls/{job_id}/master.m3u8",
      "description": "S01E03 • 1080p • H.264 / AAC"
    }
  ]
}
```

---

## 5. GitHub Actions Pipeline

### Workflow File

`.github/workflows/streamvault-pipeline.yml`

### Trigger

Backend triggers workflow via `workflow_dispatch` API with inputs:

| Input | Description |
|---|---|
| `job_id` | StreamVault job ID |
| `magnet_uri` | Magnet link to download |
| `file_idx` | File index within torrent |
| `callback_url` | Backend callback base URL |
| `callback_token` | Auth token for callbacks |
| `skip_download` | Skip download, restore from checkpoint |
| `skip_transcode` | Skip transcode, restore from checkpoint |

### Pipeline Phases

**Phase 1: Download**
- Use `aria2c` for fast BitTorrent downloads
- Select specific file by index
- Save as GH Artifact checkpoint (chunked if > 2GB)
- Report checkpoint saved via callback

**Phase 2: Transcode**
- Detect source resolution via `ffprobe`
- Cap output at 1080p (downscale if higher)
- Encode: H.264 video + AAC audio
- Output: HLS segments (6s chunks)
- Save as GH Artifact checkpoint
- Report checkpoint saved via callback

**Phase 3: Upload to Discord**
- Upload each `.ts` chunk + `.m3u8` to Discord channel
- Report per-chunk progress via callback
- Handle Discord rate limits (50 req/s per bot token)
- Use retry with exponential backoff for failed uploads

**Phase 4: Complete**
- Report completion via callback with metadata (resolution, duration)
- Backend generates HLS manifest, updates DB, sends Telegram notification

### GH Artifact Chunking (files > 2GB)

```bash
# Split before upload
split -b 1500M source.mkv chunk_

# Upload each as separate artifact
for f in chunk_*; do
  actions/upload-artifact@v4 with name: "checkpoint-dl-{job_id}-{basename}"
done

# Download & reassemble on restore
cat chunk_* > source.mkv
```

### Progress Reporting

Each phase reports progress to backend via callback:

| Phase | Progress Granularity |
|---|---|
| Download | Every 5% (from aria2 output parsing) |
| Transcode | Every 5% (from ffmpeg progress) |
| Upload | Per chunk (chunk N of M) |

Backend converts these into SSE events for real-time dashboard updates.

---

## 6. Frontend Dashboard

### Tech Stack

- Svelte 5 + Vite
- TypeScript
- SSE for real-time updates
- Same glassmorphism UI style as MagnetVault

### Pages

**1. Search Page (Home)**
- IMDB ID input field
- Series toggle with season/episode inputs
- Metadata preview (title, poster, year from Cinemeta)
- Torrent results list with "Add to Queue" buttons

**2. Queue Page**
- Processing section: active job with 3-phase progress indicator
- Queued section: waiting jobs list
- Library section: completed media list
- Real-time updates via SSE

**3. Settings Page**
- GitHub config (token, repo)
- Discord config (bot token, channel ID)
- Telegram config (bot token, channel ID, enable/disable)
- Torrentio proxy URL
- Stremio config (public URL, addon name)

**4. Job Detail Page**
- Full progress timeline with phase breakdown
- Event log
- Checkpoint status
- Retry button (auto-selects best checkpoint)
- Error details if failed

### Progress Display

Each processing job shows a 3-phase progress indicator:

```
┌──────────┐  ┌──────────┐  ┌──────────┐
│ Download │→ │Transcode │→ │Upload    │
│ ████░░ 67%│  │  ░░░░░░  │  │  ░░░░░░  │
└──────────┘  └──────────┘  └──────────┘
```

Active phase shows real progress bar. Inactive phases show empty. Completed phases show checkmark.

---

## 7. Error Handling & Retry

### Retry Matrix

| Failure Point | Available Checkpoint | Retry Action |
|---|---|---|
| Download fails | None | Full restart |
| Transcode fails | `checkpoint-download` | Skip download, re-run transcode + upload |
| Upload fails | `checkpoint-transcode` | Skip download + transcode, re-run upload only |
| Callback fails | All phases done | Re-trigger complete callback |

### Backend Retry Logic

```rust
pub async fn retry_job(pool: &SqlitePool, job_id: &str) -> Result<(), AppError> {
    let job = get_job(pool, job_id).await?;

    let (skip_download, skip_transcode) = match job.last_checkpoint.as_deref() {
        Some("transcode") => (true, true),
        Some("download")  => (true, false),
        _                 => (false, false),
    };

    update_job_status(pool, job_id, "queued").await?;
    trigger_pipeline(pool, &job, skip_download, skip_transcode).await?;

    Ok(())
}
```

### GHA Callback Retry

All callbacks from GHA use exponential backoff:
- Max 5 retries
- Initial delay: 2 seconds
- Backoff multiplier: 2x
- Max delay: 32 seconds

### GH Artifact Expiry

- Checkpoint retention: 7 days
- If artifact expired before retry → full restart required
- Backend checks artifact availability before triggering retry

### Stale Job Recovery

On backend startup:
1. Find all jobs with `status` in processing states
2. Check their GHA run status via GitHub API
3. If GHA completed → mark job completed (via callback data)
4. If GHA failed → mark job failed, allow retry
5. If GHA still running → continue monitoring

---

## 8. Telegram Notifications

### Events

| Event | Message |
|---|---|
| `JobQueued` | "🎬 Added to queue: {title}" |
| `JobStarted` | "⚙️ Processing started: {title}" |
| `CheckpointSaved` | "💾 Checkpoint saved: {phase}" |
| `JobCompleted` | Full summary with resolution, duration, pipeline time |
| `JobFailed` | "❌ Failed: {title} at {phase} — {error}" |

### Completion Message Format

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ StreamVault - Download Complete

🎬 Breaking Bad S01E03
📐 Resolution: 1080p
⏱️ Duration: 47 min
📊 Pipeline: 25m 12s total
   Download: 6m 32s
   Transcode: 12m 45s
   Upload: 5m 55s

🎬 Ready to watch in Stremio!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 9. Transcoding

### Strategy: Source-dependent with 1080p cap

```
if source_height <= 1080:
    output_height = source_height
else:
    output_height = 1080
```

### FFmpeg Parameters

```bash
ffmpeg -i source.mkv \
  -c:v libx264 -preset fast -crf 23 \
  -vf "scale=-2:{target_height}" \
  -c:a aac -b:a 128k \
  -hls_time 6 -hls_list_size 0 \
  -hls_segment_filename "seg_%05d.ts" \
  -f hls master.m3u8
```

### Output Format

- Video: H.264 (libx264), fast preset, CRF 23
- Audio: AAC, 128kbps stereo
- Container: HLS (`.m3u8` + `.ts` segments)
- Segment duration: 6 seconds

---

## 10. Stremio Addon

### Manifest

```json
{
  "id": "com.streamvault.addon",
  "version": "1.0.0",
  "name": "StreamVault",
  "description": "Personal media library",
  "resources": ["catalog", "meta", "stream"],
  "types": ["movie", "series"],
  "catalogs": [
    { "type": "movie", "id": "streamvault-movies", "name": "Movies" },
    { "type": "series", "id": "streamvault-series", "name": "Series" }
  ],
  "id_prefixes": ["tt"],
  "behaviorHints": {
    "configurable": false,
    "configurationRequired": false
  }
}
```

### Catalog Response

Returns all completed movies/series from the library:

```json
{
  "metas": [
    {
      "id": "tt0903747",
      "type": "series",
      "name": "Breaking Bad",
      "poster": "https://image.tmdb.org/..."
    }
  ]
}
```

### Stream Response

For completed jobs, returns HLS URL via proxy:

```json
{
  "streams": [
    {
      "name": "StreamVault\n1080p H.264",
      "url": "https://server.com/proxy/hls/{job_id}/master.m3u8",
      "description": "1080p • H.264 / AAC"
    }
  ]
}
```

For non-completed jobs, returns empty streams (user must add via dashboard first).

### HLS Proxy

Backend proxies HLS chunks from Discord CDN:
- `/proxy/hls/:job_id/master.m3u8` — serves the HLS master playlist with rewritten chunk URLs
- `/proxy/hls/:job_id/:filename` — fetches chunk from Discord CDN and streams to client
- Discord CDN URLs are never exposed directly to Stremio (prevents URL expiry issues)

---

## 11. Queue Management

### Concurrency

**Sequential (1 job at a time)** — avoids Discord rate limit issues and simplifies error handling.

### Scheduler Logic

```
Every 30 seconds:
  1. Check if any job is currently processing
  2. If no active job:
     a. Find oldest job with status = "queued"
     b. Update status to "processing"
     c. Trigger GHA workflow with job details
  3. If active job exists:
     a. Check GHA run status
     b. If completed → mark job completed, notify, process next
     c. If failed → mark job failed, notify, process next
     d. If running → continue monitoring
```

### Queue Priority

FIFO (first in, first out). Oldest queued job is processed first.

---

## 12. Deployment

### Docker Compose

```yaml
services:
  streamvault:
    image: ghcr.io/yourname/streamvault:latest
    ports:
      - "8080:8080"
    volumes:
      - streamvault-data:/data
    environment:
      - STREAMVAULT_DATABASE_URL=sqlite:/data/streamvault.db
      - STREAMVAULT_AUTH_SECRET=your-secret-token
      - STREAMVAULT_PUBLIC_BASE_URL=https://your-domain.com
      - RUST_LOG=info
    restart: unless-stopped

volumes:
  streamvault-data:
```

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `STREAMVAULT_DATABASE_URL` | Yes | — | SQLite path |
| `STREAMVAULT_AUTH_SECRET` | Yes | — | Dashboard auth token |
| `STREAMVAULT_PUBLIC_BASE_URL` | Yes | — | Public URL for Stremio manifest |
| `STREAMVAULT_GH_TOKEN` | No | — | GitHub PAT (or set via dashboard) |
| `STREAMVAULT_GH_REPO` | No | — | GitHub repo `owner/name` |
| `STREAMVAULT_DISCORD_BOT_TOKEN` | No | — | Discord bot token |
| `STREAMVAULT_DISCORD_CHANNEL_ID` | No | — | Discord channel ID |
| `STREAMVAULT_TELEGRAM_BOT_TOKEN` | No | — | Telegram bot token |
| `STREAMVAULT_TELEGRAM_CHANNEL_ID` | No | — | Telegram channel ID |
| `STREAMVAULT_TORRENTIO_BASE_URL` | No | — | Torrentio proxy URL |
| `STREAMVAULT_DASHBOARD_DIR` | No | `/app/dashboard` | Dashboard static files dir |
| `RUST_LOG` | No | `info` | Log level |

### App Settings (via dashboard/API)

| Key | Description |
|---|---|
| `gh_token` | GitHub PAT for triggering workflows |
| `gh_repo` | GitHub repo (owner/name) |
| `discord_bot_token` | Discord bot token |
| `discord_channel_id` | Discord channel for HLS uploads |
| `telegram_bot_token` | Telegram bot token |
| `telegram_channel_id` | Telegram channel for notifications |
| `notifications_enabled` | Enable/disable Telegram notifications |
| `torrentio_base_url` | Torrentio proxy URL |
| `public_base_url` | Public URL for Stremio manifest |
| `auth_secret` | Dashboard auth token |
| `stremio_addon_id` | Stremio addon ID |
| `stremio_addon_name` | Stremio addon display name |

---

## 13. External Services

### Cinemeta (free, no API key)

- Metadata source for IMDB titles
- Endpoint: `https://v3-cinemeta.strem.io/meta/{type}/{imdb_id}.json`
- Returns: title, poster, backdrop, overview, year, episodes
- No rate limiting, no authentication required

### Torrentio (via proxy)

- Torrent search source
- Endpoint: `{proxy_url}/stream/{type}/{id}.json`
- Requires proxy to bypass Cloudflare (same as MagnetVault)
- For series: `{id}` = `tt1234567:1:3`

### GitHub Actions

- Pipeline execution environment
- Ubuntu latest runner (4 vCPU, 16GB RAM, 14GB SSD)
- Timeout: 360 minutes (6 hours)
- Artifact retention: 7 days for checkpoints

### Discord

- Permanent HLS chunk storage
- Bot API for file uploads (multipart)
- Rate limit: 50 requests/second per bot token
- CDN URLs are permanent (tied to message)

### Telegram

- Notification delivery
- Bot API for message sending
- Used for job completion/failure alerts

---

## 14. Migration Path to Vercel

When ready for production, migrate incrementally:

1. **Frontend first** — Deploy Svelte dashboard to Vercel, point API to Docker backend
2. **Database** — Migrate SQLite to Turso (libSQL) or Neon (Postgres)
3. **API** — Convert Axum handlers to Vercel serverless functions
4. **Scheduler** — Replace worker loop with Vercel Cron Jobs (1/min)
5. **Stremio addon** — Deploy as Vercel serverless function

### Required Changes

- SQLite → Turso/Neon (change SQLx driver)
- Worker loop → Cron trigger (poll queue every minute)
- File serving → proxy only (no local filesystem)
- In-memory broadcast → Redis pub/sub or polling

---

## 15. Project Structure

```
streamvault/
├── backend/
│   ├── src/
│   │   ├── api/
│   │   │   ├── auth.rs          # Bearer token auth
│   │   │   ├── queue.rs         # Queue CRUD + retry
│   │   │   ├── search.rs        # Torrentio search proxy
│   │   │   ├── library.rs       # Completed media listing
│   │   │   ├── settings.rs      # App settings CRUD
│   │   │   ├── events.rs        # SSE broadcast
│   │   │   └── callbacks.rs     # GHA callback receivers
│   │   ├── stremio/
│   │   │   ├── routes.rs        # manifest, catalog, stream
│   │   │   ├── proxy.rs         # HLS proxy from Discord CDN
│   │   │   └── models.rs        # Stremio types
│   │   ├── pipeline/
│   │   │   ├── trigger.rs       # GHA workflow_dispatch
│   │   │   ├── tokens.rs        # GitHub PAT management
│   │   │   └── scheduler.rs     # Queue → GHA dispatcher
│   │   ├── notifications/
│   │   │   ├── telegram.rs      # Telegram bot sender
│   │   │   └── mod.rs
│   │   ├── db/
│   │   │   ├── mod.rs           # SQLite pool + migrations
│   │   │   └── migrations/
│   │   │       └── 0001_initial.sql
│   │   ├── worker/
│   │   │   ├── scheduler.rs     # Poll queue, trigger GHA
│   │   │   └── monitor.rs       # Monitor GHA run status
│   │   ├── error.rs
│   │   ├── config.rs
│   │   ├── app.rs
│   │   └── main.rs
│   ├── Cargo.toml
│   └── scripts/
│       └── pipeline/
│           ├── upload-to-discord.sh
│           └── callback.sh
├── dashboard/
│   ├── src/
│   │   ├── App.svelte
│   │   ├── lib/
│   │   │   ├── api.ts
│   │   │   ├── types.ts
│   │   │   └── events.ts        # SSE client
│   │   └── app.css
│   ├── package.json
│   ├── index.html
│   └── vite.config.ts
├── docker/
│   ├── Dockerfile
│   └── entrypoint.sh
├── .github/
│   └── workflows/
│       ├── docker-build.yml
│       └── streamvault-pipeline.yml
├── docker-compose.yml
└── docs/
    └── superpowers/
        └── specs/
            └── 2025-06-17-streamvault-design.md
```
