# StreamVault Implementation Plan

**Based on:** [2025-06-17-streamvault-design.md](./2025-06-17-streamvault-design.md)
**Created:** 2025-06-17
**Status:** Ready for Implementation

---

## Overview

This plan breaks StreamVault into **9 phases** with **47 concrete tasks**, ordered by dependency. Each phase produces a working, testable increment. Estimated complexity per task: 🟢 simple, 🟡 moderate, 🔴 complex.

### Dependency Graph

```
Phase 1: Foundation
    │
    ├──► Phase 2: Core Backend API
    │        │
    │        ├──► Phase 3: GitHub Actions Pipeline
    │        │        │
    │        │        └──► Phase 4: Pipeline Integration (scheduler, callbacks, retry)
    │        │
    │        └──► Phase 5: Stremio Addon + HLS Proxy
    │
    ├──► Phase 6: Real-time & Notifications (SSE + Telegram)
    │
    └──► Phase 7: Frontend Dashboard (Svelte 5)
              │
              └──► Phase 8: Docker & CI/CD
                       │
                       └──► Phase 9: Hardening & Polish
```

---

## Phase 1: Foundation

**Goal:** Project scaffolding, database, configuration, error types. Everything else builds on this.

### Task 1.1 — Project Scaffolding 🟢
Create the full directory structure as defined in the spec (§15).

```
streamvault/
├── backend/
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs
│       ├── app.rs
│       ├── config.rs
│       └── error.rs
├── dashboard/          (empty, scaffolded in Phase 7)
├── docker/
├── .github/workflows/
├── docker-compose.yml
└── docs/
```

**Concrete steps:**
- [ ] `cargo init backend/` — initialize Rust project
- [ ] Add dependencies to `Cargo.toml`:
  ```toml
  [dependencies]
  axum = { version = "0.7", features = ["json", "query"] }
  axum-extra = { version = "0.9", features = ["typed-header"] }
  tower = "0.4"
  tower-http = { version = "0.5", features = ["cors", "fs", "trace"] }
  tokio = { version = "1", features = ["full"] }
  sqlx = { version = "0.8", features = ["runtime-tokio", "sqlite"] }
  serde = { version = "1", features = ["derive"] }
  serde_json = "1"
  reqwest = { version = "0.12", features = ["json", "stream"] }
  uuid = { version = "1", features = ["v4", "serde"] }
  chrono = { version = "0.4", features = ["serde"] }
  tracing = "0.1"
  tracing-subscriber = { version = "0.3", features = ["env-filter"] }
  tokio-stream = "0.1"
  dotenvy = "0.15"
  thiserror = "1"
  ```
- [ ] Create all subdirectories under `backend/src/`
- [ ] Create placeholder `main.rs` with Axum hello-world
- [ ] Verify: `cargo build` succeeds

### Task 1.2 — Configuration System 🟢
Implement `config.rs` — loads from environment variables with fallback to `app_settings` table.

**Concrete steps:**
- [ ] Define `Config` struct with all env vars from spec §12:
  ```rust
  pub struct Config {
      pub database_url: String,
      pub auth_secret: String,
      pub public_base_url: String,
      pub gh_token: Option<String>,
      pub gh_repo: Option<String>,
      pub discord_bot_token: Option<String>,
      pub discord_channel_id: Option<String>,
      pub telegram_bot_token: Option<String>,
      pub telegram_channel_id: Option<String>,
      pub torrentio_base_url: Option<String>,
      pub dashboard_dir: PathBuf,
  }
  ```
- [ ] Load from `STREAMVAULT_*` env vars via `std::env::var`
- [ ] Implement `Config::from_env()` with validation (required fields must exist)
- [ ] Implement `Config::merge_settings(&self, pool: &SqlitePool)` — overlays DB settings on top of env vars (DB values take precedence for optional fields)
- [ ] Add `dotenvy::dotenv().ok()` in main for `.env` support

### Task 1.3 — Error Handling 🟢
Implement `error.rs` — unified error type for the application.

**Concrete steps:**
- [ ] Define `AppError` enum:
  ```rust
  #[derive(Debug, thiserror::Error)]
  pub enum AppError {
      #[error("Not found: {0}")]
      NotFound(String),
      #[error("Bad request: {0}")]
      BadRequest(String),
      #[error("Unauthorized")]
      Unauthorized,
      #[error("Database error: {0}")]
      Database(#[from] sqlx::Error),
      #[error("HTTP client error: {0}")]
      HttpClient(#[from] reqwest::Error),
      #[error("Internal error: {0}")]
      Internal(String),
  }
  ```
- [ ] Implement `IntoResponse` for `AppError` — returns JSON `{ "error": "message" }` with appropriate HTTP status codes
- [ ] Define `type AppResult<T> = Result<T, AppError>`

### Task 1.4 — Database Pool & Migrations 🔴
Implement `db/mod.rs` — SQLite connection pool and migration runner.

**Concrete steps:**
- [ ] Create `db/mod.rs` with:
  ```rust
  pub async fn create_pool(database_url: &str) -> Result<SqlitePool, AppError> {
      let pool = SqlitePoolOptions::new()
          .max_connections(5)
          .connect(database_url)
          .await?;
      run_migrations(&pool).await?;
      Ok(pool)
  }
  ```
- [ ] Create `db/migrations/0001_initial.sql` with full schema from spec §3:
  - `jobs` table (all 30 columns)
  - `job_events` table
  - `hls_chunks` table
  - `cinemeta_cache` table (composite PK on imdb_id + media_type)
  - `app_settings` table
  - All 5 indexes
  - Enable WAL mode: `PRAGMA journal_mode=WAL;`
  - Enable foreign keys: `PRAGMA foreign_keys=ON;`
- [ ] Implement migration runner: read SQL files from embedded migrations dir, execute in order
- [ ] Use `sqlx::query` to create `_migrations` tracking table to avoid re-running
- [ ] Verify: pool creation runs migrations, all tables exist

### Task 1.5 — Application State & Router 🟡
Implement `app.rs` — shared application state and Axum router assembly.

**Concrete steps:**
- [ ] Define `AppState`:
  ```rust
  pub struct AppState {
      pub db: SqlitePool,
      pub config: Arc<RwLock<Config>>,
      pub event_tx: broadcast::Sender<SseEvent>,
      pub http: reqwest::Client,
  }
  ```
- [ ] Create router skeleton in `app.rs`:
  ```rust
  pub fn create_router(state: Arc<AppState>) -> Router {
      Router::new()
          // API routes (auth required)
          .nest("/api/v1", api_routes())
          // GHA callbacks (server-auth)
          .nest("/api/v1/jobs", callback_routes())
          // Stremio addon (public)
          .merge(stremio_routes())
          // HLS proxy (public)
          .nest("/proxy", proxy_routes())
          // Dashboard static files
          .fallback_service(static_files())
          .with_state(state)
          .layer(TraceLayer::new_for_http())
          .layer(CorsLayer::permissive())
  }
  ```
- [ ] Define `SseEvent` struct for broadcast channel
- [ ] Create stub route modules (empty handlers returning 501)
- [ ] Wire up `main.rs`:
  ```rust
  #[tokio::main]
  async fn main() {
      tracing_subscriber::init();
      let config = Config::from_env()?;
      let pool = create_pool(&config.database_url).await?;
      let (event_tx, _) = broadcast::channel(1024);
      let state = Arc::new(AppState { db: pool, config, event_tx, http: Client::new() });
      let router = create_router(state.clone());
      // Spawn scheduler worker
      tokio::spawn(scheduler_loop(state.clone()));
      axum::serve(listener, router).await?;
  }
  ```

**Phase 1 Deliverable:** `cargo run` starts the server, creates SQLite DB with all tables, serves health check.

---

## Phase 2: Core Backend API

**Goal:** All REST API endpoints functional (search, queue CRUD, settings, library).

### Task 2.1 — Bearer Token Auth Middleware 🟢
Implement `api/auth.rs`.

**Concrete steps:**
- [ ] Create `auth_middleware` as Axum `middleware::from_fn`:
  - Extract `Authorization: Bearer <token>` header
  - Compare against `config.auth_secret`
  - Return 401 if missing/invalid
- [ ] Create `callback_auth_middleware`:
  - Extract `X-Callback-Token` header
  - Compare against `config.auth_secret`
  - Return 401 if invalid
- [ ] Apply auth middleware to `/api/v1` routes (except callbacks)
- [ ] Leave Stremio and proxy routes unauthenticated

### Task 2.2 — Settings API 🟢
Implement `api/settings.rs` — CRUD for `app_settings` table.

**Concrete steps:**
- [ ] `GET /api/v1/settings` — return all settings as JSON object
- [ ] `PUT /api/v1/settings` — bulk upsert settings from JSON body:
  ```rust
  // Input: { "gh_token": "...", "discord_bot_token": "...", ... }
  // For each key-value pair: INSERT OR REPLACE INTO app_settings
  ```
- [ ] After update, reload `Config` from DB and update `AppState.config`
- [ ] Mask sensitive values in GET response (show only last 4 chars of tokens)
- [ ] Define settings keys enum matching spec §12 table

### Task 2.3 — Cinemeta Client 🟡
Implement search dependency — fetch metadata from Cinemeta API.

**Concrete steps:**
- [ ] Create `api/search.rs` with Cinemeta fetch function:
  ```rust
  async fn fetch_cinemeta(http: &Client, imdb_id: &str, media_type: &str) -> AppResult<CinemetaResponse>
  ```
- [ ] Call `https://v3-cinemeta.strem.io/meta/{type}/{imdb_id}.json`
- [ ] Parse response into `CinemetaMeta` struct (title, poster, year, overview, episodes)
- [ ] Cache results in `cinemeta_cache` table (upsert on fetch)
- [ ] Implement cache-first lookup: check DB before HTTP call
- [ ] Add cache TTL check (re-fetch if `cached_at` > 24 hours old)

### Task 2.4 — Torrentio Search Proxy 🟡
Implement `api/search.rs` — search endpoint.

**Concrete steps:**
- [ ] `POST /api/v1/search` handler:
  1. Parse request body: `{ imdb_id, media_type, season?, episode? }`
  2. Validate IMDB ID format (regex: `^tt\d+$`)
  3. Fetch Cinemeta metadata (Task 2.3)
  4. Build Torrentio stream ID:
     - Movie: `{imdb_id}`
     - Series: `{imdb_id}:{season}:{episode}`
  5. Call Torrentio proxy: `{torrentio_base_url}/stream/{type}/{stream_id}.json`
  6. Parse response, extract torrent list (name, title, size, infohash, magnet, file_idx)
  7. Return combined response with `meta` + `torrents`
- [ ] Handle errors: invalid IMDB ID, Cinemeta not found, Torrentio unreachable
- [ ] Add request timeout (15s) for external calls

### Task 2.5 — Queue CRUD 🟡
Implement `api/queue.rs` — add, list, get, delete jobs.

**Concrete steps:**
- [ ] `POST /api/v1/queue` — create job:
  1. Generate UUID for job ID
  2. Validate all required fields
  3. Fetch poster/title from cinemeta_cache (should be cached from search)
  4. INSERT into `jobs` with status = "queued"
  5. INSERT `job_event` (status_change → queued)
  6. Broadcast SSE event (job_created)
  7. Send Telegram notification (job queued)
  8. Return `{ job_id, status }`
- [ ] `GET /api/v1/queue` — list all jobs:
  - Query jobs ordered by `created_at DESC`
  - Group by status: processing, queued, completed, failed
  - Return `{ processing: [...], queued: [...], completed: [...], failed: [...] }`
- [ ] `GET /api/v1/queue/:id` — job detail:
  - Fetch job + all job_events ordered by created_at
  - Return combined response
- [ ] `DELETE /api/v1/queue/:id` — cancel/remove job:
  - Only allow if status is "queued" or "failed" or "completed"
  - If processing, return 409 Conflict
  - DELETE job (cascades to events, chunks via FK)
  - Broadcast SSE event (job_removed)

### Task 2.6 — Library API 🟢
Implement `api/library.rs` — completed media listing.

**Concrete steps:**
- [ ] `GET /api/v1/library` — list completed jobs:
  - Query jobs WHERE status = 'completed' ORDER BY completed_at DESC
  - Return array with title, poster, imdb_id, media_type, season, episode, resolution, duration
- [ ] `DELETE /api/v1/library/:id` — remove completed media:
  - Delete job and associated HLS chunk records
  - Optionally send Discord message deletion requests (future enhancement)
  - Broadcast SSE event

### Task 2.7 — Database Query Layer 🟡
Create dedicated DB query functions used by all API handlers.

**Concrete steps:**
- [ ] Define Rust structs matching all 5 tables with `#[derive(sqlx::FromRow)]`
- [ ] Implement query functions:
  ```rust
  // jobs
  pub async fn insert_job(pool: &SqlitePool, job: &NewJob) -> AppResult<()>
  pub async fn get_job(pool: &SqlitePool, id: &str) -> AppResult<Job>
  pub async fn list_jobs(pool: &SqlitePool) -> AppResult<Vec<Job>>
  pub async fn list_jobs_by_status(pool: &SqlitePool, status: &str) -> AppResult<Vec<Job>>
  pub async fn update_job_status(pool: &SqlitePool, id: &str, status: &str) -> AppResult<()>
  pub async fn update_job_progress(pool: &SqlitePool, id: &str, phase: &str, pct: i32) -> AppResult<()>
  pub async fn update_job_checkpoint(pool: &SqlitePool, id: &str, checkpoint: &str) -> AppResult<()>
  pub async fn update_job_gh_run(pool: &SqlitePool, id: &str, run_id: &str) -> AppResult<()>
  pub async fn update_job_completed(pool: &SqlitePool, id: &str, resolution: &str, duration: f64) -> AppResult<()>
  pub async fn update_job_failed(pool: &SqlitePool, id: &str, error: &str) -> AppResult<()>
  pub async fn delete_job(pool: &SqlitePool, id: &str) -> AppResult<()>
  pub async fn get_next_queued_job(pool: &SqlitePool) -> AppResult<Option<Job>>

  // job_events
  pub async fn insert_job_event(pool: &SqlitePool, job_id: &str, phase: &str, event_type: &str, message: &str, progress: Option<i32>) -> AppResult<()>
  pub async fn get_job_events(pool: &SqlitePool, job_id: &str) -> AppResult<Vec<JobEvent>>

  // hls_chunks
  pub async fn insert_hls_chunk(pool: &SqlitePool, chunk: &NewHlsChunk) -> AppResult<()>
  pub async fn get_hls_chunks(pool: &SqlitePool, job_id: &str) -> AppResult<Vec<HlsChunk>>

  // cinemeta_cache
  pub async fn get_cached_meta(pool: &SqlitePool, imdb_id: &str, media_type: &str) -> AppResult<Option<CinemetaCache>>
  pub async fn upsert_cached_meta(pool: &SqlitePool, meta: &CinemetaCache) -> AppResult<()>

  // app_settings
  pub async fn get_all_settings(pool: &SqlitePool) -> AppResult<HashMap<String, String>>
  pub async fn upsert_setting(pool: &SqlitePool, key: &str, value: &str) -> AppResult<()>
  pub async fn get_setting(pool: &SqlitePool, key: &str) -> AppResult<Option<String>>
  ```
- [ ] All functions use parameterized queries (no SQL injection)
- [ ] Timestamps use `chrono::Utc::now().to_rfc3339()`

**Phase 2 Deliverable:** All REST API endpoints work via curl/httpie. Can search, queue jobs, view settings.

---

## Phase 3: GitHub Actions Pipeline

**Goal:** Working GHA workflow that can download, transcode, and upload to Discord.

### Task 3.1 — Pipeline Workflow File 🔴
Create `.github/workflows/streamvault-pipeline.yml`.

**Concrete steps:**
- [ ] Define `workflow_dispatch` trigger with all inputs from spec §5:
  ```yaml
  on:
    workflow_dispatch:
      inputs:
        job_id:
          description: 'StreamVault job ID'
          required: true
        magnet_uri:
          description: 'Magnet link'
          required: true
        file_idx:
          description: 'File index in torrent'
          required: true
          default: '0'
        callback_url:
          description: 'Backend callback base URL'
          required: true
        callback_token:
          description: 'Callback auth token'
          required: true
        skip_download:
          description: 'Skip download phase'
          required: false
          default: 'false'
        skip_transcode:
          description: 'Skip transcode phase'
          required: false
          default: 'false'
  ```
- [ ] Set job timeout: 360 minutes
- [ ] Set runner: `ubuntu-latest`
- [ ] Define environment variables for all inputs

### Task 3.2 — Download Phase 🔴
Implement download step in the workflow.

**Concrete steps:**
- [ ] Install `aria2c` (pre-installed on ubuntu-latest)
- [ ] Implement download step:
  ```yaml
  - name: Download torrent
    if: inputs.skip_download != 'true'
    run: |
      aria2c --seed-time=0 --select-file=${{ inputs.file_idx }} \
        --dir=./downloads --summary-interval=5 \
        "${{ inputs.magnet_uri }}" 2>&1 | tee download.log
      # Parse progress from aria2 output
      # Report progress every 5% via callback
  ```
- [ ] Create `backend/scripts/pipeline/callback.sh` helper:
  ```bash
  #!/bin/bash
  # callback.sh <job_id> <endpoint> <payload_json>
  curl -s -X POST \
    -H "Content-Type: application/json" \
    -H "X-Callback-Token: $CALLBACK_TOKEN" \
    -d "$3" \
    "$CALLBACK_URL/api/v1/jobs/$1/$2"
  ```
- [ ] Create `backend/scripts/pipeline/report-progress.sh`:
  - Parses aria2 output for percentage
  - Calls `/api/v1/jobs/{id}/progress` with `{ "phase": "download", "progress_pct": N }`
- [ ] Implement checkpoint save:
  ```yaml
  - name: Save download checkpoint
    if: inputs.skip_download != 'true'
    uses: actions/upload-artifact@v4
    with:
      name: checkpoint-dl-${{ inputs.job_id }}
      path: ./downloads/
      retention-days: 7
  ```
- [ ] Implement checkpoint restore (when skip_download=true):
  ```yaml
  - name: Restore download checkpoint
    if: inputs.skip_download == 'true'
    uses: actions/download-artifact@v4
    with:
      name: checkpoint-dl-${{ inputs.job_id }}
      path: ./downloads/
  ```
- [ ] Handle files > 2GB with `split`/`cat` chunking as described in spec §5

### Task 3.3 — Transcode Phase 🔴
Implement HLS transcoding step.

**Concrete steps:**
- [ ] Install ffmpeg (pre-installed on ubuntu-latest)
- [ ] Implement source detection:
  ```bash
  SOURCE_HEIGHT=$(ffprobe -v error -select_streams v:0 \
    -show_entries stream=height -of csv=p=n:0 ./downloads/*)
  if [ "$SOURCE_HEIGHT" -gt 1080 ]; then
    TARGET_HEIGHT=1080
  else
    TARGET_HEIGHT=$SOURCE_HEIGHT
  fi
  ```
- [ ] Implement transcode with FFmpeg (from spec §9):
  ```bash
  ffmpeg -i ./downloads/* \
    -c:v libx264 -preset fast -crf 23 \
    -vf "scale=-2:${TARGET_HEIGHT}" \
    -c:a aac -b:a 128k \
    -hls_time 6 -hls_list_size 0 \
    -hls_segment_filename "./hls/seg_%05d.ts" \
    -f hls ./hls/master.m3u8
  ```
- [ ] Implement progress reporting:
  - Get total duration via ffprobe before transcode
  - Parse ffmpeg stderr for `time=HH:MM:SS.ms`
  - Calculate percentage: `(current_time / total_duration) * 100`
  - Report every 5% via callback
- [ ] Save transcode checkpoint as GH Artifact:
  ```yaml
  - name: Save transcode checkpoint
    uses: actions/upload-artifact@v4
    with:
      name: checkpoint-tc-${{ inputs.job_id }}
      path: ./hls/
      retention-days: 7
  ```
- [ ] Implement checkpoint restore (when skip_transcode=true)

### Task 3.4 — Upload to Discord Phase 🔴
Implement Discord upload step.

**Concrete steps:**
- [ ] Create `backend/scripts/pipeline/upload-to-discord.sh`:
  ```bash
  #!/bin/bash
  # Upload each .ts chunk and .m3u8 to Discord channel
  # Uses Discord webhook/bot API for file uploads

  DISCORD_API="https://discord.com/api/v10"
  CHANNEL_ID="$1"
  BOT_TOKEN="$2"
  JOB_ID="$3"
  HLS_DIR="$4"

  TOTAL_FILES=$(ls "$HLS_DIR"/*.ts "$HLS_DIR"/*.m3u8 | wc -l)
  CURRENT=0

  for file in "$HLS_DIR"/*.ts "$HLS_DIR"/*.m3u8; do
    CURRENT=$((CURRENT + 1))

    # Upload file via Discord API (multipart form)
    RESPONSE=$(curl -s -X POST \
      -H "Authorization: Bot $BOT_TOKEN" \
      -F "file=@$file" \
      -F "content=${JOB_ID}:$(basename $file)" \
      "$DISCORD_API/channels/$CHANNEL_ID/messages")

    # Extract message_id and attachment URL from response
    MSG_ID=$(echo "$RESPONSE" | jq -r '.id')
    FILE_URL=$(echo "$RESPONSE" | jq -r '.attachments[0].url')

    # Report chunk upload to backend
    callback.sh "$JOB_ID" "progress" \
      "{\"phase\":\"upload\",\"progress_pct\":$((CURRENT * 100 / TOTAL_FILES)),\"chunk\":{\"filename\":\"$(basename $file)\",\"discord_url\":\"$FILE_URL\",\"discord_message_id\":\"$MSG_ID\"}}"

    # Rate limit: max 50 req/s, add small delay
    sleep 0.1
  done
  ```
- [ ] Implement retry with exponential backoff for failed uploads:
  - Max 5 retries per chunk
  - Initial delay 2s, multiplier 2x, max 32s
- [ ] Handle Discord rate limit headers (`X-RateLimit-Remaining`, `Retry-After`)
- [ ] Upload `.m3u8` playlist file last

### Task 3.5 — Completion & Failure Reporting 🟢
Final workflow steps.

**Concrete steps:**
- [ ] Add success step:
  ```yaml
  - name: Report completion
    if: success()
    run: |
      DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=n:0 ./downloads/*)
      RESOLUTION="${TARGET_HEIGHT}p"
      callback.sh "${{ inputs.job_id }}" "complete" \
        "{\"video_resolution\":\"$RESOLUTION\",\"duration_seconds\":$DURATION}"
  ```
- [ ] Add failure step:
  ```yaml
  - name: Report failure
    if: failure()
    run: |
      callback.sh "${{ inputs.job_id }}" "failed" \
        "{\"error_message\":\"Pipeline failed at step: ${{ job.status }}\"}"
  ```
- [ ] Add cleanup step (remove large artifacts if desired after completion)

**Phase 3 Deliverable:** Manually trigger the GHA workflow, it downloads a torrent, transcodes to HLS, uploads to Discord.

---

## Phase 4: Pipeline Integration

**Goal:** Backend can trigger GHA, receive callbacks, manage scheduler loop, and handle retries.

### Task 4.1 — GHA Workflow Trigger 🟡
Implement `pipeline/trigger.rs` — dispatch workflow via GitHub API.

**Concrete steps:**
- [ ] Implement `trigger_pipeline()`:
  ```rust
  pub async fn trigger_pipeline(
      state: &AppState,
      job: &Job,
      skip_download: bool,
      skip_transcode: bool,
  ) -> AppResult<String> {
      let gh_token = get_setting_or_env(state, "gh_token").await?;
      let gh_repo = get_setting_or_env(state, "gh_repo").await?;

      let url = format!(
          "https://api.github.com/repos/{}/actions/workflows/streamvault-pipeline.yml/dispatches",
          gh_repo
      );

      let body = serde_json::json!({
          "ref": "main",
          "inputs": {
              "job_id": job.id,
              "magnet_uri": job.magnet_uri,
              "file_idx": job.file_idx.to_string(),
              "callback_url": state.config.read().await.public_base_url,
              "callback_token": state.config.read().await.auth_secret,
              "skip_download": skip_download.to_string(),
              "skip_transcode": skip_transcode.to_string(),
          }
      });

      let resp = state.http.post(&url)
          .bearer_auth(&gh_token)
          .header("Accept", "application/vnd.github+json")
          .json(&body)
          .send().await?;

      // GitHub returns 204 No Content on success
      // Need to fetch run ID separately
      let run_id = fetch_latest_run_id(state, &gh_repo, &gh_token, &job.id).await?;
      update_job_gh_run(&state.db, &job.id, &run_id).await?;

      Ok(run_id)
  }
  ```
- [ ] Implement `fetch_latest_run_id()` — query GitHub API for workflow runs, match by job_id in run name or inputs
- [ ] Implement `get_setting_or_env()` — check app_settings first, fall back to env config

### Task 4.2 — GHA Callback Receivers 🟡
Implement `api/callbacks.rs` — receive progress/status updates from GHA.

**Concrete steps:**
- [ ] Apply `callback_auth_middleware` to callback routes
- [ ] `POST /api/v1/jobs/:id/progress`:
  ```rust
  // Body: { "phase": "download"|"transcode"|"upload", "progress_pct": 67, "chunk": {...}? }
  // 1. Validate job exists and is in processing state
  // 2. Update job progress fields (progress_pct, transcode_pct, or upload_pct based on phase)
  // 3. Update current_phase
  // 4. Insert job_event
  // 5. If chunk data present → insert hls_chunk record
  // 6. Broadcast SSE event
  ```
- [ ] `POST /api/v1/jobs/:id/checkpoint`:
  ```rust
  // Body: { "checkpoint": "download"|"transcode", "artifact_id": "..." }
  // 1. Update job.last_checkpoint
  // 2. Update artifact ID field (gh_artifact_id_dl or gh_artifact_id_tc)
  // 3. Update status to checkpoint_download or checkpoint_transcode
  // 4. Insert job_event
  // 5. Broadcast SSE event
  // 6. Send Telegram notification
  ```
- [ ] `POST /api/v1/jobs/:id/complete`:
  ```rust
  // Body: { "video_resolution": "1080p", "duration_seconds": 2820.5 }
  // 1. Update status to "completed"
  // 2. Set completed_at timestamp
  // 3. Set video_resolution and duration_seconds
  // 4. Insert job_event
  // 5. Broadcast SSE event
  // 6. Send Telegram completion notification (with full summary)
  ```
- [ ] `POST /api/v1/jobs/:id/failed`:
  ```rust
  // Body: { "error_message": "..." }
  // 1. Update status to "failed"
  // 2. Set error_message
  // 3. Insert job_event
  // 4. Broadcast SSE event
  // 5. Send Telegram failure notification
  ```

### Task 4.3 — Queue Scheduler 🔴
Implement `worker/scheduler.rs` — background loop that processes the queue.

**Concrete steps:**
- [ ] Implement scheduler loop:
  ```rust
  pub async fn scheduler_loop(state: Arc<AppState>) {
      let mut interval = tokio::time::interval(Duration::from_secs(30));
      loop {
          interval.tick().await;
          if let Err(e) = scheduler_tick(state.clone()).await {
              tracing::error!("Scheduler tick failed: {}", e);
          }
      }
  }
  ```
- [ ] Implement `scheduler_tick()`:
  ```rust
  async fn scheduler_tick(state: Arc<AppState>) -> AppResult<()> {
      // 1. Check if any job is currently in processing states
      let active_jobs = list_jobs_by_statuses(&state.db, &[
          "processing", "downloading", "checkpoint_download",
          "transcoding", "checkpoint_transcode", "uploading"
      ]).await?;

      if !active_jobs.is_empty() {
          // Active job exists — monitor it
          for job in &active_jobs {
              monitor_gh_run(state.clone(), job).await?;
          }
          return Ok(());
      }

      // 2. No active job — pick next from queue
      if let Some(job) = get_next_queued_job(&state.db).await? {
          // Update status to processing
          update_job_status(&state.db, &job.id, "processing").await?;
          insert_job_event(&state.db, &job.id, "download", "status_change",
              "Pipeline started", None).await?;
          broadcast_event(&state, SseEvent::JobStarted { job_id: job.id.clone() });

          // Send Telegram notification
          send_telegram_notification(state.clone(), TelegramEvent::JobStarted(&job)).await;

          // Trigger GHA
          trigger_pipeline(&state, &job, false, false).await?;
      }

      Ok(())
  }
  ```

### Task 4.4 — GHA Run Monitor 🟡
Implement `worker/monitor.rs` — check GitHub Actions run status.

**Concrete steps:**
- [ ] Implement `monitor_gh_run()`:
  ```rust
  async fn monitor_gh_run(state: Arc<AppState>, job: &Job) -> AppResult<()> {
      let run_id = match &job.gh_run_id {
          Some(id) => id,
          None => return Ok(()),
      };

      let gh_token = get_setting_or_env(state, "gh_token").await?;
      let gh_repo = get_setting_or_env(state, "gh_repo").await?;

      let url = format!(
          "https://api.github.com/repos/{}/actions/runs/{}",
          gh_repo, run_id
      );

      let run: GhRunResponse = state.http.get(&url)
          .bearer_auth(&gh_token)
          .send().await?.json().await?;

      match run.status.as_str() {
          "completed" if run.conclusion.as_deref() == Some("success") => {
              // GHA completed successfully but callback might have been missed
              // Only update if job isn't already completed
              if job.status != "completed" {
                  tracing::warn!("GHA completed but job not marked complete — callback may have been missed");
              }
          }
          "completed" => {
              // GHA failed
              if job.status != "failed" && job.status != "completed" {
                  update_job_failed(&state.db, &job.id, "GitHub Actions run failed").await?;
                  broadcast_event(&state, SseEvent::JobFailed { job_id: job.id.clone() });
                  send_telegram_notification(state, TelegramEvent::JobFailed(&job)).await;
              }
          }
          _ => {
              // Still running — nothing to do
          }
      }

      Ok(())
  }
  ```

### Task 4.5 — Retry Logic 🟡
Implement retry endpoint and checkpoint-aware re-trigger.

**Concrete steps:**
- [ ] `POST /api/v1/queue/:id/retry` handler:
  ```rust
  pub async fn retry_job_handler(
      State(state): State<Arc<AppState>>,
      Path(id): Path<String>,
  ) -> AppResult<Json<RetryResponse>> {
      let job = get_job(&state.db, &id).await?;

      if job.status != "failed" {
          return Err(AppError::BadRequest("Can only retry failed jobs".into()));
      }

      // Determine which phases to skip based on last checkpoint
      let (skip_download, skip_transcode) = match job.last_checkpoint.as_deref() {
          Some("transcode") => (true, true),
          Some("download") => (true, false),
          _ => (false, false),
      };

      // Check if GH artifacts are still available (7-day retention)
      if skip_download && !check_artifact_exists(&state, &job).await? {
          // Artifact expired, must do full restart
          (skip_download, skip_transcode) = (false, false);
      }

      // Reset job state
      update_job_status(&state.db, &id, "queued").await?;
      update_job_progress(&state.db, &id, "download", 0).await?;
      insert_job_event(&state.db, &id, "download", "status_change",
          &format!("Retry queued (skip_download={}, skip_transcode={})", skip_download, skip_transcode),
          None).await?;

      broadcast_event(&state, SseEvent::JobRetried { job_id: id.clone() });

      Ok(Json(RetryResponse { job_id: id, status: "queued".into() }))
  }
  ```
- [ ] Implement `check_artifact_exists()` — HEAD request to GitHub API for artifact

### Task 4.6 — Stale Job Recovery 🟡
Implement startup recovery for interrupted jobs.

**Concrete steps:**
- [ ] In `main.rs`, after pool creation, call `recover_stale_jobs()`:
  ```rust
  async fn recover_stale_jobs(state: &AppState) -> AppResult<()> {
      let processing_statuses = &[
          "processing", "downloading", "checkpoint_download",
          "transcoding", "checkpoint_transcode", "uploading"
      ];
      let stale_jobs = list_jobs_by_statuses(&state.db, processing_statuses).await?;

      for job in stale_jobs {
          if let Some(run_id) = &job.gh_run_id {
              // Check GHA run status
              match check_gh_run_status(state, run_id).await? {
                  GhRunStatus::Success => {
                      // Callback was missed, mark completed
                      tracing::info!("Recovering job {} — GHA succeeded", job.id);
                  }
                  GhRunStatus::Failed => {
                      update_job_failed(&state.db, &job.id, "Server restarted — GHA run was lost").await?;
                  }
                  GhRunStatus::Running => {
                      tracing::info!("Job {} GHA still running after restart", job.id);
                  }
                  GhRunStatus::NotFound => {
                      update_job_failed(&state.db, &job.id, "GHA run not found after restart").await?;
                  }
              }
          } else {
              // No GHA run ID — server crashed before trigger
              update_job_status(&state.db, &job.id, "queued").await?;
          }
      }

      Ok(())
  }
  ```

**Phase 4 Deliverable:** Full pipeline loop works: queue a job → GHA triggers → progress callbacks → completion. Retry from checkpoint works.

---

## Phase 5: Stremio Addon + HLS Proxy

**Goal:** Fully functional Stremio addon that serves the user's library and streams via HLS proxy.

### Task 5.1 — Stremio Models 🟢
Implement `stremio/models.rs` — type definitions for Stremio protocol.

**Concrete steps:**
- [ ] Define all Stremio response types:
  ```rust
  #[derive(Serialize)]
  pub struct Manifest {
      pub id: String,
      pub version: String,
      pub name: String,
      pub description: String,
      pub resources: Vec<String>,
      pub types: Vec<String>,
      pub catalogs: Vec<CatalogDescriptor>,
      pub id_prefixes: Vec<String>,
      #[serde(rename = "behaviorHints")]
      pub behavior_hints: BehaviorHints,
  }

  #[derive(Serialize)]
  pub struct CatalogDescriptor {
      #[serde(rename = "type")]
      pub type_: String,
      pub id: String,
      pub name: String,
  }

  #[derive(Serialize)]
  pub struct MetaResponse {
      pub metas: Vec<MetaPreview>,
  }

  #[derive(Serialize)]
  pub struct MetaPreview {
      pub id: String,
      #[serde(rename = "type")]
      pub type_: String,
      pub name: String,
      pub poster: Option<String>,
  }

  #[derive(Serialize)]
  pub struct StreamResponse {
      pub streams: Vec<Stream>,
  }

  #[derive(Serialize)]
  pub struct Stream {
      pub name: String,
      pub url: String,
      pub description: Option<String>,
  }
  ```

### Task 5.2 — Stremio Addon Routes 🟡
Implement `stremio/routes.rs` — manifest, catalog, meta, stream endpoints.

**Concrete steps:**
- [ ] `GET /manifest.json`:
  - Return static manifest (with configurable addon ID and name from settings)
  - Add CORS headers (Stremio requires them)
- [ ] `GET /catalog/:type/streamvault.json`:
  - Query `cinemeta_cache` for completed jobs of the given type
  - Return `MetaResponse` with unique titles (deduplicate by imdb_id)
- [ ] `GET /catalog/:type/streamvault-movies.json` and `streamvault-series.json`:
  - Same logic, filtered by media_type
- [ ] `GET /meta/:type/:imdb_id.json`:
  - Return metadata from cinemeta_cache for the given IMDB ID
  - Include poster, title, year
- [ ] `GET /stream/:type/:id.json`:
  - Parse stream ID:
    - Movie: `tt1234567` → lookup completed job with matching imdb_id
    - Series: `tt1234567:1:3` → parse imdb_id, season=1, episode=3
  - Query `jobs` WHERE status='completed' AND imdb_id=? [AND season=? AND episode=?]
  - If found, return stream with HLS proxy URL:
    ```json
    {
      "streams": [{
        "name": "StreamVault\n1080p H.264",
        "url": "https://server.com/proxy/hls/{job_id}/master.m3u8",
        "description": "S01E03 • 1080p • H.264 / AAC"
      }]
    }
    ```
  - If not found, return `{ "streams": [] }`
- [ ] All Stremio routes are public (no auth)

### Task 5.3 — HLS Proxy 🟡
Implement `stremio/proxy.rs` — proxy HLS chunks from Discord CDN.

**Concrete steps:**
- [ ] `GET /proxy/hls/:job_id/master.m3u8`:
  1. Lookup job — must be completed
  2. Query `hls_chunks` for this job
  3. Generate master playlist content:
     ```
     #EXTM3U
     #EXT-X-VERSION:3
     #EXT-X-TARGETDURATION:6
     #EXT-X-MEDIA-SEQUENCE:0
     #EXTINF:6.000,
     /proxy/hls/{job_id}/seg_00000.ts
     #EXTINF:6.000,
     /proxy/hls/{job_id}/seg_00001.ts
     ...
     #EXT-X-ENDLIST
     ```
  4. Rewrite chunk URLs to point to our proxy (not Discord CDN directly)
  5. Return with `Content-Type: application/vnd.apple.mpegurl`
- [ ] `GET /proxy/hls/:job_id/:filename`:
  1. Lookup chunk in `hls_chunks` by job_id + filename
  2. Fetch chunk from Discord CDN URL via `reqwest`
  3. Stream response body to client (don't buffer entire chunk)
  4. Set appropriate Content-Type:
     - `.ts` → `video/mp2t`
     - `.m3u8` → `application/vnd.apple.mpegurl`
  5. Set `Cache-Control: public, max-age=31536000` (chunks are immutable)
- [ ] Handle Discord CDN errors (404, rate limit) gracefully
- [ ] Add `Access-Control-Allow-Origin: *` headers for Stremio compatibility

**Phase 5 Deliverable:** Can install addon in Stremio, see library catalog, and stream completed media.

---

## Phase 6: Real-time & Notifications

**Goal:** SSE broadcast for dashboard, Telegram notifications for mobile alerts.

### Task 6.1 — SSE Event System 🟡
Implement `api/events.rs` — Server-Sent Events broadcast.

**Concrete steps:**
- [ ] Define `SseEvent` enum:
  ```rust
  #[derive(Clone, Serialize)]
  #[serde(tag = "type", content = "data")]
  pub enum SseEvent {
      JobCreated { job_id: String, title: String },
      JobStarted { job_id: String },
      JobProgress { job_id: String, phase: String, progress_pct: i32 },
      JobCheckpoint { job_id: String, checkpoint: String },
      JobCompleted { job_id: String },
      JobFailed { job_id: String, error: String },
      JobRetried { job_id: String },
      JobRemoved { job_id: String },
      QueueUpdate { processing: usize, queued: usize },
  }
  ```
- [ ] Implement `GET /api/v1/events` handler:
  ```rust
  pub async fn sse_handler(
      State(state): State<Arc<AppState>>,
  ) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
      let rx = state.event_tx.subscribe();
      let stream = BroadcastStream::new(rx)
          .filter_map(|result| async move {
              match result {
                  Ok(event) => {
                      let data = serde_json::to_string(&event).ok()?;
                      let event_name = event_type_name(&event);
                      Some(Ok(Event::default()
                          .event(event_name)
                          .data(data)))
                  }
                  Err(_) => None, // Skip lagged messages
              }
          });
      Sse::new(stream)
          .keep_alive(KeepAlive::default())
  }
  ```
- [ ] Implement `broadcast_event()` helper used throughout the codebase
- [ ] Ensure SSE requires auth (bearer token)

### Task 6.2 — Telegram Notifications 🟡
Implement `notifications/telegram.rs`.

**Concrete steps:**
- [ ] Define notification events:
  ```rust
  pub enum TelegramEvent<'a> {
      JobQueued(&'a Job),
      JobStarted(&'a Job),
      CheckpointSaved(&'a Job, &'a str),
      JobCompleted(&'a Job, PipelineTiming),
      JobFailed(&'a Job),
  }
  ```
- [ ] Implement message formatting (matching spec §8):
  - JobQueued: `"🎬 Added to queue: {title}"`
  - JobStarted: `"⚙️ Processing started: {title}"`
  - CheckpointSaved: `"💾 Checkpoint saved: {phase}"`
  - JobCompleted: Full summary card with resolution, duration, pipeline timing breakdown
  - JobFailed: `"❌ Failed: {title} at {phase} — {error}"`
- [ ] Implement `send_telegram_notification()`:
  ```rust
  pub async fn send_telegram_notification(state: Arc<AppState>, event: TelegramEvent<'_>) {
      // Check if notifications enabled
      let enabled = get_setting(&state.db, "notifications_enabled").await
          .map(|v| v.as_deref() == Some("true"))
          .unwrap_or(false);
      if !enabled { return; }

      let bot_token = match get_setting_or_env(&state, "telegram_bot_token").await {
          Ok(t) => t,
          Err(_) => return,
      };
      let channel_id = match get_setting_or_env(&state, "telegram_channel_id").await {
          Ok(c) => c,
          Err(_) => return,
      };

      let message = format_telegram_message(&event);

      let url = format!("https://api.telegram.org/bot{}/sendMessage", bot_token);
      let _ = state.http.post(&url)
          .json(&serde_json::json!({
              "chat_id": channel_id,
              "text": message,
              "parse_mode": "HTML"
          }))
          .send().await;
  }
  ```
- [ ] Implement pipeline timing calculation for completion message:
  - Total time: `completed_at - started_at`
  - Download time: from job_events timestamps
  - Transcode time: from job_events timestamps
  - Upload time: from job_events timestamps
- [ ] Fire-and-forget pattern (spawn tokio task, don't block caller)

**Phase 6 Deliverable:** Dashboard receives real-time SSE updates. Telegram receives formatted notifications for all job lifecycle events.

---

## Phase 7: Frontend Dashboard

**Goal:** Complete Svelte 5 dashboard with all 4 pages and glassmorphism UI.

### Task 7.1 — Svelte 5 Project Setup 🟢
Scaffold the frontend application.

**Concrete steps:**
- [ ] `npm create vite@latest dashboard -- --template svelte-ts`
- [ ] Install dependencies:
  ```bash
  npm install svelte-routing    # or svelte-spa-router
  npm install -D tailwindcss @sveltejs/vite-plugin-svelte
  ```
- [ ] Configure `vite.config.ts`:
  ```typescript
  export default defineConfig({
    plugins: [svelte()],
    server: {
      proxy: { '/api': 'http://localhost:8080', '/proxy': 'http://localhost:8080' }
    },
    build: { outDir: 'dist' }
  });
  ```
- [ ] Set up Tailwind CSS with custom glassmorphism theme
- [ ] Create `src/app.css` with glassmorphism base styles:
  ```css
  :root {
    --glass-bg: rgba(255, 255, 255, 0.05);
    --glass-border: rgba(255, 255, 255, 0.1);
    --glass-blur: 12px;
  }
  .glass {
    background: var(--glass-bg);
    backdrop-filter: blur(var(--glass-blur));
    border: 1px solid var(--glass-border);
    border-radius: 16px;
  }
  ```
- [ ] Create `src/App.svelte` with router layout (nav + outlet)

### Task 7.2 — TypeScript Types & API Client 🟢
Implement `src/lib/types.ts` and `src/lib/api.ts`.

**Concrete steps:**
- [ ] Define all TypeScript interfaces matching backend responses:
  ```typescript
  interface Job {
    id: string;
    imdb_id: string;
    media_type: 'movie' | 'series';
    season?: number;
    episode?: number;
    title: string;
    poster_url?: string;
    magnet_uri: string;
    status: JobStatus;
    current_phase?: string;
    progress_pct: number;
    transcode_pct: number;
    upload_pct: number;
    last_checkpoint?: string;
    video_resolution?: string;
    duration_seconds?: number;
    error_message?: string;
    created_at: string;
    started_at?: string;
    completed_at?: string;
  }

  type JobStatus = 'queued' | 'processing' | 'downloading' | 'checkpoint_download' |
    'transcoding' | 'checkpoint_transcode' | 'uploading' | 'completed' | 'failed';

  interface SearchResult {
    meta: { title: string; poster: string; year: number };
    torrents: Torrent[];
  }

  interface Torrent {
    name: string;
    title: string;
    size_bytes: number;
    infohash: string;
    magnet_uri: string;
    file_idx: number;
  }

  interface AppSettings { [key: string]: string; }
  ```
- [ ] Implement API client (`src/lib/api.ts`):
  ```typescript
  const BASE = '/api/v1';
  const headers = () => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${getToken()}`
  });

  export const api = {
    search: (body: SearchRequest) => fetch(`${BASE}/search`, { method: 'POST', headers: headers(), body: JSON.stringify(body) }).then(r => r.json()),
    getQueue: () => fetch(`${BASE}/queue`, { headers: headers() }).then(r => r.json()),
    getJob: (id: string) => fetch(`${BASE}/queue/${id}`, { headers: headers() }).then(r => r.json()),
    addToQueue: (body: QueueRequest) => fetch(`${BASE}/queue`, { method: 'POST', headers: headers(), body: JSON.stringify(body) }).then(r => r.json()),
    retryJob: (id: string) => fetch(`${BASE}/queue/${id}/retry`, { method: 'POST', headers: headers() }).then(r => r.json()),
    deleteJob: (id: string) => fetch(`${BASE}/queue/${id}`, { method: 'DELETE', headers: headers() }),
    getLibrary: () => fetch(`${BASE}/library`, { headers: headers() }).then(r => r.json()),
    getSettings: () => fetch(`${BASE}/settings`, { headers: headers() }).then(r => r.json()),
    updateSettings: (s: AppSettings) => fetch(`${BASE}/settings`, { method: 'PUT', headers: headers(), body: JSON.stringify(s) }).then(r => r.json()),
  };
  ```
- [ ] Implement token storage (localStorage with login prompt)

### Task 7.3 — SSE Client 🟡
Implement `src/lib/events.ts` — real-time event handling.

**Concrete steps:**
- [ ] Create SSE connection manager:
  ```typescript
  import { writable } from 'svelte/store';

  export const sseEvents = writable<SseEvent[]>([]);
  export const connectionStatus = writable<'connected' | 'disconnected' | 'connecting'>('disconnected');

  let eventSource: EventSource | null = null;

  export function connectSSE(token: string) {
    connectionStatus.set('connecting');
    eventSource = new EventSource(`/api/v1/events?token=${token}`);

    eventSource.onopen = () => connectionStatus.set('connected');
    eventSource.onerror = () => {
      connectionStatus.set('disconnected');
      // Auto-reconnect after 3s
      setTimeout(() => connectSSE(token), 3000);
    };

    ['job_created', 'job_started', 'job_progress', 'job_checkpoint',
     'job_completed', 'job_failed', 'job_retried', 'job_removed', 'queue_update'
    ].forEach(eventType => {
      eventSource!.addEventListener(eventType, (e: MessageEvent) => {
        const event = JSON.parse(e.data);
        sseEvents.update(events => [...events.slice(-99), event]);
        // Trigger store updates for queue refresh
      });
    });
  }

  export function disconnectSSE() {
    eventSource?.close();
    connectionStatus.set('disconnected');
  }
  ```
- [ ] Create Svelte stores that react to SSE events (auto-refresh queue data)

### Task 7.4 — Search Page 🟡
Implement the search/home page.

**Concrete steps:**
- [ ] Create `src/pages/SearchPage.svelte`:
  - IMDB ID input field with validation (regex `^tt\d+$`)
  - Media type toggle (Movie / Series)
  - Season + Episode number inputs (shown when Series selected)
  - "Search" button
  - Loading state with spinner
- [ ] Metadata preview card (glassmorphism):
  - Poster image
  - Title + Year
  - Synopsis (truncated)
- [ ] Torrent results list:
  - Each torrent as a glass card showing:
    - Source name (RARBG, YTS, etc.)
    - Torrent title
    - File size (human-readable)
    - "Add to Queue" button
  - Sort by size or quality
- [ ] Handle empty results, errors, loading states
- [ ] On "Add to Queue" → call API → show success toast → optionally redirect to queue

### Task 7.5 — Queue Page 🔴
Implement the queue management page.

**Concrete steps:**
- [ ] Create `src/pages/QueuePage.svelte` with 3 sections:
- [ ] **Processing section:**
  - Show active job with 3-phase progress indicator:
    ```
    ┌──────────┐  ┌──────────┐  ┌──────────┐
    │ Download │→ │Transcode │→ │Upload    │
    │ ████░░ 67%│  │  ░░░░░░  │  │  ░░░░░░  │
    └──────────┘  └──────────┘  └──────────┘
    ```
  - Phase progress bars update in real-time via SSE
  - Show torrent name, title, poster thumbnail
  - Animated transitions between phases
- [ ] **Queued section:**
  - FIFO list of waiting jobs
  - Show position in queue, title, poster thumbnail
  - "Cancel" button per item
  - Drag to reorder (optional enhancement)
- [ ] **Recent section (completed + failed):**
  - Last 20 completed/failed jobs
  - Completed: show resolution, duration, "Watch in Stremio" link
  - Failed: show error message, "Retry" button
- [ ] All sections update in real-time via SSE stores
- [ ] Empty states for each section

### Task 7.6 — Job Detail Page 🟡
Implement the detailed job view.

**Concrete steps:**
- [ ] Create `src/pages/JobDetailPage.svelte`:
  - Route: `/job/:id`
- [ ] Job header: poster, title, IMDB ID, status badge
- [ ] 3-phase progress visualization (same as queue but larger)
- [ ] Full event timeline:
  - Vertical timeline with timestamps
  - Color-coded by event type (status_change, progress, error, checkpoint)
  - Expandable for long messages
- [ ] Checkpoint status indicators (✅ saved / ❌ not saved)
- [ ] Error details panel (if failed):
  - Error message
  - Last successful checkpoint
  - "Retry" button with checkpoint info ("Will resume from: transcode checkpoint")
- [ ] "Cancel" / "Remove" button depending on status
- [ ] Auto-refresh via SSE

### Task 7.7 — Settings Page 🟢
Implement the settings/configuration page.

**Concrete steps:**
- [ ] Create `src/pages/SettingsPage.svelte`:
- [ ] Grouped settings sections:
  - **GitHub:** PAT token (masked input), Repository (owner/name)
  - **Discord:** Bot token (masked), Channel ID
  - **Telegram:** Bot token (masked), Channel ID, Enable/disable toggle
  - **Torrentio:** Proxy base URL
  - **Stremio:** Public base URL, Addon ID, Addon name
- [ ] Each setting as a labeled input with save indicator
- [ ] "Save All" button at bottom
- [ ] Validation: required fields, URL format validation
- [ ] Connection test buttons (optional enhancement):
  - "Test GitHub" — verify token + repo access
  - "Test Discord" — send test message
  - "Test Telegram" — send test message
- [ ] Show Stremio addon install URL: `{public_base_url}/manifest.json`

### Task 7.8 — Auth Gate & Navigation 🟢
Implement login and app shell.

**Concrete steps:**
- [ ] Create `src/lib/auth.ts`:
  - Login page with token input
  - Store token in localStorage
  - Validate token on app load (test API call)
  - Logout clears token
- [ ] Create `src/App.svelte` layout:
  - Top nav bar (glassmorphism):
    - Logo/title
    - Nav links: Search, Queue, Settings
    - Connection status indicator (SSE)
    - Logout button
  - Router outlet
  - Toast notification container
- [ ] Create toast notification system:
  - Auto-dismiss after 5s
  - Types: success, error, info
  - Triggered by SSE events and API actions
- [ ] Responsive design (mobile-friendly)

**Phase 7 Deliverable:** Full dashboard with all 4 pages, real-time updates, glassmorphism UI.

---

## Phase 8: Docker & CI/CD

**Goal:** Single Docker image, docker-compose for deployment, GitHub Actions for CI.

### Task 8.1 — Dockerfile 🔴
Create multi-stage Docker build.

**Concrete steps:**
- [ ] Create `docker/Dockerfile`:
  ```dockerfile
  # Stage 1: Build frontend
  FROM node:20-alpine AS frontend
  WORKDIR /app/dashboard
  COPY dashboard/package*.json ./
  RUN npm ci
  COPY dashboard/ ./
  RUN npm run build

  # Stage 2: Build backend
  FROM rust:1.79-slim AS backend
  RUN apt-get update && apt-get install -y pkg-config libssl-dev
  WORKDIR /app
  COPY backend/Cargo.toml backend/Cargo.lock ./
  RUN mkdir src && echo "fn main() {}" > src/main.rs
  RUN cargo build --release  # Build deps only (cache layer)
  COPY backend/src ./src
  RUN touch src/main.rs && cargo build --release

  # Stage 3: Runtime
  FROM debian:bookworm-slim
  RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
  WORKDIR /app
  COPY --from=backend /app/target/release/streamvault .
  COPY --from=frontend /app/dashboard/dist ./dashboard
  COPY backend/scripts ./scripts
  COPY docker/entrypoint.sh .
  RUN chmod +x entrypoint.sh

  ENV STREAMVAULT_DASHBOARD_DIR=/app/dashboard
  EXPOSE 8080
  ENTRYPOINT ["./entrypoint.sh"]
  ```
- [ ] Create `docker/entrypoint.sh`:
  ```bash
  #!/bin/sh
  set -e

  # Create data directory if needed
  mkdir -p /data

  # Set defaults
  export STREAMVAULT_DATABASE_URL="${STREAMVAULT_DATABASE_URL:-sqlite:/data/streamvault.db}"
  export STREAMVAULT_DASHBOARD_DIR="${STREAMVAULT_DASHBOARD_DIR:-/app/dashboard}"

  echo "Starting StreamVault..."
  exec ./streamvault
  ```

### Task 8.2 — Docker Compose 🟢
Create deployment configuration.

**Concrete steps:**
- [ ] Create `docker-compose.yml` matching spec §12:
  ```yaml
  services:
    streamvault:
      image: ghcr.io/${GITHUB_REPOSITORY:-yourname/streamvault}:latest
      build:
        context: .
        dockerfile: docker/Dockerfile
      ports:
        - "8080:8080"
      volumes:
        - streamvault-data:/data
      environment:
        - STREAMVAULT_DATABASE_URL=sqlite:/data/streamvault.db
        - STREAMVAULT_AUTH_SECRET=${STREAMVAULT_AUTH_SECRET:?Set STREAMVAULT_AUTH_SECRET}
        - STREAMVAULT_PUBLIC_BASE_URL=${STREAMVAULT_PUBLIC_BASE_URL:?Set STREAMVAULT_PUBLIC_BASE_URL}
        - RUST_LOG=${RUST_LOG:-info}
      restart: unless-stopped

  volumes:
    streamvault-data:
  ```
- [ ] Create `.env.example` with all environment variables documented
- [ ] Create `docker-compose.dev.yml` for local development (with bind mounts for hot reload)

### Task 8.3 — CI/CD Build Workflow 🟡
Create GitHub Actions workflow for Docker image builds.

**Concrete steps:**
- [ ] Create `.github/workflows/docker-build.yml`:
  ```yaml
  name: Build & Push Docker Image

  on:
    push:
      branches: [main]
      paths:
        - 'backend/**'
        - 'dashboard/**'
        - 'docker/**'
        - '.github/workflows/docker-build.yml'
    release:
      types: [published]

  permissions:
    contents: read
    packages: write

  jobs:
    build:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4

        - uses: docker/setup-buildx-action@v3

        - uses: docker/login-action@v3
          with:
            registry: ghcr.io
            username: ${{ github.actor }}
            password: ${{ secrets.GITHUB_TOKEN }}

        - uses: docker/metadata-action@v5
          id: meta
          with:
            images: ghcr.io/${{ github.repository }}
            tags: |
              type=sha,prefix=
              type=ref,event=branch
              type=semver,pattern={{version}}
              type=raw,value=latest,enable={{is_default_branch}}

        - uses: docker/build-push-action@v5
          with:
            context: .
            file: docker/Dockerfile
            push: true
            tags: ${{ steps.meta.outputs.tags }}
            labels: ${{ steps.meta.outputs.labels }}
            cache-from: type=gha
            cache-to: type=gha,mode=max
  ```
- [ ] Add path filtering to avoid rebuilding on doc changes

### Task 8.4 — Local Development Setup 🟢
Create development workflow documentation and scripts.

**Concrete steps:**
- [ ] Create `Makefile` or `justfile` with common commands:
  ```makefile
  dev-backend:
      cd backend && cargo watch -x run

  dev-frontend:
      cd dashboard && npm run dev

  build:
      docker build -f docker/Dockerfile -t streamvault:dev .

  run:
      docker compose up -d

  logs:
      docker compose logs -f streamvault
  ```
- [ ] Create `backend/.env.example` for local backend development
- [ ] Document development workflow in `README.md`:
  1. Start backend: `cargo watch -x run` (hot reload)
  2. Start frontend: `npm run dev` (Vite proxy to backend)
  3. Or use `docker compose up` for full stack

**Phase 8 Deliverable:** `docker compose up` starts the complete application. CI builds and pushes images on push to main.

---

## Phase 9: Hardening & Polish

**Goal:** Production readiness — edge cases, performance, security, documentation.

### Task 9.1 — Input Validation & Security 🟡
**Concrete steps:**
- [ ] Validate all API inputs server-side:
  - IMDB ID format: `^tt\d{7,8}$`
  - Media type: enum `movie` | `series`
  - Season/episode: positive integers
  - File size: reasonable bounds (> 0, < 100GB)
  - UUID format for job IDs
- [ ] Sanitize all user-facing output (prevent XSS in dashboard)
- [ ] Rate limit API endpoints (optional: tower-governor)
- [ ] Validate callback payloads (ensure job_id matches, status transitions are valid)
- [ ] Ensure auth tokens are never logged
- [ ] Add security headers (X-Frame-Options, X-Content-Type-Options)

### Task 9.2 — Error Recovery Edge Cases 🟡
**Concrete steps:**
- [ ] Handle Discord upload failures:
  - Retry individual chunks with exponential backoff
  - Report partial progress correctly
  - Allow retry from "checkpoint_transcode" to re-upload all chunks
- [ ] Handle GHA timeout (6-hour limit):
  - If job is still "processing" after 6 hours, mark as failed
  - Allow retry from last checkpoint
- [ ] Handle concurrent retry attempts (only one retry per job at a time):
  - Add optimistic locking or status check before retry
- [ ] Handle database connection loss:
  - SQLx pool auto-reconnect
  - Graceful error responses during DB issues
- [ ] Handle GitHub API rate limits:
  - Respect `X-RateLimit-Remaining` headers
  - Queue trigger attempts if rate limited

### Task 9.3 — Performance Optimization 🟡
**Concrete steps:**
- [ ] HLS proxy optimization:
  - Add response caching for `.m3u8` playlists (they don't change)
  - Use streaming responses for `.ts` chunks (don't buffer)
  - Add `Connection: keep-alive` for chunk transfers
- [ ] Database query optimization:
  - Ensure all queries use indexes
  - Add EXPLAIN analysis for slow queries
  - Consider connection pool sizing for concurrent requests
- [ ] Frontend optimization:
  - Lazy-load routes (code splitting)
  - Virtual scrolling for long queue/library lists
  - Debounce search input
  - Image lazy loading for posters

### Task 9.4 — Logging & Observability 🟢
**Concrete steps:**
- [ ] Structured logging with `tracing`:
  ```rust
  #[tracing::instrument(skip(state))]
  async fn search_handler(state: State<Arc<AppState>>, body: Json<SearchRequest>) -> ... {
      tracing::info!(imdb_id = %body.imdb_id, "Search requested");
      ...
  }
  ```
- [ ] Log levels: error (failures), warn (retries, missed callbacks), info (normal ops), debug (verbose)
- [ ] Add request ID tracing (correlate request → DB → callback)
- [ ] Log pipeline metrics:
  - Jobs completed/failed per day
  - Average pipeline time by phase
  - Discord upload success rate

### Task 9.5 — Documentation 🟢
**Concrete steps:**
- [ ] Write `README.md`:
  - Project overview
  - Quick start (docker compose)
  - Configuration reference
  - Stremio addon installation
  - Development setup
- [ ] Write deployment guide:
  - VPS deployment (systemd + docker)
  - Reverse proxy setup (nginx/caddy with HTTPS)
  - Domain configuration for Stremio addon
- [ ] Add inline code documentation for complex logic
- [ ] Document GitHub Actions secrets needed:
  - `STREAMVAULT_AUTH_SECRET`
  - `STREAMVAULT_PUBLIC_BASE_URL`
  - Repository settings for workflow dispatch

### Task 9.6 — Testing 🟡
**Concrete steps:**
- [ ] Backend unit tests:
  - Database CRUD operations (in-memory SQLite)
  - Retry logic (all checkpoint combinations)
  - Stremio manifest generation
  - HLS playlist rewriting
  - Auth middleware
- [ ] Integration tests:
  - Full API flow: search → queue → mock callbacks → stream
  - SSE event delivery
- [ ] Frontend component tests (optional, with Vitest):
  - Search form validation
  - Progress bar rendering
  - Settings form
- [ ] End-to-end test script:
  - Docker compose up
  - Add a job via API
  - Simulate GHA callbacks
  - Verify Stremio stream endpoint

### Task 9.7 — Migration Path Preparation 🟢
Prepare for future Vercel migration (spec §14).

**Concrete steps:**
- [ ] Abstract database access behind a trait:
  ```rust
  #[async_trait]
  pub trait Database: Send + Sync {
      async fn get_job(&self, id: &str) -> AppResult<Job>;
      async fn insert_job(&self, job: &NewJob) -> AppResult<()>;
      // ... all query functions
  }

  pub struct SqliteDatabase(SqlitePool);
  // Future: pub struct TursoDatabase(Pool);
  ```
- [ ] Ensure no filesystem dependencies in API handlers (all via DB or HTTP)
- [ ] Document which components need changes for serverless deployment
- [ ] Create Vercel migration checklist in docs

---

## Implementation Order & Timeline

### Critical Path

```
Week 1:  Phase 1 (Foundation) + Phase 2 (Core API)
         └─ Gets backend running with all endpoints

Week 2:  Phase 3 (GHA Pipeline) + Phase 4 (Integration)
         └─ Gets the full pipeline working end-to-end

Week 3:  Phase 5 (Stremio) + Phase 6 (SSE + Telegram)
         └─ Gets streaming and notifications working

Week 4:  Phase 7 (Dashboard)
         └─ Gets the UI complete

Week 5:  Phase 8 (Docker) + Phase 9 (Polish)
         └─ Gets production-ready deployment
```

### Quick Win Path (for demos)

If you want the fastest path to a working demo:

1. **Phase 1** (1 day) — Foundation
2. **Phase 2.1-2.5** (2 days) — Auth + Queue CRUD only
3. **Phase 3** (2 days) — GHA pipeline (test manually)
4. **Phase 4.1-4.2** (1 day) — Trigger + callbacks only
5. **Phase 5.2-5.3** (1 day) — Stremio addon + proxy
6. Skip to testing with Stremio!

### Risk Areas

| Risk | Impact | Mitigation |
|---|---|---|
| GitHub Actions 6-hour timeout | Large files won't finish | Split pipeline into resumable phases with checkpoints |
| Discord rate limits | Upload phase stalls | Exponential backoff, sequential upload, respect headers |
| GH Artifact 2GB limit | Large movies fail checkpoint | Implement chunked artifact upload (split/cat) |
| Discord CDN URL expiry | Streams stop working | Proxy through backend, never expose CDN URLs directly |
| Torrentio Cloudflare | Search fails | Use proxy (same approach as MagnetVault) |
| SQLite concurrent writes | Lock contention under load | WAL mode, single writer pattern, max 5 connections |

---

## Task Summary

| Phase | Tasks | Complexity | Deliverable |
|---|---|---|---|
| 1. Foundation | 5 tasks | 🟡🟢🟢🔴🟡 | Running server with DB |
| 2. Core API | 7 tasks | 🟢🟢🟡🟡🟡🟢🟡 | All REST endpoints |
| 3. GHA Pipeline | 5 tasks | 🔴🔴🔴🔴🟢 | Working CI pipeline |
| 4. Integration | 6 tasks | 🟡🟡🔴🟡🟡🟡 | Full automated loop |
| 5. Stremio | 3 tasks | 🟢🟡🟡 | Streaming in Stremio |
| 6. Real-time | 2 tasks | 🟡🟡 | SSE + Telegram |
| 7. Dashboard | 8 tasks | 🟢🟢🟡🟡🔴🟡🟢🟢 | Complete UI |
| 8. Docker/CI | 4 tasks | 🔴🟢🟡🟢 | Deployable image |
| 9. Polish | 7 tasks | 🟡🟡🟡🟢🟢🟡🟢 | Production ready |
| **Total** | **47 tasks** | — | — |
