# StreamVault Backend Rewrite: Rust → Bun.js

**Date:** 2026-06-21
**Status:** Draft
**Motivation:** Developer experience / iteration speed. TypeScript ecosystem, hot reload, npm packages, faster prototyping.

## Constraints

- **Parallel development:** Bun code lives in `backend-bun/`. Rust backend stays untouched until Bun is stable.
- **1:1 feature parity:** Every API route, every behavior, every edge case from Rust must work identically in Bun. No features dropped.
- **Single binary output:** `bun build --compile` → one executable. Docker multi-stage build for slim runtime.
- **Dashboard serving:** Bun serves Svelte static files from `dashboard/dist`, same as Rust.

---

## Tech Stack

| Component | Rust (current) | Bun (target) |
|-----------|---------------|--------------|
| Runtime | tokio | Bun native |
| HTTP framework | Axum 0.7 | Hono |
| Database | sqlx + SQLite | Drizzle ORM + `bun:sqlite` |
| Auth | Axum middleware | Hono middleware |
| SSE | tokio broadcast | Custom fan-out (manual subscriber set) |
| HTTP client | reqwest | Bun native `fetch` |
| UUID | uuid crate | `crypto.randomUUID()` |
| Config | dotenvy | `Bun.env` (built-in) |
| Logging | tracing | `console.log` / `console.error` |
| Build | cargo build --release | `bun build --compile` |
| Docker | rust:slim → debian:bookworm-slim | oven/bun:alpine → debian:bookworm-slim |

---

## Architecture

```
User → Svelte Dashboard → Hono/Bun API → GitHub Actions → Discord CDN → Stremio
```

### AppState

```ts
interface AppState {
  db: DrizzleDB;           // Drizzle instance (bun:sqlite)
  config: Config;          // Mutable config object
  eventBus: EventBus;      // SSE broadcast (custom)
}
```

- **No Arc/RwLock needed.** JS is single-threaded. Config mutations are synchronous.
- **Config** is a plain object, mutated directly on settings update (no RwLock).
- **HTTP client** = native `fetch()` (Bun built-in). No reqwest equivalent needed.

### EventBus (SSE)

Custom implementation replacing `tokio::sync::broadcast`:

```ts
class EventBus {
  private listeners: Set<(event: SseEvent) => void> = new Set();

  subscribe(): (event: SseEvent) => void {
    const listener = (event: SseEvent) => { /* sent via stream */ };
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(event: SseEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
```

Each SSE connection gets a `ReadableStream` with its own subscriber. When client disconnects, subscriber is removed.

---

## File Structure (1:1 with Rust)

```
backend-bun/
├── src/
│   ├── index.ts              ← main.rs
│   ├── app.ts                ← app.rs
│   ├── config.ts             ← config.rs
│   ├── error.ts              ← error.rs
│   ├── db/
│   │   ├── index.ts          ← db/mod.rs
│   │   ├── schema.ts         ← (Drizzle table defs)
│   │   └── queries.ts        ← db/queries.rs
│   ├── api/
│   │   ├── auth.ts           ← api/auth.rs
│   │   ├── callbacks.ts      ← api/callbacks.rs
│   │   ├── events.ts         ← api/events.rs
│   │   ├── library.ts        ← api/library.rs
│   │   ├── queue.ts          ← api/queue.rs
│   │   ├── search.ts         ← api/search.rs
│   │   ├── settings.ts       ← api/settings.rs
│   │   └── torrent.ts        ← api/torrent.rs
│   ├── pipeline/
│   │   ├── channel.ts        ← pipeline/channel.rs
│   │   └── trigger.ts        ← pipeline/trigger.rs
│   ├── stremio/
│   │   ├── routes.ts         ← stremio/routes.rs
│   │   ├── proxy.ts          ← stremio/proxy.rs
│   │   └── models.ts         ← stremio/models.rs
│   ├── worker/
│   │   ├── scheduler.ts      ← worker/scheduler.rs
│   │   └── monitor.ts        ← worker/monitor.rs
│   └── notifications/
│       └── telegram.ts       ← notifications/telegram.rs
├── drizzle.config.ts
├── migrations/
├── package.json
├── tsconfig.json
├── Dockerfile
└── docker-compose.yml
```

---

## Database Layer

### Schema (Drizzle)

5 tables, exact column match with Rust migrations:

```ts
// src/db/schema.ts
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  imdbId: text("imdb_id").notNull(),
  mediaType: text("media_type").notNull(),       // "movie" | "series"
  season: integer("season"),
  episode: integer("episode"),
  title: text("title"),
  posterUrl: text("poster_url"),
  magnetUri: text("magnet_uri"),
  infohash: text("infohash"),
  torrentName: text("torrent_name"),
  fileIdx: integer("file_idx"),
  fileSizeBytes: integer("file_size_bytes"),
  status: text("status").notNull().default("queued"),
  currentPhase: text("current_phase"),
  progressPct: integer("progress_pct").default(0),
  transcodePct: integer("transcode_pct").default(0),
  uploadPct: integer("upload_pct").default(0),
  lastCheckpoint: text("last_checkpoint"),
  ghRunId: text("gh_run_id"),
  ghArtifactIdDl: text("gh_artifact_id_dl"),
  ghArtifactIdTc: text("gh_artifact_id_tc"),
  ghArtifactDlUrl: text("gh_artifact_dl_url"),
  ghArtifactTcUrl: text("gh_artifact_tc_url"),
  discordChannelId: text("discord_channel_id"),
  videoResolution: text("video_resolution"),
  durationSeconds: real("duration_seconds"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").default(sql`datetime('now')`),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  updatedAt: text("updated_at").default(sql`datetime('now')`),
});

export const jobEvents = sqliteTable("job_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: text("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  phase: text("phase"),
  eventType: text("event_type").notNull(),
  message: text("message"),
  progressPct: integer("progress_pct"),
  createdAt: text("created_at").default(sql`datetime('now')`),
});

export const hlsChunks = sqliteTable("hls_chunks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: text("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  chunkIndex: integer("chunk_index").notNull(),
  filename: text("filename").notNull(),
  discordUrl: text("discord_url"),
  discordMessageId: text("discord_message_id"),
  durationSeconds: real("duration_seconds"),
  fileSizeBytes: integer("file_size_bytes"),
  createdAt: text("created_at").default(sql`datetime('now')`),
});

export const cinemetaCache = sqliteTable("cinemeta_cache", {
  imdbId: text("imdb_id").notNull(),
  mediaType: text("media_type").notNull(),
  title: text("title"),
  posterUrl: text("poster_url"),
  overview: text("overview"),
  year: integer("year"),
  totalSeasons: integer("total_seasons"),
  cachedAt: text("cached_at").default(sql`datetime('now')`),
}, (t) => ({
  pk: primaryKey(t.imdbId, t.mediaType),
}));

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value"),
});
```

### Query Pattern

All queries are **synchronous** (`bun:sqlite` is sync). Drizzle's `.all()`, `.get()`, `.run()` return directly.

```ts
// Rust: async fn list_jobs_by_status(pool, status) -> Vec<Job>
// Bun:  function listJobsByStatus(db, status): Job[]

function listJobsByStatus(db: DrizzleDB, status: string): Job[] {
  return db.select().from(jobs).where(eq(jobs.status, status))
    .orderBy(desc(jobs.createdAt)).all();
}
```

Error handling: wrap in try/catch, throw `AppError` equivalents.

### Migration Strategy

Drizzle Kit generates SQL migrations from schema. On startup, run `migrate()`:

```ts
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
migrate(db, { migrationsFolder: "./migrations" });
```

Existing Rust migrations are compatible — same table definitions, same SQL. Copy `backend/migrations/*.sql` into `backend-bun/migrations/` or regenerate from Drizzle schema.

### Indexes

Same indexes as Rust:

```sql
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_imdb_id ON jobs(imdb_id);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_events_job_id ON job_events(job_id);
CREATE INDEX IF NOT EXISTS idx_hls_chunks_job_id ON hls_chunks(job_id);
```

---

## Config

```ts
// src/config.ts
interface Config {
  databaseUrl: string;         // default: "sqlite:data/streamvault.db?mode=rwc"
  authSecret: string;          // required
  publicBaseUrl: string;       // default: "http://localhost:8080"
  ghToken?: string;
  ghRepo?: string;
  discordBotToken?: string;
  discordChannelId?: string;
  discordChannelIds?: string;
  telegramBotToken?: string;
  telegramChannelId?: string;
  torrentioBaseUrl?: string;
  dashboardDir: string;        // default: "dashboard/dist"
}
```

Load from `process.env` (Bun has native `.env` loading via `--env-file` or `Bun.env`). Replace `dotenvy` with Bun's built-in.

---

## Error Handling

```ts
// src/error.ts
class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) { super(message); }
}

function notFound(msg: string) { return new AppError(404, msg); }
function badRequest(msg: string) { return new AppError(400, msg); }
function unauthorized() { return new AppError(401, "Unauthorized"); }
function internal(msg: string) { return new AppError(500, msg); }
function badGateway(msg: string) { return new AppError(502, msg); }
```

Hono error handler converts to JSON:

```ts
app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: err.message }, err.statusCode as any);
  }
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});
```

---

## Routes (13 API + 6 Public)

### Auth Routes (Bearer token + `?token=` query param)

| Method | Path | Handler | Rust Source |
|--------|------|---------|-------------|
| POST | `/api/v1/search` | `searchHandler` | `api/search.rs` |
| POST | `/api/v1/torrent/inspect` | `inspectTorrent` | `api/torrent.rs` |
| POST | `/api/v1/queue` | `createJob` | `api/queue.rs` |
| GET | `/api/v1/queue` | `listJobs` | `api/queue.rs` |
| GET | `/api/v1/queue/:id` | `getJob` | `api/queue.rs` |
| POST | `/api/v1/queue/:id/retry` | `retryJob` | `api/queue.rs` |
| DELETE | `/api/v1/queue/:id` | `deleteJob` | `api/queue.rs` |
| GET | `/api/v1/events` | `sseHandler` | `api/events.rs` |
| GET | `/api/v1/settings` | `getSettings` | `api/settings.rs` |
| PUT | `/api/v1/settings` | `updateSettings` | `api/settings.rs` |
| POST | `/api/v1/settings/test-notification` | `testNotification` | `api/settings.rs` |
| GET | `/api/v1/library` | `listLibrary` | `api/library.rs` |
| POST | `/api/v1/library/:id/requeue` | `requeueJob` | `api/library.rs` |
| GET | `/api/v1/library/:imdb_id` | `getLibraryItem` | `api/library.rs` |

### Callback Routes (X-Callback-Token header)

| Method | Path | Handler | Rust Source |
|--------|------|---------|-------------|
| POST | `/api/v1/jobs/:id/progress` | `progressCallback` | `api/callbacks.rs` |
| POST | `/api/v1/jobs/:id/checkpoint` | `checkpointCallback` | `api/callbacks.rs` |
| POST | `/api/v1/jobs/:id/complete` | `completeCallback` | `api/callbacks.rs` |
| POST | `/api/v1/jobs/:id/failed` | `failedCallback` | `api/callbacks.rs` |

### Public Routes (No auth)

| Method | Path | Handler | Rust Source |
|--------|------|---------|-------------|
| GET | `/manifest.json` | `manifestHandler` | `stremio/routes.rs` |
| GET | `/catalog/:type/:catalogId.json` | `catalogHandler` | `stremio/routes.rs` |
| GET | `/meta/:type/:imdbId.json` | `metaHandler` | `stremio/routes.rs` |
| GET | `/stream/:type/:id.json` | `streamHandler` | `stremio/routes.rs` |
| GET | `/proxy/hls/:jobId/master.m3u8` | `playlistHandler` | `stremio/proxy.rs` |
| GET | `/proxy/hls/:jobId/*filename` | `chunkHandler` | `stremio/proxy.rs` |
| GET | `*` (fallback) | Static serve | `tower_http::ServeDir` |

---

## API Handler Specifications

### Search (`api/search.ts`)

**Input:** `{ imdb_id, media_type, season?, episode? }`

**Behavior (exact port from Rust):**
1. Validate imdb_id starts with "tt"
2. Fetch metadata from Cinemeta (`https://v3-cinemeta.strem.io/meta/{type}/{imdb_id}.json`)
3. Check `cinemeta_cache` table first — if miss, fetch from Cinemeta API, upsert cache
4. Build stream_id: movie = `{imdb_id}`, series = `{imdb_id}:{season}:{episode}`
5. Fetch torrents from Torrentio (`{base_url}/stream/{type}/{stream_id}.json`)
6. Parse each stream: extract `infoHash`, `title`, `name`, `fileIdx`, `size`, `behaviorHints.filename`
7. Build magnet URI with `infohash + dn + 60+ trackers` (exact tracker list from Rust)
8. Apply quality filter: remove low-quality (cam, ts, hc, etc.), score by resolution, sort descending, limit to 5
9. Return `{ meta: { title, poster, year }, torrents: [...] }`

**Tracker list:** Exact 60+ trackers from `DEFAULT_TRACKERS` in Rust `search.rs`. Must be copied verbatim.

### Queue (`api/queue.ts`)

**createJob:** UUID v4, insert job, insert event, broadcast SSE `JobCreated`, send Telegram notification.
**listJobs:** Group all jobs by status: processing/queued/completed/failed.
**getJob:** Fetch job + events + gh_repo from settings.
**retryJob:** Only failed jobs. Check `last_checkpoint` to determine skip flags. Trigger pipeline with skip_download/skip_transcode. Update status to processing.
**deleteJob:** If active (processing/downloading/etc), cancel GitHub Actions run via API. Delete from DB (cascades). Broadcast `JobRemoved`.

### Callbacks (`api/callbacks.ts`)

**progressCallback:** Update job progress (column depends on phase: transcode→transcode_pct, upload→upload_pct, else progress_pct). If `chunk` object present, insert HLS chunk. Log event. Broadcast SSE.

**checkpointCallback:** Requires `checkpoint` field. Call `update_job_checkpoint` which maps:
- "download" → status="checkpoint_download", set gh_artifact_id_dl + gh_artifact_dl_url
- "transcode" → status="checkpoint_transcode", set gh_artifact_id_tc + gh_artifact_tc_url

Log event, broadcast SSE, send Telegram notification.

**completeCallback:** Set status="completed", video_resolution, duration_seconds. Get job before update for gh_run_id. After update: broadcast SSE, Telegram notification. Delete GitHub Actions run if run_id exists (DELETE to GitHub API).

**failedCallback:** Set status="failed", error_message. Broadcast SSE. Telegram notification with title + phase + error.

### Settings (`api/settings.ts`)

**getSettings:** Merge env config + DB settings (DB takes priority). Return map of all setting keys.

**updateSettings:** Upsert each key-value to DB. Reload config from DB into AppState.

**testNotification:** Get telegram_bot_token + telegram_channel_id from DB or config. Send test message via Telegram API.

### Library (`api/library.ts`)

**listLibrary:** Paginated. Query completed jobs grouped by imdb_id. For each group: fetch child jobs, get poster from job or cinemeta_cache. Return `{ items: [...], total, page, limit }`.

**requeueJob:** Update job status to "queued" if status is "completed" or "failed". Return 404 if not eligible.

**getLibraryItem:** Fetch all completed jobs for imdb_id. Get poster from jobs or cinemeta_cache. Determine media_type from season field.

### Torrent (`api/torrent.ts`)

**inspectTorrent:** Validate infohash (40 hex chars). Fetch from `https://itorrents.org/torrent/{INFOHASH}.torrent`. Parse bencode to extract info dict → files list. Return `{ name, files: [{ index, name, size_bytes }] }`.

**Bencode parser:** Minimal parser — only needs to extract `info` → `name` and `files` list. Port the exact bencode parser from Rust (custom, no library).

### Events (`api/events.ts`)

**SSE Handler:** Return `ReadableStream` with `text/event-stream` content type. Each client gets its own stream. Fan-out from EventBus.

Keep-alive: send `:keep-alive\n\n` every 15 seconds.

Event types: `job_created`, `job_started`, `job_progress`, `job_checkpoint`, `job_completed`, `job_failed`, `job_retried`, `job_removed`, `queue_update`.

---

## Stremio Addon Routes

### manifestHandler

Return Stremio manifest JSON:
```json
{
  "id": "com.streamvault.addon",
  "version": "1.0.0",
  "name": "StreamVault",
  "description": "Personal media streaming pipeline",
  "resources": ["stream", "catalog", "meta"],
  "types": ["movie", "series"],
  "catalogs": [
    { "type": "movie", "id": "streamvault-movies", "name": "StreamVault Movies" },
    { "type": "series", "id": "streamvault-series", "name": "StreamVault Series" }
  ],
  "idPrefixes": ["tt"],
  "behaviorHints": { "configurable": false, "configurationRequired": false }
}
```

### catalogHandler

Query completed jobs, group by imdb_id, return as Stremio `MetaPreview[]`.

### metaHandler

Proxy to Cinemeta: `https://v3-cinemeta.strem.io/meta/{type}/{imdb_id}.json`. Return as-is.

### streamHandler

Parse stream ID: `tt1234567` (movie) or `tt1234567:1:3` (series). Find matching completed job. Return HLS stream URL pointing to backend proxy.

---

## HLS Proxy (`stremio/proxy.ts`)

### playlistHandler

1. Get job + HLS chunks from DB
2. Filter to `.ts` files only
3. Build M3U8 playlist:
   - `#EXTM3U`, `#EXT-X-VERSION:3`, `#EXT-X-TARGETDURATION:{max_duration}`, `#EXT-X-MEDIA-SEQUENCE:0`, `#EXT-X-PLAYLIST-TYPE:VOD`
   - For each chunk: `#EXTINF:{duration},` + `{base_url}/proxy/hls/{job_id}/{filename}`
   - `#EXT-X-ENDLIST`
4. Response: `Content-Type: application/vnd.apple.mpegurl`, `Cache-Control: no-cache`, `Access-Control-Allow-Origin: *`

### chunkHandler

1. Look up chunk by job_id + filename → get `discord_url` + `discord_message_id`
2. If not found → 404
3. Get Range header from request → `parseRange("bytes=0-1023")` → `"0-1023"`
4. Fetch from Discord CDN with Range header
5. If fetch fails → try `refreshCdnUrl` (re-fetch Discord message to get new CDN URL) → update DB → retry fetch
6. If still fails → 502

### refreshCdnUrl

Call Discord API: `GET /channels/{channel_id}/messages/{message_id}`. Extract attachment URL from response. Uses job's `discord_channel_id` (supports multi-channel sharding).

---

## Pipeline

### trigger.ts

**triggerPipeline:** POST to GitHub Actions dispatch endpoint. Workflow file: `streamvault-pipeline.yml`.

Inputs sent:
- `job_id`, `magnet_uri`, `file_idx`, `torrent_name`
- `callback_url` (public_base_url), `callback_token` (auth_secret)
- `discord_bot_token`, `discord_channel_id`
- `skip_download`, `skip_transcode`
- `checkpoint_dl_url`, `checkpoint_tc_url`

After dispatch (204): sleep 3s → poll `fetch_gh_run_id` to get run ID → update job with run_id.

**fetch_gh_run_id:** GET GitHub Actions workflow runs, filter by status in_progress/queued, return most recent run ID.

**cancel_gh_run:** POST to GitHub Actions cancel endpoint.

**getDiscordChannel:** Try `discord_channel_ids` (comma-separated) → hash pick. Fallback to `discord_channel_id`.

**getSettingOrEnv:** Check DB first, fallback to config (env vars). Keys: gh_token, gh_repo, discord_bot_token, discord_channel_id, telegram_bot_token, telegram_channel_id, torrentio_base_url.

### channel.ts

Deterministic channel picker: `pickChannel(jobId, channels[])`. Jenkins one-at-a-time hash → modulo. Port exact Rust logic.

---

## Worker

### scheduler.ts

**schedulerLoop:** `setInterval` every 15 seconds. Each tick:
1. Count configured Discord channels
2. Count active jobs (processing/downloading/checkpoint_download/transcoding/checkpoint_transcode/uploading)
3. Compute slots = max(1, channels) - active
4. If slots > 0, pop next queued job → update status to "processing" → insert event → broadcast SSE → send Telegram → trigger pipeline
5. Broadcast queue update

### monitor.ts

**recoverStaleJobs:** On startup, query jobs with active statuses → mark each as failed with "Server restarted — job interrupted, please retry" → insert event.

---

## Notifications (`notifications/telegram.ts`)

**sendNotification:** Check if `notifications_enabled` setting is "true". Get bot_token + channel_id. POST to `https://api.telegram.org/bot{token}/sendMessage`.

Messages:
- `JobQueued` → "🎬 Added to queue: {title}"
- `JobStarted` → "⚙️ Processing started: {title}"
- `CheckpointSaved` → "💾 Checkpoint saved: {title} — {phase}"
- `JobCompleted` → "✅ StreamVault - Download Complete\n\n🎬 {title}\n{details}"
- `JobFailed` → "❌ Failed: {title} at {phase} — {error}"

Fire-and-forget (spawned async, no await on caller side).

---

## Build & Deploy

### Dockerfile (multi-stage)

```dockerfile
# Stage 1: Build frontend
FROM node:22-alpine AS frontend
WORKDIR /app/dashboard
COPY dashboard/package*.json ./
RUN npm ci
COPY dashboard/ ./
RUN npm run build

# Stage 2: Build backend binary
FROM oven/bun:alpine AS backend
WORKDIR /app
COPY backend-bun/package.json backend-bun/bun.lock* ./
RUN bun install --frozen-lockfile
COPY backend-bun/ ./
RUN bun build --compile src/index.ts --outfile streamvault

# Stage 3: Runtime
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=backend /app/streamvault .
COPY --from=frontend /app/dashboard/dist ./dashboard
COPY docker/entrypoint-bun.sh .
RUN chmod +x entrypoint-bun.sh

ENV STREAMVAULT_DASHBOARD_DIR=/app/dashboard
EXPOSE 8080

ENTRYPOINT ["./entrypoint-bun.sh"]
```

### entrypoint-bun.sh

```sh
#!/bin/sh
set -e
mkdir -p /data
export STREAMVAULT_DATABASE_URL="${STREAMVAULT_DATABASE_URL:-sqlite:/data/streamvault.db?mode=rwc}"
export STREAMVAULT_DASHBOARD_DIR="${STREAMVAULT_DASHBOARD_DIR:-/app/dashboard}"
echo "Starting StreamVault (Bun)..."
exec ./streamvault
```

### docker-compose.yml

Same structure as Rust, just different image name and build context.

---

## Behavior Parity Checklist

Every item must be verified 1:1 with Rust behavior:

- [ ] Auth middleware: Bearer header → `?token=` fallback → 401
- [ ] Callback auth: `X-Callback-Token` header → 401
- [ ] Search: Cinemeta cache-first, Torrentio fetch, magnet building, quality filter (5 results)
- [ ] Torrent inspect: itorrents.org fetch, bencode parse, file listing
- [ ] Queue CRUD: UUID v4, SSE broadcast, Telegram notifications
- [ ] Retry: Only failed jobs, checkpoint-aware skip flags
- [ ] Delete: Cancel active GHA runs, cascade delete
- [ ] SSE: Event fan-out, keep-alive every 15s, correct event names
- [ ] Settings: Merge env + DB, update reloads config
- [ ] Test notification: Telegram API call with error handling
- [ ] Library: Paginated groups, poster fallback (job → cinemeta_cache)
- [ ] Requeue: Only completed/failed jobs
- [ ] Stremio manifest: Exact JSON structure
- [ ] Stremio catalog: Completed jobs as MetaPreview
- [ ] Stremio meta: Cinemeta proxy
- [ ] Stremio stream: Parse `tt123:1:3` format, find matching job
- [ ] HLS playlist: M3U8 VOD, correct headers, segment URLs
- [ ] HLS proxy: Range requests, CDN URL refresh on failure
- [ ] Pipeline trigger: GitHub Actions dispatch with all inputs
- [ ] Pipeline cancel: GitHub Actions cancel endpoint
- [ ] Scheduler: 15s tick, concurrency = channel count, queued FIFO
- [ ] Monitor: Recover stale jobs on startup
- [ ] Telegram: All 5 event types with correct formatting
- [ ] Config: All env vars, DB override, settings reload
- [ ] CORS: Permissive (`*`)
- [ ] Static files: Dashboard SPA serving with fallback
- [ ] Graceful shutdown: SIGTERM/Ctrl+C
- [ ] WAL mode + foreign keys on SQLite
- [ ] All 8 indexes created
- [ ] All 5 indexes created
