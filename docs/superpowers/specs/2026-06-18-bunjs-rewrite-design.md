# StreamVault Backend Rewrite — Rust → Bun.js

**Date**: 2026-06-18
**Status**: Draft
**Type**: Platform migration (no new features)

## Summary

Rewrite the ~2,400-line Rust backend (axum, sqlx, tokio) as a ~1,200-line Bun.js TypeScript server using Elysia + Drizzle ORM + libsql, compiled to a single 55 MB standalone binary via `bun build --compile`. Same API surface, same DB schema, same pipeline behavior. Smaller codebase, faster iteration, zero runtime dependencies.

## Motivation

- **Iteration speed**: Rust compile times kill rapid dashboard/backend co-development — Bun dev reload is instant
- **Team accessibility**: TypeScript is the dashboard language — single language across stack
- **Deployment**: Single binary, no runtime, no package manager — `COPY streamvault-server /` in a 3-line `scratch` Dockerfile, 55 MB total image
- **Cold start**: ~50ms (pre-compiled bytecode), vs Rust ~200ms (linker + JIT warmup)

## Non-Goals

- No new features, no API changes, no DB schema changes
- No dashboard migration (already Bun-compatible Svelte 5)
- No pipeline changes (GitHub Actions YAML stays as-is)
- Do not touch `rclone`, `libtorrent`, `ffmpeg` — those remain in the GHA pipeline container

## Architecture

```
                         ┌────────────────────┐
                         │    Svelte Dashboard │
                         │    (unchanged)      │
                         └──────┬─────────────┘
                                │ /api/v1/*
                                │ SSE events
                         ┌──────▼─────────────┐
                         │    Elysia Server    │
                         │    (port 8080)      │
                         │                     │
                         │  Routes:            │
                         │  /api/v1/* (auth)   │
                         │  /api/v1/jobs/*     │
                         │  /manifest.json     │
                         │  /catalog/...       │
                         │  /proxy/hls/...     │
                         │                     │
                         │  ┌──────────────┐   │
                         │  │ Scheduler    │   │
                         │  │ 30s tick     │   │
                         │  └──────┬───────┘   │
                         │         │           │
                         │  ┌──────▼───────┐   │
                         │  │ GH Triggers  │   │
                         │  └──────────────┘   │
                         └──────┬─────────────┘
                                │
                         ┌──────▼─────────────┐
                         │  libsql (SQLite)   │
                         │  (WAL mode)        │
                         │                    │
                         │  Tables:           │
                         │  - jobs            │
                         │  - job_events      │
                         │  - hls_chunks      │
                         │  - cinemeta_cache  │
                         │  - app_settings    │
                         └────────────────────┘
```

## File Structure

```
bun-backend/
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── src/
│   ├── index.ts          Entry: env, DB connect, scheduler start, listen
│   ├── app.ts            Elysia app assembly, all routes merged
│   ├── config.ts         Bun.env → typed config object
│   ├── db/
│   │   ├── schema.ts     Drizzle table definitions (1:1 w/ SQL schema)
│   │   ├── index.ts      Create libsql client, run migrations, set PRAGMAs
│   │   └── queries.ts    Query functions (insert_job, get_job, etc.)
│   ├── routes/
│   │   ├── auth.ts       Bearer + query-token middleware
│   │   ├── search.ts     POST /api/v1/search
│   │   ├── queue.ts      CRUD /api/v1/queue
│   │   ├── callbacks.ts  POST /api/v1/jobs/:id/*
│   │   ├── events.ts     GET /api/v1/events (SSE)
│   │   ├── settings.ts   GET/PUT /api/v1/settings
│   │   └── library.ts    GET/DELETE /api/v1/library
│   ├── stremio/
│   │   ├── models.ts     Stremio protocol types
│   │   ├── routes.ts     Manifest, catalog, meta, stream
│   │   └── proxy.ts      HLS playlist + Discord CDN proxy
│   ├── pipeline/
│   │   └── trigger.ts    GitHub Actions dispatch + cancel
│   ├── worker/
│   │   ├── scheduler.ts  30s tick → dequeue → trigger
│   │   └── monitor.ts    Recover stale jobs on startup
│   └── notifications/
│       └── telegram.ts   Send Telegram messages via Bot API
└── drizzle/
    └── migrations/       (auto-generated, same schema)
```

~22 files, estimated ~1,200 lines.

## Dependency Map

| Dependency | Version | Purpose |
|-----------|---------|---------|
| `elysia` | ^1.2 | HTTP framework (routes, middleware, SSE) |
| `drizzle-orm` | ^0.41 | Type-safe SQL queries, schema definitions |
| `@libsql/client` | ^0.14 | Async SQLite driver (WAL mode compatible) |
| `dotenv` | ^16 | Load `.env` file |
| `pino` | ^9 | Structured JSON logging |

## API Surface (unchanged)

### Authenticated (Bearer / ?token=)

| Method | Path | Handler |
|--------|------|---------|
| POST | `/api/v1/search` | Search Cinemeta + Torrentio |
| POST | `/api/v1/queue` | Create job |
| GET | `/api/v1/queue` | List all jobs (grouped by status) |
| GET | `/api/v1/queue/:id` | Get single job + events |
| POST | `/api/v1/queue/:id/retry` | Requeue failed job |
| DELETE | `/api/v1/queue/:id` | Delete job (cancel GH run if active) |
| GET | `/api/v1/events` | SSE event stream |
| GET | `/api/v1/settings` | Get all settings (keys masked) |
| PUT | `/api/v1/settings` | Update settings |
| GET | `/api/v1/library` | List completed jobs |
| DELETE | `/api/v1/library/:id` | Delete completed job |

### Callback (X-Callback-Token)

| Method | Path | Handler |
|--------|------|---------|
| POST | `/api/v1/jobs/:id/progress` | Update download/transcode/upload progress |
| POST | `/api/v1/jobs/:id/checkpoint` | Save checkpoint artifact ID |
| POST | `/api/v1/jobs/:id/complete` | Mark job completed, save resolution/duration |
| POST | `/api/v1/jobs/:id/failed` | Mark job failed, save error message |

### Public (no auth)

| Method | Path | Handler |
|--------|------|---------|
| GET | `/manifest.json` | Stremio addon manifest |
| GET | `/catalog/:type/:id.json` | Completed library catalog |
| GET | `/meta/:type/:id.json` | Metadata (from cinemeta cache) |
| GET | `/stream/:type/:id.json` | Resolve stream → HLS URL |
| GET | `/proxy/hls/:id/master.m3u8` | Regenerate HLS playlist from DB |
| GET | `/proxy/hls/:id/*` | Proxy chunk from Discord CDN |

### Fallback

| Method | Path | Handler |
|--------|------|---------|
| `*` | `/*` | Serve dashboard `dist/` static files |

## Key Implementation Details

### 1. SSE (Server-Sent Events)

**Rust**: `tokio::sync::broadcast` channel, `axum` streaming response with `SseEvent` enum tag.

**Bun**: `EventEmitter` + `ReadableStream`. 

```ts
// events.ts
const emitter = new EventEmitter<{
  job_progress: [SsePayload];
  job_completed: [SsePayload];
  queue_update: [SsePayload];
  // ...
}>();

// Route handler
app.get("/api/v1/events", ({ request, set }) => {
  const token = new URL(request.url).searchParams.get("token");
  // verify token...
  
  const stream = new ReadableStream({
    start(controller) {
      const handler = (payload) => {
        const line = `event:${payload.event}\ndata:${JSON.stringify(payload.data)}\n\n`;
        controller.enqueue(new TextEncoder().encode(line));
      };
      // Register for all event types
      emitter.on('*', handler);
      
      // Cleanup on client disconnect
      request.signal.addEventListener("abort", () => {
        emitter.off('*', handler);
      });
    }
  });
  
  set.headers['content-type'] = 'text/event-stream';
  set.headers['cache-control'] = 'no-cache';
  return new Response(stream);
});
```

`request.signal.abort` handles client disconnects — same semantics as Rust's `axum::sse`.

### 2. Scheduler (30s tick → dequeue → trigger)

**Rust**: `tokio::time::interval` loop in a `tokio::spawn`.

**Bun**: `setInterval` inside the server startup, with async handler.

```ts
// scheduler.ts
export function startScheduler(db: LibSQLClient, emitter: EventEmitter) {
  setInterval(async () => {
    const active = await getJobsByStatuses(db, PROCESSING_STATUSES);
    if (active.length > 0) return; // wait for active to finish
    
    const next = await getNextQueuedJob(db);
    if (!next) return;
    
    await triggerPipeline(db, emitter, next);
  }, 30_000);
  
  // Also run immediately on startup
  setTimeout(tick, 100);
}
```

Bun's `setInterval` is backed by libuv — event loop stays alive as long as the server listens.

### 3. Database (SQLite via libsql + Drizzle)

**Schema**: 1:1 with the existing SQL migration. Drizzle schema file mirrors every table, column, and constraint.

**Migrations**: Drizzle generates `.sql` files. First migration is the existing schema verbatim — no data loss.

**WAL mode**: Set `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;` on connect — same as Rust.

### 4. GitHub Actions Trigger

**Rust**: `reqwest::Client` → POST to `https://api.github.com/repos/{repo}/actions/workflows/{file}/dispatches`

**Bun**: Native `fetch()` — zero dependency.

```ts
const resp = await fetch(
  `https://api.github.com/repos/${repo}/actions/workflows/${file}/dispatches`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "StreamVault/1.0",
    },
    body: JSON.stringify({ ref: "main", inputs: { ... } }),
  }
);
```

### 5. HLS Proxy

**Rust**: `axum` streaming response, HTTP Range support, Discord CDN URL refresh.

**Bun**: `Response` with `ReadableStream`, `Range` header parsing, native `fetch()` to Discord CDN. Discord URL refreshes via Discord Bot API `GET /channels/{id}/messages` — same as Rust.

### 6. Auth Middleware

**Rust**: Axum `middleware::from_fn_with_state`.

**Bun/Elysia**: Elysia `derive` or `beforeHandle` hook.

```ts
// auth.ts
export const authPlugin = (app: Elysia) =>
  app.derive(({ headers, query }) => {
    const headerToken = headers.authorization?.replace("Bearer ", "");
    const queryToken = query?.token;
    const token = headerToken || queryToken;
    
    if (token !== Bun.env.STREAMVAULT_AUTH_SECRET) {
      throw error(401, "Unauthorized");
    }
  });
```

### 7. Error Handling

**Rust**: `AppError` enum → `IntoResponse` impl.

**Bun/Elysia**: Elysia `error` plugin or centralized `onError` handler.

```ts
app.onError(({ code, error }) => {
  const statusMap = {
    NOT_FOUND: 404,
    UNAUTHORIZED: 401,
    VALIDATION: 400,
  };
  return Response.json(
    { error: error.message },
    { status: statusMap[code] || 500 }
  );
});
```

## Migration Strategy

### Phase 1: Deploy side-by-side
- New Bun backend on port `8081`, Rust still on `8080`
- Test with real dashboard, real pipeline trigger, real Stremio client
- Port 8080 proxy still points at Rust

### Phase 2: Cutover
- Point port 8080 to Bun backend
- Keep Rust container on standby (rollback path)
- Delete `backend/` directory from repo

### Rollback
- Point port 8080 back to Rust container
- Bun backend stays for debugging

## Risks

| Risk | Mitigation |
|------|-----------|
| libsql async behavior differs from sqlx | Test all 25 query functions with real DB |
| SSE reconnect in Bun vs Tokio broadcast | Test with `EventSource` client + disconnects |
| Fetch timeout defaults differ | Set explicit `signal: AbortSignal.timeout(30_000)` |
| Drizzle migration vs raw SQL migration | Generate first migration from existing SQL, verify table schema matches byte-for-byte |
| Bun VM edge cases with long-lived intervals | 24h soak test with active scheduler |

## Deployment

### Binary Build

```bash
bun build --compile --target=bun-linux-x64 ./src/index.ts --outfile streamvault-server
```

Single 55 MB binary. No Bun runtime, no Node, no package manager needed at deploy time.

### Docker Image

```dockerfile
FROM scratch
COPY streamvault-server /streamvault-server
COPY dashboard/dist /dashboard/dist
COPY data/ /data
ENTRYPOINT ["/streamvault-server"]
```

~55 MB total. Compare: Rust Docker image ~300 MB (`rust:slim` builder + binary).

### Dev Loop

During development and the side-by-side phase, use `bun run --hot`:

```bash
bun --hot src/index.ts
```

Instant reload on file change, no build step. Once stabilized, switch to binary for production.

## Decisions

1. **Single binary (`bun build --compile`)**. Chosen for production deployment. Dev still uses `bun run --hot` for instant reload. Binary rebuild only when shipping.

2. **Keep `/api/v1/library` endpoints**. Frontend dashboard has no library page, but Stremio catalog depends on completed jobs. No change needed.

3. **Drizzle ORM + libsql**. `bun:sqlite` is synchronous and blocks the event loop. Drizzle + libsql gives async queries with the same SQLite database.

4. **Keep Telegram notifications**. Gated behind `notifications_enabled` setting — zero overhead when off. Pure HTTP, no extra deps.

## Acceptance Criteria

- [ ] All 19 API endpoints return identical responses to Rust backend
- [ ] SSE events stream correctly to dashboard (job_created, job_progress, queue_update, etc.)
- [ ] Scheduler picks up queued jobs and triggers GitHub Actions pipeline
- [ ] HLS proxy serves playlists and proxies Discord chunks with Range support
- [ ] Settings UI reads/writes correctly from dashboard
- [ ] Auth middleware rejects invalid tokens (Bearer + query)
- [ ] Callback auth accepts correct `X-Callback-Token`
- [ ] Stale job recovery on restart marks in-progress jobs as failed
- [ ] `bun build --compile` produces single binary
- [ ] Binary runs in `scratch` Docker image, port 8080
- [ ] Build produces ~1,200 lines of TypeScript (not 2,400)
- [ ] TypeScript type-checks with `tsc --noEmit` zero errors
- [ ] Dashboard integration smoke test passes
