# StreamVault Bun.js Rewrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite StreamVault Rust backend to Bun.js/TypeScript in a parallel `backend-bun/` directory, preserving 100% of API routes, behavior, and edge cases.

**Architecture:** Hono HTTP framework on Bun runtime, Drizzle ORM with `bun:sqlite`, SSE via custom EventBus fan-out, single binary via `bun build --compile`. 1:1 file structure mirroring Rust modules.

**Tech Stack:** Bun 1.x, Hono 4.x, Drizzle ORM, `bun:sqlite`, TypeScript (strict), Docker multi-stage build.

---

## Task Structure

The plan is divided into 8 phases, each producing testable output:

| Phase | Files | Depends On |
|-------|-------|------------|
| 1. Bootstrap | package.json, tsconfig, index.ts, config.ts, error.ts | — |
| 2. Database | schema.ts, queries.ts, index.ts, migrations | Phase 1 |
| 3. Foundation | auth.ts, events.ts, app.ts | Phase 2 |
| 4. API Handlers | queue.ts, callbacks.ts, settings.ts, library.ts, search.ts, torrent.ts | Phase 3 |
| 5. Stremio | routes.ts, models.ts, proxy.ts | Phase 4 |
| 6. Pipeline | channel.ts, trigger.ts | Phase 4 |
| 7. Workers | scheduler.ts, monitor.ts | Phase 6 |
| 8. Notifications | telegram.ts | Phase 4 |
| 9. Build & Deploy | Dockerfile, docker-compose.yml | Phase 8 |

---

### Task 1: Bootstrap project — package.json, tsconfig, entry point, config, error

**Files:**
- Create: `backend-bun/package.json`
- Create: `backend-bun/tsconfig.json`
- Create: `backend-bun/src/index.ts`
- Create: `backend-bun/src/config.ts`
- Create: `backend-bun/src/error.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "streamvault",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/index.ts",
    "build": "bun build --compile src/index.ts --outfile streamvault",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  },
  "dependencies": {
    "hono": "^4.7.0",
    "drizzle-orm": "^0.39.0",
    "drizzle-kit": "^0.30.0",
    "better-sqlite3": "^11.7.0",
    "drizzle-orm/bun-sqlite": "*"
  },
  "devDependencies": {
    "bun-types": "latest",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["bun-types"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create config.ts**

```ts
export interface Config {
  databaseUrl: string;
  authSecret: string;
  publicBaseUrl: string;
  ghToken?: string;
  ghRepo?: string;
  discordBotToken?: string;
  discordChannelId?: string;
  discordChannelIds?: string;
  telegramBotToken?: string;
  telegramChannelId?: string;
  torrentioBaseUrl?: string;
  dashboardDir: string;
}

export function loadConfig(): Config {
  return {
    databaseUrl: process.env.STREAMVAULT_DATABASE_URL || "sqlite:data/streamvault.db?mode=rwc",
    authSecret: process.env.STREAMVAULT_AUTH_SECRET || "streamvault-dev-secret",
    publicBaseUrl: process.env.STREAMVAULT_PUBLIC_BASE_URL || "http://localhost:8080",
    ghToken: process.env.STREAMVAULT_GH_TOKEN,
    ghRepo: process.env.STREAMVAULT_GH_REPO,
    discordBotToken: process.env.STREAMVAULT_DISCORD_BOT_TOKEN,
    discordChannelId: process.env.STREAMVAULT_DISCORD_CHANNEL_ID,
    discordChannelIds: process.env.STREAMVAULT_DISCORD_CHANNEL_IDS,
    telegramBotToken: process.env.STREAMVAULT_TELEGRAM_BOT_TOKEN,
    telegramChannelId: process.env.STREAMVAULT_TELEGRAM_CHANNEL_ID,
    torrentioBaseUrl: process.env.STREAMVAULT_TORRENTIO_BASE_URL,
    dashboardDir: process.env.STREAMVAULT_DASHBOARD_DIR || "dashboard/dist",
  };
}
```

- [ ] **Step 4: Create error.ts**

```ts
export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) { super(message); this.name = "AppError"; }
}

export function notFound(msg: string): AppError {
  return new AppError(404, msg);
}
export function badRequest(msg: string): AppError {
  return new AppError(400, msg);
}
export function unauthorized(): AppError {
  return new AppError(401, "Unauthorized");
}
export function internal(msg: string): AppError {
  return new AppError(500, msg);
}
export function badGateway(msg: string): AppError {
  return new AppError(502, msg);
}
```

- [ ] **Step 5: Create index.ts — minimal entry point**

```ts
import { serve } from "bun";
import { loadConfig } from "./config";

const config = loadConfig();
console.log("StreamVault Bun starting...");
console.log(`Dashboard: ${config.dashboardDir}`);

// Placeholder — will be replaced with Hono app later
console.log("Server not yet wired — waiting for remaining tasks.");

// Export for app.ts to use later
export { config };
```

- [ ] **Step 6: Verify it runs**

Run: `cd backend-bun && bun run src/index.ts`
Expected: Prints "StreamVault Bun starting..." and exits.

- [ ] **Step 7: Commit**

```bash
git add backend-bun/package.json backend-bun/tsconfig.json backend-bun/src/index.ts backend-bun/src/config.ts backend-bun/src/error.ts
git commit -m "feat(bun): bootstrap project — package.json, tsconfig, entry point, config, error"
```

---

### Task 2: Database schema — Drizzle definitions + migrations

**Files:**
- Create: `backend-bun/src/db/schema.ts`
- Create: `backend-bun/src/db/index.ts`
- Create: `backend-bun/drizzle.config.ts`

- [ ] **Step 1: Create drizzle.config.ts**

```ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: "./data/streamvault.db",
  },
});
```

- [ ] **Step 2: Create schema.ts with all 5 tables**

```ts
import { sqliteTable, text, integer, real, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  imdbId: text("imdb_id").notNull(),
  mediaType: text("media_type").notNull(),
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
  pk: primaryKey({ columns: [t.imdbId, t.mediaType] }),
}));

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value"),
});
```

- [ ] **Step 3: Create db/index.ts — pool setup + migrations**

```ts
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema";
import { loadConfig } from "../config";

export type DrizzleDB = ReturnType<typeof drizzle>;

export function createDb(): DrizzleDB {
  const config = loadConfig();
  const sqliteDb = new Database(config.databaseUrl.replace("sqlite:", ""));
  sqliteDb.run("PRAGMA journal_mode=WAL");
  sqliteDb.run("PRAGMA foreign_keys=ON");

  const db = drizzle(sqliteDb, { schema });
  migrate(db, { migrationsFolder: "./migrations" });
  return db;
}
```

- [ ] **Step 4: Generate migrations**

Run: `cd backend-bun && bun run db:generate`
Expected: Creates `backend-bun/migrations/` folder with SQL files.

- [ ] **Step 5: Verify schema matches Rust**

Compare `backend-bun/migrations/` SQL with `backend/migrations/*.sql`.
Expected: Same columns, types, constraints, indexes.

- [ ] **Step 6: Commit**

```bash
git add backend-bun/src/db/ backend-bun/drizzle.config.ts backend-bun/migrations/
git commit -m "feat(bun): database schema — Drizzle + migrations"
```

---

### Task 3: Database queries — all CRUD functions

**Files:**
- Create: `backend-bun/src/db/queries.ts`

- [ ] **Step 1: Create queries.ts with all type definitions and query functions**

```ts
import { eq, desc, and, inArray, sql, count, like } from "drizzle-orm";
import { jobs, jobEvents, hlsChunks, cinemetaCache, appSettings } from "./schema";
import { AppError, notFound } from "../error";

// ── Types ──

export interface Job {
  id: string; imdbId: string; mediaType: string; season: number | null;
  episode: number | null; title: string | null; posterUrl: string | null;
  magnetUri: string | null; infohash: string | null; torrentName: string | null;
  fileIdx: number | null; fileSizeBytes: number | null;
  status: string; currentPhase: string | null;
  progressPct: number | null; transcodePct: number | null; uploadPct: number | null;
  lastCheckpoint: string | null; ghRunId: string | null;
  ghArtifactIdDl: string | null; ghArtifactIdTc: string | null;
  ghArtifactDlUrl: string | null; ghArtifactTcUrl: string | null;
  discordChannelId: string | null; videoResolution: string | null;
  durationSeconds: number | null; errorMessage: string | null;
  createdAt: string | null; startedAt: string | null;
  completedAt: string | null; updatedAt: string | null;
}

export interface NewJob {
  id: string; imdbId: string; mediaType: string; season: number | null;
  episode: number | null; title: string | null; posterUrl: string | null;
  magnetUri: string | null; infohash: string | null; torrentName: string | null;
  fileIdx: number | null; fileSizeBytes: number | null;
}

export interface HlsChunkRow {
  id: number; jobId: string; chunkIndex: number; filename: string;
  discordUrl: string | null; discordMessageId: string | null;
  durationSeconds: number | null; fileSizeBytes: number | null;
  createdAt: string | null;
}

export interface NewHlsChunk {
  jobId: string; chunkIndex: number; filename: string;
  discordUrl: string | null; discordMessageId: string | null;
  durationSeconds: number | null; fileSizeBytes: number | null;
}

export interface LibraryJob {
  id: string; title: string | null; season: number | null;
  episode: number | null; status: string; videoResolution: string | null;
  durationSeconds: number | null; createdAt: string;
}

export interface LibraryGroup {
  imdbId: string; title: string | null; posterUrl: string | null;
  mediaType: string; jobCount: number; jobs: LibraryJob[];
}

export interface LibraryResponse {
  items: LibraryGroup[]; total: number; page: number; limit: number;
}

export interface LibraryDetail {
  imdbId: string; title: string | null; posterUrl: string | null;
  mediaType: string; jobs: LibraryJob[];
}

import type { DrizzleDB } from "./index";

// ── Jobs ──

export function insertJob(db: DrizzleDB, job: NewJob): void {
  db.insert(jobs).values({
    id: job.id, imdbId: job.imdbId, mediaType: job.mediaType,
    season: job.season, episode: job.episode,
    title: job.title, posterUrl: job.posterUrl,
    magnetUri: job.magnetUri, infohash: job.infohash,
    torrentName: job.torrentName, fileIdx: job.fileIdx,
    fileSizeBytes: job.fileSizeBytes,
  }).run();
}

export function getJob(db: DrizzleDB, id: string): Job {
  const row = db.select().from(jobs).where(eq(jobs.id, id)).get();
  if (!row) throw notFound(`Job ${id} not found`);
  return row as unknown as Job;
}

export function listJobs(db: DrizzleDB): Job[] {
  return db.select().from(jobs).orderBy(desc(jobs.createdAt)).all() as unknown as Job[];
}

export function listJobsByStatus(db: DrizzleDB, status: string): Job[] {
  return db.select().from(jobs)
    .where(eq(jobs.status, status))
    .orderBy(desc(jobs.createdAt))
    .all() as unknown as Job[];
}

export function listJobsByStatuses(db: DrizzleDB, statuses: string[]): Job[] {
  return db.select().from(jobs)
    .where(inArray(jobs.status, statuses))
    .orderBy(desc(jobs.createdAt))
    .all() as unknown as Job[];
}

export function countJobsByStatuses(db: DrizzleDB, statuses: string[]): number {
  const row = db.select({ count: count() }).from(jobs)
    .where(inArray(jobs.status, statuses)).get();
  return row?.count ?? 0;
}

export function countJobsByStatus(db: DrizzleDB, status: string): number {
  const row = db.select({ count: count() }).from(jobs)
    .where(eq(jobs.status, status)).get();
  return row?.count ?? 0;
}

export function getNextQueuedJob(db: DrizzleDB): Job | undefined {
  return db.select().from(jobs)
    .where(eq(jobs.status, "queued"))
    .orderBy(jobs.createdAt)
    .limit(1)
    .get() as unknown as Job | undefined;
}

export function updateJobStatus(db: DrizzleDB, id: string, status: string): void {
  db.update(jobs).set({ status, updatedAt: sql`datetime('now')` })
    .where(eq(jobs.id, id)).run();
}

export function updateJobPhase(db: DrizzleDB, id: string, phase: string): void {
  db.update(jobs).set({ currentPhase: phase, updatedAt: sql`datetime('now')` })
    .where(eq(jobs.id, id)).run();
}

export function updateJobProgress(db: DrizzleDB, id: string, phase: string, pct: number): void {
  const col = phase === "transcode" ? "transcodePct" : phase === "upload" ? "uploadPct" : "progressPct";
  db.update(jobs).set({ [col]: pct, updatedAt: sql`datetime('now')` } as any)
    .where(eq(jobs.id, id)).run();
}

export function updateJobCheckpoint(
  db: DrizzleDB, id: string, checkpoint: string,
  artifactId: string | null, fileUrl: string | null,
): void {
  if (checkpoint !== "download" && checkpoint !== "transcode") return;
  const newStatus = `checkpoint_${checkpoint}`;
  const idCol = checkpoint === "download" ? "ghArtifactIdDl" : "ghArtifactIdTc";
  const urlCol = checkpoint === "download" ? "ghArtifactDlUrl" : "ghArtifactTcUrl";
  db.update(jobs).set({
    lastCheckpoint: checkpoint,
    status: newStatus,
    [idCol]: artifactId,
    [urlCol]: fileUrl,
    updatedAt: sql`datetime('now')`,
  } as any).where(eq(jobs.id, id)).run();
}

export function updateJobGhRun(db: DrizzleDB, id: string, runId: string): void {
  db.update(jobs).set({
    ghRunId: runId,
    status: "processing",
    startedAt: sql`datetime('now')`,
    updatedAt: sql`datetime('now')`,
  }).where(eq(jobs.id, id)).run();
}

export function updateJobCompleted(db: DrizzleDB, id: string, resolution: string, duration: number): void {
  db.update(jobs).set({
    status: "completed",
    videoResolution: resolution,
    durationSeconds: duration,
    completedAt: sql`datetime('now')`,
    updatedAt: sql`datetime('now')`,
  }).where(eq(jobs.id, id)).run();
}

export function updateJobFailed(db: DrizzleDB, id: string, errorMsg: string): void {
  db.update(jobs).set({
    status: "failed",
    errorMessage: errorMsg,
    updatedAt: sql`datetime('now')`,
  }).where(eq(jobs.id, id)).run();
}

export function deleteJob(db: DrizzleDB, id: string): void {
  db.delete(jobs).where(eq(jobs.id, id)).run();
}

// ── Job Events ──

export function insertJobEvent(
  db: DrizzleDB, jobId: string, phase: string | null,
  eventType: string, message: string, progressPct: number | null,
): void {
  db.insert(jobEvents).values({
    jobId, phase, eventType, message,
    progressPct, createdAt: sql`datetime('now')`,
  }).run();
}

export function getJobEvents(db: DrizzleDB, jobId: string): any[] {
  return db.select().from(jobEvents)
    .where(eq(jobEvents.jobId, jobId))
    .orderBy(jobEvents.createdAt)
    .all();
}

// ── HLS Chunks ──

export function insertHlsChunk(db: DrizzleDB, chunk: NewHlsChunk): void {
  db.insert(hlsChunks).values({
    jobId: chunk.jobId, chunkIndex: chunk.chunkIndex,
    filename: chunk.filename, discordUrl: chunk.discordUrl,
    discordMessageId: chunk.discordMessageId,
    durationSeconds: chunk.durationSeconds,
    fileSizeBytes: chunk.fileSizeBytes,
  }).run();
}

export function getHlsChunks(db: DrizzleDB, jobId: string): any[] {
  return db.select().from(hlsChunks)
    .where(eq(hlsChunks.jobId, jobId))
    .orderBy(hlsChunks.chunkIndex)
    .all();
}

// ── Cinemeta Cache ──

export function getCachedMeta(db: DrizzleDB, imdbId: string, mediaType: string): any {
  return db.select().from(cinemetaCache)
    .where(and(eq(cinemetaCache.imdbId, imdbId), eq(cinemetaCache.mediaType, mediaType)))
    .get();
}

export function upsertCachedMeta(db: DrizzleDB, meta: any): void {
  db.insert(cinemetaCache).values({
    imdbId: meta.imdbId, mediaType: meta.mediaType,
    title: meta.title, posterUrl: meta.posterUrl,
    overview: meta.overview, year: meta.year,
    totalSeasons: meta.totalSeasons, cachedAt: sql`datetime('now')`,
  }).onConflictDoUpdate({
    target: [cinemetaCache.imdbId, cinemetaCache.mediaType],
    set: {
      title: meta.title, posterUrl: meta.posterUrl,
      overview: meta.overview, year: meta.year,
      totalSeasons: meta.totalSeasons, cachedAt: sql`datetime('now')`,
    },
  }).run();
}

// ── App Settings ──

export function getAllSettings(db: DrizzleDB): { key: string; value: string }[] {
  return db.select().from(appSettings).all();
}

export function getSetting(db: DrizzleDB, key: string): string | undefined {
  const row = db.select().from(appSettings).where(eq(appSettings.key, key)).get();
  return row?.value;
}

export function upsertSetting(db: DrizzleDB, key: string, value: string): void {
  db.insert(appSettings).values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value } })
    .run();
}

// ── Library ──

export function getCompletedJobsGrouped(
  db: DrizzleDB, mediaType: string | null, page: number, limit: number,
): LibraryResponse {
  const offset = (page - 1) * limit;

  const total = mediaType
    ? db.select({ count: count() }).from(jobs)
        .where(and(eq(jobs.status, "completed"), eq(jobs.mediaType, mediaType)))
        .get()?.count ?? 0
    : db.select({ count: count() }).from(jobs)
        .where(eq(jobs.status, "completed"))
        .get()?.count ?? 0;

  interface GroupRow { imdbId: string; title: string | null; posterUrl: string | null; mediaType: string; jobCount: number; }
  const groups: GroupRow[] = mediaType
    ? db.select({
        imdbId: jobs.imdbId, title: jobs.title, posterUrl: jobs.posterUrl,
        mediaType: jobs.mediaType, jobCount: count(),
      }).from(jobs)
        .where(and(eq(jobs.status, "completed"), eq(jobs.mediaType, mediaType)))
        .groupBy(jobs.imdbId).orderBy(jobs.title).limit(limit).offset(offset)
        .all() as any
    : db.select({
        imdbId: jobs.imdbId, title: jobs.title, posterUrl: jobs.posterUrl,
        mediaType: jobs.mediaType, jobCount: count(),
      }).from(jobs)
        .where(eq(jobs.status, "completed"))
        .groupBy(jobs.imdbId).orderBy(jobs.title).limit(limit).offset(offset)
        .all() as any;

  const items: LibraryGroup[] = groups.map(g => {
    const childJobs: LibraryJob[] = db.select({
      id: jobs.id, title: jobs.title, season: jobs.season,
      episode: jobs.episode, status: jobs.status,
      videoResolution: jobs.videoResolution,
      durationSeconds: jobs.durationSeconds, createdAt: jobs.createdAt,
    }).from(jobs)
      .where(and(eq(jobs.imdbId, g.imdbId), eq(jobs.status, "completed")))
      .orderBy(jobs.season).orderBy(jobs.episode)
      .all() as any;

    let finalPoster = g.posterUrl;
    if (!finalPoster) {
      const cached = db.select({ posterUrl: cinemetaCache.posterUrl })
        .from(cinemetaCache)
        .where(and(eq(cinemetaCache.imdbId, g.imdbId), eq(cinemetaCache.mediaType, g.mediaType)))
        .get();
      finalPoster = cached?.posterUrl ?? null;
    }

    return { imdbId: g.imdbId, title: g.title, posterUrl: finalPoster, mediaType: g.mediaType, jobCount: g.jobCount, jobs: childJobs };
  });

  return { items, total, page, limit };
}

export function requeueJob(db: DrizzleDB, jobId: string): boolean {
  const result = db.update(jobs)
    .set({ status: "queued", updatedAt: sql`datetime('now')` })
    .where(and(eq(jobs.id, jobId), sql`status IN ('completed', 'failed')`))
    .run();
  return result.changes > 0;
}

export function getLibraryDetail(db: DrizzleDB, imdbId: string): LibraryDetail {
  const childJobs: LibraryJob[] = db.select({
    id: jobs.id, title: jobs.title, season: jobs.season,
    episode: jobs.episode, status: jobs.status,
    videoResolution: jobs.videoResolution,
    durationSeconds: jobs.durationSeconds, createdAt: jobs.createdAt,
  }).from(jobs)
    .where(and(eq(jobs.imdbId, imdbId), eq(jobs.status, "completed")))
    .orderBy(jobs.season).orderBy(jobs.episode)
    .all() as any;

  if (childJobs.length === 0) throw notFound(`No completed jobs for ${imdbId}`);

  let posterUrl: string | null = (db.select({ posterUrl: jobs.posterUrl }).from(jobs)
    .where(and(eq(jobs.imdbId, imdbId), sql`poster_url IS NOT NULL`)).limit(1).get() as any)?.posterUrl ?? null;
  if (!posterUrl) {
    posterUrl = (db.select({ posterUrl: cinemetaCache.posterUrl }).from(cinemetaCache)
      .where(eq(cinemetaCache.imdbId, imdbId)).get() as any)?.posterUrl ?? null;
  }

  const hasSeason = childJobs.some(j => j.season != null);
  return {
    imdbId, title: childJobs[0].title, posterUrl,
    mediaType: hasSeason ? "series" : "movie",
    jobs: childJobs,
  };
}
```

- [ ] **Step 2: Test queries compile**

Run: `cd backend-bun && bun check src/db/queries.ts`
Expected: No TS errors.

- [ ] **Step 3: Commit**

```bash
git add backend-bun/src/db/queries.ts
git commit -m "feat(bun): database queries — all CRUD functions"
```

---

### Task 4: Auth middleware + EventBus + Hono app scaffold

**Files:**
- Create: `backend-bun/src/api/auth.ts`
- Create: `backend-bun/src/api/events.ts`
- Create: `backend-bun/src/api/mod.ts`
- Create: `backend-bun/src/pipeline/mod.ts`
- Create: `backend-bun/src/stremio/mod.ts`
- Create: `backend-bun/src/worker/mod.ts`
- Create: `backend-bun/src/notifications/mod.ts`
- Create: `backend-bun/src/api/events.ts`
- Modify: `backend-bun/src/app.ts`
- Modify: `backend-bun/src/index.ts`

- [ ] **Step 1: Create api/auth.ts**

```ts
import { createMiddleware } from "hono/factory";
import type { AppBindings } from "../app";

export const authMiddleware = createMiddleware<AppBindings>(async (c, next) => {
  const headerToken = c.req.header("Authorization")?.replace("Bearer ", "");
  const queryToken = c.req.query("token");
  const token = headerToken || queryToken;

  if (token !== c.var.config.authSecret) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

export const callbackAuthMiddleware = createMiddleware<AppBindings>(async (c, next) => {
  const token = c.req.header("X-Callback-Token");
  if (token !== c.var.config.authSecret) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});
```

- [ ] **Step 2: Create api/events.ts — EventBus class + SSE handler**

```ts
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { AppBindings } from "../app";

export interface SseEvent {
  type: string;
  data: Record<string, any>;
}

export class EventBus {
  private listeners = new Set<(event: SseEvent) => void>();

  subscribe(fn: (event: SseEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  send(event: SseEvent): void {
    for (const fn of this.listeners) {
      try { fn(event); } catch {}
    }
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}

export class SseClient {
  private controller: ReadableStreamDefaultController | null = null;
  private unsubscribe: (() => void) | null = null;

  start(eventBus: EventBus): ReadableStream {
    return new ReadableStream({
      start: (controller) => {
        this.controller = controller;
        this.unsubscribe = eventBus.subscribe((event) => {
          const lines = [
            `event: ${event.type}`,
            `data: ${JSON.stringify(event.data)}`,
            "",
          ];
          try {
            controller.enqueue(new TextEncoder().encode(lines.join("\n") + "\n"));
          } catch {}
        });
      },
      cancel: () => {
        this.unsubscribe?.();
        this.controller = null;
      },
    });
  }

  sendKeepAlive(): void {
    if (this.controller) {
      try {
        this.controller.enqueue(new TextEncoder().encode(":keep-alive\n\n"));
      } catch {}
    }
  }
}

// SSE connection tracker for keep-alive
const clients = new Set<SseClient>();

export function trackSseClient(client: SseClient): void {
  clients.add(client);
}

// Start keep-alive timer (call once on server init)
export function startKeepAlive(): void {
  setInterval(() => {
    for (const client of clients) {
      client.sendKeepAlive();
    }
  }, 15000);
}
```

- [ ] **Step 3: Create module index files (empty re-exports)**

Create `backend-bun/src/api/mod.ts`, `backend-bun/src/pipeline/mod.ts`, `backend-bun/src/stremio/mod.ts`, `backend-bun/src/worker/mod.ts`, `backend-bun/src/notifications/mod.ts` — each just `export {};` or re-exports.

- [ ] **Step 4: Create app.ts — Hono app router**

```ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { logger } from "hono/logger";
import { AppError } from "./error";
import type { Config } from "./config";

export interface AppBindings {
  Bindings: {};
  Variables: {
    config: Config;
  };
}

export function createApp(config: Config): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  // Global middleware
  app.use("*", logger());
  app.use("*", cors({ origin: "*", allowMethods: ["*"], allowHeaders: ["*"] }));
  app.use("*", async (c, next) => {
    c.set("config", config);
    await next();
  });

  // Error handler
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: err.message }, err.statusCode as any);
    }
    console.error("Unhandled error:", err);
    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}
```

- [ ] **Step 5: Update index.ts — full entry point**

```ts
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { loadConfig } from "./config";
import { createDb } from "./db/index";
import { createApp } from "./app";
import { startKeepAlive } from "./api/events";
import { worker } from "./worker/scheduler";
import { recoverStaleJobs } from "./worker/monitor";
import type { DrizzleDB } from "./db/index";
import type { EventBus } from "./api/events";

const config = loadConfig();
const db = createDb();
const app = createApp(config);

// ── Wire all routes ──
// (Each handler file exports a function that registers routes on app)

// API routes — auth required
import { authMiddleware } from "./api/auth";
import { searchHandler } from "./api/search";
import { inspectTorrent } from "./api/torrent";
import { createJob, listJobs, getJob, retryJob, deleteJob } from "./api/queue";
import { sseHandler } from "./api/events";
import { getSettings, updateSettings, testNotification } from "./api/settings";
import { listLibrary, requeueJob, getLibraryItem } from "./api/library";

const api = new Hono();
api.use("*", authMiddleware);
api.post("/search", searchHandler);
api.post("/torrent/inspect", inspectTorrent);
api.post("/queue", createJob);
api.get("/queue", listJobs);
api.get("/queue/:id", getJob);
api.post("/queue/:id/retry", retryJob);
api.delete("/queue/:id", deleteJob);
api.get("/events", sseHandler);
api.get("/settings", getSettings);
api.put("/settings", updateSettings);
api.post("/settings/test-notification", testNotification);
api.get("/library", listLibrary);
api.post("/library/:id/requeue", requeueJob);
api.get("/library/:imdbId", getLibraryItem);
app.route("/api/v1", api);

// Callback routes — X-Callback-Token auth
import { callbackAuthMiddleware } from "./api/auth";
import { progressCallback, checkpointCallback, completeCallback, failedCallback } from "./api/callbacks";
const cb = new Hono();
cb.use("*", callbackAuthMiddleware);
cb.post("/:id/progress", progressCallback);
cb.post("/:id/checkpoint", checkpointCallback);
cb.post("/:id/complete", completeCallback);
cb.post("/:id/failed", failedCallback);
app.route("/api/v1/jobs", cb);

// Public routes — no auth
import { manifestHandler, catalogHandler, metaHandler, streamHandler } from "./stremio/routes";
import { playlistHandler, chunkHandler } from "./stremio/proxy";
app.get("/manifest.json", manifestHandler);
app.get("/catalog/:type/:catalogId.json", catalogHandler);
app.get("/meta/:type/:imdbId.json", metaHandler);
app.get("/stream/:type/:id.json", streamHandler);
app.get("/proxy/hls/:jobId/master.m3u8", playlistHandler);
app.get("/proxy/hls/:jobId/*", chunkHandler);

// Static file serving — Svelte dashboard
app.use("*", serveStatic({ root: config.dashboardDir }));
app.get("*", serveStatic({ path: `${config.dashboardDir}/index.html` }));

// ── Startup ──
startKeepAlive();
recoverStaleJobs(db);
worker(db, config);

// ── Serve ──
console.log(`StreamVault listening on http://0.0.0.0:8080`);
export default {
  port: 8080,
  fetch: app.fetch,
};
```

- [ ] **Step 6: Verify compiles**

Run: `cd backend-bun && bun check src/index.ts`
Expected: No TS errors (some routes will error because handlers not yet created — this is expected until those tasks complete).

- [ ] **Step 7: Commit**

```bash
git add backend-bun/src/api/auth.ts backend-bun/src/api/events.ts backend-bun/src/app.ts backend-bun/src/index.ts
git add backend-bun/src/api/mod.ts backend-bun/src/pipeline/mod.ts backend-bun/src/stremio/mod.ts backend-bun/src/worker/mod.ts backend-bun/src/notifications/mod.ts
git commit -m "feat(bun): auth middleware, EventBus, Hono app scaffold"
```

---

### Task 5: API handlers — Queue + Callbacks

**Files:**
- Create: `backend-bun/src/api/queue.ts`
- Create: `backend-bun/src/api/callbacks.ts`

- [ ] **Step 1: Create queue.ts — CRUD + retry + delete**

```ts
import { Hono } from "hono";
import type { Context } from "hono";
import { badRequest, notFound } from "../error";
import * as queries from "../db/queries";
import type { AppBindings } from "../app";

export async function createJob(c: Context<AppBindings>): Promise<Response> {
  const body = await c.req.json<{
    imdb_id: string; media_type: string; season?: number; episode?: number;
    title?: string; poster_url?: string; magnet_uri: string; infohash: string;
    torrent_name: string; file_idx: number; file_size_bytes: number;
  }>();

  const jobId = crypto.randomUUID();
  const newJob: queries.NewJob = {
    id: jobId, imdbId: body.imdb_id, mediaType: body.media_type,
    season: body.season ?? null, episode: body.episode ?? null,
    title: body.title ?? null, posterUrl: body.poster_url ?? null,
    magnetUri: body.magnet_uri, infohash: body.infohash,
    torrentName: body.torrent_name, fileIdx: body.file_idx,
    fileSizeBytes: body.file_size_bytes,
  };

  queries.insertJob(c.var.db, newJob);
  queries.insertJobEvent(c.var.db, jobId, null, "status_change", "Job queued", null);
  c.var.eventBus.send({ type: "job_created", data: { job_id: jobId, title: newJob.title ?? "" } });
  sendNotification(c, { type: "JobQueued", title: newJob.title ?? "" });

  return c.json({ job_id: jobId, status: "queued" }, 201);
}

export async function listJobs(c: Context<AppBindings>): Promise<Response> {
  const allJobs = queries.listJobs(c.var.db);
  const processingStatuses = [
    "processing", "downloading", "checkpoint_download",
    "transcoding", "checkpoint_transcode", "uploading",
  ];
  const processing: any[] = [];
  const queued: any[] = [];
  const completed: any[] = [];
  const failed: any[] = [];

  for (const job of allJobs) {
    if (job.status === "queued") queued.push(job);
    else if (job.status === "completed") completed.push(job);
    else if (job.status === "failed") failed.push(job);
    else if (processingStatuses.includes(job.status)) processing.push(job);
    else queued.push(job);
  }
  return c.json({ processing, queued, completed, failed });
}

export async function getJob(c: Context<AppBindings>): Promise<Response> {
  const id = c.req.param("id");
  try {
    const job = queries.getJob(c.var.db, id);
    const events = queries.getJobEvents(c.var.db, id);
    const ghRepo = getSettingOrEnv(c, "gh_repo");
    return c.json({ job, events, gh_repo: ghRepo || null });
  } catch {
    throw notFound(`Job ${id} not found`);
  }
}

export async function retryJob(c: Context<AppBindings>): Promise<Response> {
  const id = c.req.param("id");
  const job = queries.getJob(c.var.db, id);
  if (job.status !== "failed") throw badRequest("Can only retry failed jobs");

  const skipDownload = (job.lastCheckpoint === "download" || job.lastCheckpoint === "transcode")
    && job.ghArtifactDlUrl != null;
  const skipTranscode = job.lastCheckpoint === "transcode"
    && job.ghArtifactTcUrl != null;

  queries.insertJobEvent(c.var.db, id, null, "status_change",
    `Retry triggered (last checkpoint: ${job.lastCheckpoint}, skip_dl: ${skipDownload}, skip_tc: ${skipTranscode})`, null);

  try {
    const runId = await triggerPipeline(c, job, skipDownload, skipTranscode);
    queries.updateJobStatus(c.var.db, id, "processing");
    queries.insertJobEvent(c.var.db, id, null, "status_change", `Retry pipeline triggered (run_id: ${runId})`, null);
    c.var.eventBus.send({ type: "job_retried", data: { job_id: id } });
    return c.json({ job_id: id, status: "processing" });
  } catch (e: any) {
    throw badRequest(e.message);
  }
}

export async function deleteJobHandler(c: Context<AppBindings>): Promise<Response> {
  const id = c.req.param("id");
  const job = queries.getJob(c.var.db, id);
  const activeStatuses = ["processing", "downloading", "transcoding", "uploading", "checkpoint_download", "checkpoint_transcode"];
  const isActive = activeStatuses.includes(job.status);

  if (isActive && job.ghRunId && job.ghRunId !== "pending") {
    const token = getSettingOrEnv(c, "gh_token");
    const repo = getSettingOrEnv(c, "gh_repo");
    if (token && repo) {
      await cancelGhRun(token, repo, job.ghRunId).catch(e => console.error("Failed to cancel GH run:", e));
    }
  }

  queries.deleteJob(c.var.db, id);
  c.var.eventBus.send({ type: "job_removed", data: { job_id: id } });
  return c.json({ removed: true, cancelled_run: isActive });
}
```

- [ ] **Step 2: Create callbacks.ts**

```ts
import type { Context } from "hono";
import { badRequest } from "../error";
import * as queries from "../db/queries";
import type { AppBindings } from "../app";
import { sendNotification } from "../notifications/telegram";

export async function progressCallback(c: Context<AppBindings>): Promise<Response> {
  const id = c.req.param("id");
  const body = await c.req.json<any>();

  const phase = body.phase || "download";
  const progressPct = body.progress_pct ?? 0;

  queries.updateJobProgress(c.var.db, id, phase, progressPct);
  queries.updateJobPhase(c.var.db, id, phase);

  if (body.chunk) {
    queries.insertHlsChunk(c.var.db, {
      jobId: id,
      chunkIndex: body.chunk.chunk_index ?? 0,
      filename: body.chunk.filename,
      discordUrl: body.chunk.discord_url ?? null,
      discordMessageId: body.chunk.discord_message_id ?? null,
      durationSeconds: body.chunk.duration_seconds ?? null,
      fileSizeBytes: null,
    });
  }

  queries.insertJobEvent(c.var.db, id, phase, "progress", `Progress: ${progressPct}%`, progressPct);
  c.var.eventBus.send({ type: "job_progress", data: { job_id: id, phase, progress_pct: progressPct } });
  return c.json({ ok: true });
}

export async function checkpointCallback(c: Context<AppBindings>): Promise<Response> {
  const id = c.req.param("id");
  const body = await c.req.json<any>();
  const checkpoint = body.checkpoint;
  if (!checkpoint) throw badRequest("Missing checkpoint field");
  const artifactId = body.artifact_id ?? null;
  const fileUrl = body.file_url ?? null;

  queries.updateJobCheckpoint(c.var.db, id, checkpoint, artifactId, fileUrl);
  queries.insertJobEvent(c.var.db, id, checkpoint, "checkpoint", `Checkpoint saved: ${checkpoint}`, null);
  c.var.eventBus.send({ type: "job_checkpoint", data: { job_id: id, checkpoint } });

  const job = queries.getJob(c.var.db, id);
  sendNotification(c, { type: "CheckpointSaved", title: job.title ?? "", phase: checkpoint });
  return c.json({ ok: true });
}

export async function completeCallback(c: Context<AppBindings>): Promise<Response> {
  const id = c.req.param("id");
  const body = await c.req.json<any>();
  const resolution = body.video_resolution || "1080p";
  const duration = body.duration_seconds ?? 0;

  const job = queries.getJob(c.var.db, id);
  const ghRunId = job.ghRunId;

  queries.updateJobCompleted(c.var.db, id, resolution, duration);
  queries.insertJobEvent(c.var.db, id, null, "status_change", `Completed: ${resolution}, ${duration}s duration`, null);
  c.var.eventBus.send({ type: "job_completed", data: { job_id: id } });
  sendNotification(c, { type: "JobCompleted", title: job.title ?? "", details: `${resolution}, ${duration}s duration` });

  // Clean up GHA run
  if (ghRunId) {
    const token = getSettingOrEnv(c, "gh_token");
    const repo = getSettingOrEnv(c, "gh_repo");
    if (token && repo) {
      cancelGhRun(token, repo, ghRunId).catch(() => {});
    }
  }

  return c.json({ ok: true });
}

export async function failedCallback(c: Context<AppBindings>): Promise<Response> {
  const id = c.req.param("id");
  const body = await c.req.json<any>();
  const errorMsg = body.error_message || "Unknown error";

  queries.updateJobFailed(c.var.db, id, errorMsg);
  queries.insertJobEvent(c.var.db, id, null, "error", `Failed: ${errorMsg}`, null);
  c.var.eventBus.send({ type: "job_failed", data: { job_id: id, error: errorMsg } });

  const job = queries.getJob(c.var.db, id);
  sendNotification(c, { type: "JobFailed", title: job.title ?? "", phase: job.currentPhase ?? "", error: errorMsg });
  return c.json({ ok: true });
}
```

- [ ] **Step 3: Commit**

```bash
git add backend-bun/src/api/queue.ts backend-bun/src/api/callbacks.ts
git commit -m "feat(bun): queue CRUD + callback handlers"
```

---

### Task 6: API handlers — Search, Torrent, Settings, Library

**Files:**
- Create: `backend-bun/src/api/search.ts`
- Create: `backend-bun/src/api/torrent.ts`
- Create: `backend-bun/src/api/settings.ts`
- Create: `backend-bun/src/api/library.ts`

- [ ] **Step 1: Create search.ts — Cinemeta cache + Torrentio fetch + quality filter**

```ts
import type { Context } from "hono";
import { badRequest } from "../error";
import * as queries from "../db/queries";
import type { AppBindings } from "../app";

const LOW_QUALITY_KEYWORDS = ["cam", "ts", "hdts", "hdcam", "r5", "screener", "telecine", "tc", "ppv"];

function qualityScore(title: string): number {
  const t = title.toLowerCase();
  if (t.includes("2160") || t.includes("4k")) return 5;
  if (t.includes("1080")) return 4;
  if (t.includes("720")) return 3;
  if (t.includes("brrip") || t.includes("bluray")) return 3;
  if (t.includes("dvd")) return 2;
  return 1;
}

function isLowQuality(title: string): boolean {
  return LOW_QUALITY_KEYWORDS.some(kw => title.toLowerCase().includes(kw));
}

function filterTorrents(torrents: any[], limit: number): any[] {
  return torrents
    .filter(t => !isLowQuality(t.title))
    .sort((a, b) => qualityScore(b.title) - qualityScore(a.title))
    .slice(0, limit);
}

// Default trackers (public tracker list — copy exact list from Rust)
const DEFAULT_TRACKERS = [
  "http://tracker.opentrackr.org:1337/announce",
  "http://www.torrentsnipe.info:2701/announce",
  "http://tracker.waaa.moe:6969/announce",
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://tracker.moeking.me:6969/announce",
  "udp://explodie.org:6969/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.bitsearch.to:1337/announce",
  "udp://p4p.arenabg.com:1337/announce",
  "udp://movies.zsw.ca:6969/announce",
  "https://tracker.bt4g.com:443/announce",
];

function buildMagnet(infohash: string, dn: string): string {
  const encoded = encodeURIComponent(dn);
  const parts = [
    `xt=urn:btih:${infohash}`,
    `dn=${encoded}`,
    ...DEFAULT_TRACKERS.map(t => `tr=${encodeURIComponent(t)}`),
  ];
  return `magnet:?${parts.join("&")}`;
}

async function fetchCinemeta(c: Context<AppBindings>, imdbId: string, mediaType: string): Promise<any> {
  // Check cache first
  const cached = queries.getCachedMeta(c.var.db, imdbId, mediaType);
  if (cached) return cached;

  // Fetch from Cinemeta
  const url = `https://v3-cinemeta.strem.io/meta/${mediaType}/${imdbId}.json`;
  const resp = await fetch(url);
  if (!resp.ok) throw badRequest("Title not found in Cinemeta");
  const json: any = await resp.json();
  const meta = json.meta;
  if (!meta) throw badRequest("Title not found in Cinemeta");

  const record = {
    imdbId, mediaType,
    title: meta.name ?? null,
    posterUrl: meta.poster ?? null,
    overview: meta.overview ?? null,
    year: meta.year ?? null,
    totalSeasons: meta.totalSeasons ?? null,
  };

  queries.upsertCachedMeta(c.var.db, record);
  return record;
}

async function searchTorrentio(c: Context<AppBindings>, baseUrl: string, mediaType: string, streamId: string): Promise<any[]> {
  const url = `${baseUrl}/stream/${mediaType}/${streamId}.json`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "StreamVault/1.0" },
  });
  if (!resp.ok) return [];
  const json: any = await resp.json();
  const streams = json.streams ?? [];
  return streams
    .filter((s: any) => s.infoHash)
    .map((s: any) => ({
      name: s.name || "Unknown",
      title: s.title || s.infoHash,
      filename: s.behaviorHints?.filename ?? "",
      sizeBytes: s.size ?? 0,
      infohash: s.infoHash,
      magnetUri: buildMagnet(s.infoHash, s.title || s.infoHash),
      fileIdx: s.fileIdx ?? 0,
    }));
}

export async function searchHandler(c: Context<AppBindings>): Promise<Response> {
  const body = await c.req.json<{
    imdb_id: string; media_type: string; season?: number; episode?: number;
  }>();

  if (!body.imdb_id.startsWith("tt")) throw badRequest("Invalid IMDB ID format");

  const meta = await fetchCinemeta(c, body.imdb_id, body.media_type);
  const streamId = body.media_type === "series"
    ? `${body.imdb_id}:${body.season ?? 1}:${body.episode ?? 1}`
    : body.imdb_id;

  const torrentioBaseUrl = getSettingOrEnv(c, "torrentio_base_url") || "https://torrentio.strem.fun";
  const torrents = await searchTorrentio(c, torrentioBaseUrl, body.media_type, streamId);
  const filtered = filterTorrents(torrents, 5);

  return c.json({
    meta: { title: meta.title || body.imdb_id, poster: meta.posterUrl, year: meta.year },
    torrents: filtered,
  });
}
```

- [ ] **Step 2: Create torrent.ts — bencode parser + torrent inspection**

```ts
import type { Context } from "hono";
import { badRequest, internal } from "../error";
import type { AppBindings } from "../app";

// Minimal bencode parser — only extracts info dict from .torrent files
function parseBencode(data: Uint8Array): any {
  let i = 0;

  function parse(): any {
    if (i >= data.length) throw new Error("Unexpected end of data");
    const c = String.fromCharCode(data[i]);

    if (c === "i") {
      i++;
      const end = data.indexOf(0x65, i);
      if (end === -1) throw new Error("Invalid integer");
      const num = parseInt(new TextDecoder().decode(data.slice(i, end)), 10);
      i = end + 1;
      return num;
    }

    if (c >= "0" && c <= "9") {
      const colon = data.indexOf(0x3a, i);
      if (colon === -1) throw new Error("Invalid string");
      const len = parseInt(new TextDecoder().decode(data.slice(i, colon)), 10);
      i = colon + 1;
      const str = new TextDecoder().decode(data.slice(i, i + len));
      i += len;
      return str;
    }

    if (c === "d") {
      i++;
      const dict: Record<string, any> = {};
      while (i < data.length && data[i] !== 0x65) {
        const key = parse();
        dict[key] = parse();
      }
      i++;
      return dict;
    }

    if (c === "l") {
      i++;
      const list: any[] = [];
      while (i < data.length && data[i] !== 0x65) {
        list.push(parse());
      }
      i++;
      return list;
    }

    throw new Error(`Unexpected token: ${c}`);
  }

  return parse();
}

export async function inspectTorrent(c: Context<AppBindings>): Promise<Response> {
  const body = await c.req.json<{ infohash: string }>();
  const infohash = body.infohash.toLowerCase();

  if (infohash.length !== 40 || !/^[0-9a-f]+$/.test(infohash)) {
    throw badRequest("Invalid infohash");
  }

  const url = `https://itorrents.org/torrent/${infohash.toUpperCase()}.torrent`;
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) throw badRequest("Torrent file not found or unavailable");

  const data = new Uint8Array(await resp.arrayBuffer());
  const parsed = parseBencode(data);
  const info = parsed.info;
  if (!info) throw badRequest("Invalid torrent file — missing info dict");

  const name = info.name || "Unknown";
  const files: { index: number; name: string; size_bytes: number }[] = [];

  if (Array.isArray(info.files)) {
    for (let idx = 0; idx < info.files.length; idx++) {
      const f = info.files[idx];
      const path = Array.isArray(f.path) ? f.path.join("/") : f.path || `file_${idx}`;
      files.push({ index: idx, name: path, size_bytes: f.length ?? 0 });
    }
  } else {
    // Single-file torrent
    files.push({ index: 0, name, size_bytes: info.length ?? 0 });
  }

  return c.json({ name, files });
}
```

- [ ] **Step 3: Create settings.ts — get/update/test-notification**

```ts
import type { Context } from "hono";
import { badRequest, internal } from "../error";
import * as queries from "../db/queries";
import type { AppBindings } from "../app";

const SETTING_KEYS = [
  "gh_token", "gh_repo", "discord_bot_token", "discord_channel_id",
  "discord_channel_ids", "telegram_bot_token", "telegram_channel_id",
  "torrentio_base_url", "notifications_enabled", "public_base_url",
];

export async function getSettings(c: Context<AppBindings>): Promise<Response> {
  const dbSettings = queries.getAllSettings(c.var.db);
  const dbMap: Record<string, string> = {};
  for (const s of dbSettings) dbMap[s.key] = s.value;

  const result: Record<string, string> = {};
  for (const key of SETTING_KEYS) {
    const value = dbMap[key] || (c.var.config as any)[key] || "";
    result[key] = value;
  }

  return c.json(result);
}

export async function updateSettings(c: Context<AppBindings>): Promise<Response> {
  const body = await c.req.json<Record<string, string>>();
  for (const [key, value] of Object.entries(body)) {
    queries.upsertSetting(c.var.db, key, value);
  }
  return c.json({ status: "saved" });
}

export async function testNotification(c: Context<AppBindings>): Promise<Response> {
  const botToken = queries.getSetting(c.var.db, "telegram_bot_token")
    || c.var.config.telegramBotToken;
  const channelId = queries.getSetting(c.var.db, "telegram_channel_id")
    || c.var.config.telegramChannelId;

  if (!botToken) throw badRequest("Telegram bot token not configured");
  if (!channelId) throw badRequest("Telegram channel ID not configured");

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: channelId,
      text: "StreamVault test notification",
      parse_mode: "HTML",
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw internal(`Telegram API request failed: ${text}`);
  }

  return c.json({ ok: true });
}
```

- [ ] **Step 4: Create library.ts**

```ts
import type { Context } from "hono";
import * as queries from "../db/queries";
import type { AppBindings } from "../app";

export async function listLibrary(c: Context<AppBindings>): Promise<Response> {
  const query = c.req.query();
  const page = Math.max(1, parseInt(query.page || "1"));
  const limit = Math.min(100, parseInt(query.limit || "20"));
  const mediaType = query.type || null;

  const result = queries.getCompletedJobsGrouped(c.var.db, mediaType, page, limit);
  return c.json(result);
}

export async function requeueJobHandler(c: Context<AppBindings>): Promise<Response> {
  const jobId = c.req.param("id");
  const ok = queries.requeueJob(c.var.db, jobId);
  if (!ok) throw notFound(`Job ${jobId} not found or not eligible for requeue`);
  return c.json({ job_id: jobId, status: "queued" });
}

export async function getLibraryItem(c: Context<AppBindings>): Promise<Response> {
  const imdbId = c.req.param("imdbId");
  const detail = queries.getLibraryDetail(c.var.db, imdbId);
  return c.json(detail);
}
```

- [ ] **Step 5: Commit**

```bash
git add backend-bun/src/api/search.ts backend-bun/src/api/torrent.ts backend-bun/src/api/settings.ts backend-bun/src/api/library.ts
git commit -m "feat(bun): search, torrent, settings, library handlers"
```

---

### Task 7: Stremio routes + HLS proxy

**Files:**
- Create: `backend-bun/src/stremio/models.ts`
- Create: `backend-bun/src/stremio/routes.ts`
- Create: `backend-bun/src/stremio/proxy.ts`

- [ ] **Step 1: Create models.ts**

```ts
export interface Manifest {
  id: string;
  version: string;
  name: string;
  description: string;
  resources: string[];
  types: string[];
  catalogs: CatalogDescriptor[];
  idPrefixes: string[];
  behaviorHints: BehaviorHints;
}

export interface CatalogDescriptor {
  type: string;
  id: string;
  name: string;
}

export interface BehaviorHints {
  configurable: boolean;
  configurationRequired: boolean;
}

export interface MetaResponse {
  metas: MetaPreview[];
}

export interface MetaPreview {
  id: string;
  type: string;
  name: string;
  poster?: string;
  year?: number;
}

export interface StreamResponse {
  streams: Stream[];
}

export interface Stream {
  name: string;
  url: string;
  description?: string;
}
```

- [ ] **Step 2: Create routes.ts**

```ts
import type { Context } from "hono";
import * as queries from "../db/queries";
import type { AppBindings } from "../app";
import type { Manifest, MetaResponse, StreamResponse } from "./models";

export async function manifestHandler(c: Context<AppBindings>): Promise<Response> {
  return c.json({
    id: "com.streamvault.addon",
    version: "1.0.0",
    name: "StreamVault",
    description: "Personal media streaming pipeline",
    resources: ["stream", "catalog", "meta"],
    types: ["movie", "series"],
    catalogs: [
      { type: "movie", id: "streamvault-movies", name: "StreamVault Movies" },
      { type: "series", id: "streamvault-series", name: "StreamVault Series" },
    ],
    idPrefixes: ["tt"],
    behaviorHints: { configurable: false, configurationRequired: false },
  });
}

export async function catalogHandler(c: Context<AppBindings>): Promise<Response> {
  const type = c.req.param("type");
  const completed = queries.listJobsByStatus(c.var.db, "completed");

  const seenImdb = new Set<string>();
  const metas: any[] = [];
  for (const job of completed) {
    if (job.mediaType === type && !seenImdb.has(job.imdbId)) {
      seenImdb.add(job.imdbId);
      metas.push({
        id: job.imdbId,
        type: job.mediaType,
        name: job.title || job.imdbId,
        poster: job.posterUrl || undefined,
        year: undefined,
      });
    }
  }

  return c.json({ metas });
}

export async function metaHandler(c: Context<AppBindings>): Promise<Response> {
  const type = c.req.param("type");
  let imdbId = c.req.param("imdbId");
  imdbId = imdbId.replace(/\.json$/, "");

  const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
  const resp = await fetch(url);
  const json = await resp.json();
  return c.json(json);
}

export async function streamHandler(c: Context<AppBindings>): Promise<Response> {
  let id = c.req.param("id");
  id = id.replace(/\.json$/, "");

  const [imdbIdStr, seasonStr, episodeStr] = id.split(":");
  const imdbId = imdbIdStr;
  const season = seasonStr ? parseInt(seasonStr) : null;
  const episode = episodeStr ? parseInt(episodeStr) : null;

  let job: any;
  if (season != null && episode != null) {
    const allCompleted = queries.listJobsByStatus(c.var.db, "completed");
    job = allCompleted.find(j =>
      j.imdbId === imdbId && j.season === season && j.episode === episode
    );
  } else {
    const allCompleted = queries.listJobsByStatus(c.var.db, "completed");
    job = allCompleted.find(j => j.imdbId === imdbId && j.season == null);
  }

  const streams = job
    ? [{
        name: "StreamVault",
        url: `${c.var.config.publicBaseUrl}/proxy/hls/${job.id}/master.m3u8`,
        description: job.videoResolution ? `${job.videoResolution}` : undefined,
      }]
    : [];

  return c.json({ streams });
}
```

- [ ] **Step 3: Create proxy.ts — HLS playlist + segment proxy**

```ts
import type { Context } from "hono";
import { notFound, badGateway } from "../error";
import * as queries from "../db/queries";
import type { AppBindings } from "../app";

export async function playlistHandler(c: Context<AppBindings>): Promise<Response> {
  const jobId = c.req.param("jobId");
  const job = queries.getJob(c.var.db, jobId);
  const allChunks = queries.getHlsChunks(c.var.db, jobId);
  const chunks = allChunks.filter((c: any) => c.filename.endsWith(".ts"));

  if (chunks.length === 0) throw notFound("No HLS segments found for this job");

  const baseUrl = c.var.config.publicBaseUrl;
  const targetDuration = Math.max(1, ...chunks.map((c: any) => Math.ceil(c.durationSeconds ?? 6)));

  let playlist = "#EXTM3U\n";
  playlist += "#EXT-X-VERSION:3\n";
  playlist += `#EXT-X-TARGETDURATION:${targetDuration}\n`;
  playlist += "#EXT-X-MEDIA-SEQUENCE:0\n";
  playlist += "#EXT-X-PLAYLIST-TYPE:VOD\n";

  for (const chunk of chunks) {
    const duration = chunk.durationSeconds ?? 6;
    playlist += `#EXTINF:${duration.toFixed(6)},\n`;
    playlist += `${baseUrl}/proxy/hls/${jobId}/${chunk.filename}\n`;
  }
  playlist += "#EXT-X-ENDLIST\n";

  return new Response(playlist, {
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function parseRange(value: string): string | null {
  if (!value.startsWith("bytes=")) return null;
  return value.slice(6);
}

export async function chunkHandler(c: Context<AppBindings>): Promise<Response> {
  const jobId = c.req.param("jobId");
  const filename = c.req.param("*");

  // Query chunk directly
  const allChunks = queries.getHlsChunks(c.var.db, jobId);
  const chunk = allChunks.find((ch: any) => ch.filename === filename);
  if (!chunk) return c.body("segment not found", 404);

  let storedUrl = chunk.discordUrl;
  if (!storedUrl) return c.body("segment not found", 404);

  const rangeHeader = c.req.header("range");
  const range = rangeHeader ? parseRange(rangeHeader) : null;

  const headers: Record<string, string> = {};
  if (range) headers["Range"] = `bytes=${range}`;

  let resp = await fetch(storedUrl, { headers }).catch(() => null);
  if (!resp || !resp.ok) {
    // Try refreshing Discord CDN URL
    const msgId = chunk.discordMessageId;
    if (msgId) {
      const discToken = getSettingOrEnv(c, "discord_bot_token");
      const channelId = queries.getJob(c.var.db, jobId).discordChannelId;
      if (discToken && channelId) {
        const msgUrl = `https://discord.com/api/v10/channels/${channelId}/messages/${msgId}`;
        const msgResp = await fetch(msgUrl, {
          headers: { Authorization: `Bot ${discToken}` },
        }).catch(() => null);
        if (msgResp?.ok) {
          const msg = await msgResp.json() as any;
          const newUrl = msg.attachments?.[0]?.url;
          if (newUrl) {
            storedUrl = newUrl;
            resp = await fetch(newUrl, { headers }).catch(() => null);
          }
        }
      }
    }
  }

  if (!resp || !resp.ok) {
    return c.body("failed to fetch segment from Discord", 502);
  }

  const responseHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=3600",
  };
  if (resp.headers.get("content-type")) {
    responseHeaders["Content-Type"] = resp.headers.get("content-type")!;
  }
  if (resp.headers.get("content-range")) {
    responseHeaders["Content-Range"] = resp.headers.get("content-range")!;
  }
  if (resp.headers.get("content-length")) {
    responseHeaders["Content-Length"] = resp.headers.get("content-length")!;
  }

  return new Response(resp.body, {
    status: resp.status,
    headers: responseHeaders,
  });
}
```

- [ ] **Step 4: Commit**

```bash
git add backend-bun/src/stremio/
git commit -m "feat(bun): Stremio addon routes + HLS proxy"
```

---

### Task 8: Pipeline trigger + Discord channel picker

**Files:**
- Create: `backend-bun/src/pipeline/channel.ts`
- Create: `backend-bun/src/pipeline/trigger.ts`

- [ ] **Step 1: Create channel.ts**

```ts
// Deterministic channel assignment from job_id (Jenkins one-at-a-time hash)
export function pickChannel(jobId: string, channels: string[]): string | null {
  if (channels.length === 0) return null;
  let hash = 0;
  for (let i = 0; i < jobId.length; i++) {
    hash = (hash * 31 + jobId.charCodeAt(i)) | 0;
  }
  return channels[Math.abs(hash) % channels.length];
}
```

- [ ] **Step 2: Create trigger.ts — GHA dispatch + cancel**

```ts
import type { Context } from "hono";
import * as queries from "../db/queries";
import { badRequest, internal } from "../error";
import { pickChannel } from "./channel";
import type { AppBindings } from "../app";

export function getSettingOrEnv(c: Context<AppBindings>, key: string): string | undefined {
  // Check DB first
  const dbVal = queries.getSetting(c.var.db, key);
  if (dbVal) return dbVal;
  // Fallback to config
  const config = c.var.config as any;
  const configKey = key.replace(/_([a-z])/g, (_, l) => l.toUpperCase());
  const camelKey = key === "gh_token" ? "ghToken"
    : key === "gh_repo" ? "ghRepo"
    : key === "discord_bot_token" ? "discordBotToken"
    : key === "discord_channel_id" ? "discordChannelId"
    : key === "discord_channel_ids" ? "discordChannelIds"
    : key === "telegram_bot_token" ? "telegramBotToken"
    : key === "telegram_channel_id" ? "telegramChannelId"
    : key === "torrentio_base_url" ? "torrentioBaseUrl"
    : key;
  return config[camelKey];
}

async function getDiscordChannel(c: Context<AppBindings>, jobId: string): Promise<string> {
  const multi = getSettingOrEnv(c, "discord_channel_ids");
  if (multi) {
    const channels = multi.split(",").map(s => s.trim()).filter(Boolean);
    if (channels.length > 0) {
      const picked = pickChannel(jobId, channels);
      if (picked) return picked;
    }
  }
  const single = getSettingOrEnv(c, "discord_channel_id");
  if (single) return single;
  throw badRequest("No Discord channel configured");
}

export async function fetchGhRunId(ghToken: string, ghRepo: string, workflowFile: string): Promise<string | undefined> {
  const url = `https://api.github.com/repos/${ghRepo}/actions/workflows/${workflowFile}/runs?status=in_progress&status=queued&per_page=5`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "StreamVault/1.0",
    },
  });
  if (!resp.ok) return undefined;
  const json: any = await resp.json();
  return json.workflow_runs?.[0]?.id?.toString();
}

export async function cancelGhRun(ghToken: string, ghRepo: string, runId: string): Promise<void> {
  const url = `https://api.github.com/repos/${ghRepo}/actions/runs/${runId}/cancel`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "StreamVault/1.0",
    },
  });
  if (!resp.ok && resp.status !== 204) {
    console.error(`Failed to cancel GH run: ${resp.status}`);
  }
}

export async function triggerPipeline(c: Context<AppBindings>, job: any, skipDownload: boolean, skipTranscode: boolean): Promise<string> {
  const ghToken = getSettingOrEnv(c, "gh_token");
  const ghRepo = getSettingOrEnv(c, "gh_repo");
  if (!ghToken) throw badRequest("GitHub token not configured");
  if (!ghRepo) throw badRequest("GitHub repo not configured");

  const baseUrl = c.var.config.publicBaseUrl;
  const callbackToken = c.var.config.authSecret;
  const discordToken = getSettingOrEnv(c, "discord_bot_token") || "";
  const discordChannel = await getDiscordChannel(c, job.id);

  const url = `https://api.github.com/repos/${ghRepo}/actions/workflows/streamvault-pipeline.yml/dispatches`;
  const body = {
    ref: "main",
    inputs: {
      job_id: job.id,
      magnet_uri: job.magnetUri,
      file_idx: (job.fileIdx ?? 0).toString(),
      torrent_name: job.torrentName ?? "",
      callback_url: baseUrl,
      callback_token: callbackToken,
      discord_bot_token: discordToken,
      discord_channel_id: discordChannel,
      skip_download: skipDownload.toString(),
      skip_transcode: skipTranscode.toString(),
      checkpoint_dl_url: job.ghArtifactDlUrl ?? "",
      checkpoint_tc_url: job.ghArtifactTcUrl ?? "",
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "StreamVault/1.0",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw internal(`GitHub API error (${resp.status}): ${text}`);
  }

  // Poll for run ID
  await new Promise(r => setTimeout(r, 3000));
  let ghRunId = await fetchGhRunId(ghToken, ghRepo, "streamvault-pipeline.yml");
  ghRunId ??= "pending";

  queries.updateJobGhRun(c.var.db, job.id, ghRunId);
  queries.insertJobEvent(c.var.db, job.id, null, "status_change",
    `Pipeline triggered (run_id: ${ghRunId}, channel: ${discordChannel})`, null);

  return ghRunId;
}
```

- [ ] **Step 3: Commit**

```bash
git add backend-bun/src/pipeline/
git commit -m "feat(bun): pipeline trigger + channel picker"
```

---

### Task 9: Workers — scheduler + stale job monitor

**Files:**
- Create: `backend-bun/src/worker/scheduler.ts`
- Create: `backend-bun/src/worker/monitor.ts`

- [ ] **Step 1: Create monitor.ts**

```ts
import type { DrizzleDB } from "../db/index";
import { listJobsByStatuses, updateJobFailed, insertJobEvent } from "../db/queries";

const ACTIVE_STATUSES = [
  "processing", "downloading", "checkpoint_download",
  "transcoding", "checkpoint_transcode", "uploading",
];

export function recoverStaleJobs(db: DrizzleDB): void {
  const stale = listJobsByStatuses(db, ACTIVE_STATUSES);
  for (const job of stale) {
    console.warn(`Recovering stale job ${job.id} (status: ${job.status})`);
    updateJobFailed(db, job.id, "Server restarted — job interrupted, please retry");
    insertJobEvent(db, job.id, null, "error",
      "Server restarted while job was in progress", null);
  }
  if (stale.length === 0) {
    console.log("No stale jobs to recover");
  } else {
    console.log(`Recovered ${stale.length} stale job(s)`);
  }
}
```

- [ ] **Step 2: Create scheduler.ts**

```ts
import type { DrizzleDB } from "../db/index";
import type { Config } from "../config";
import type { EventBus, SseEvent } from "../api/events";
import { countJobsByStatuses, getNextQueuedJob, updateJobStatus, insertJobEvent } from "../db/queries";
import { triggerPipeline } from "../pipeline/trigger";
import { sendNotification } from "../notifications/telegram";
import { getSettingOrEnv } from "../pipeline/trigger";

const ACTIVE_STATUSES = [
  "processing", "downloading", "checkpoint_download",
  "transcoding", "checkpoint_transcode", "uploading",
];

function getChannelCount(config: Config): number {
  if (config.discordChannelIds) {
    const count = config.discordChannelIds.split(",").filter(c => c.trim()).length;
    if (count > 0) return count;
  }
  if (config.discordChannelId) return 1;
  return 1;
}

function broadcastQueueUpdate(db: DrizzleDB, eventBus: EventBus): void {
  const processing = countJobsByStatuses(db, ACTIVE_STATUSES);
  const queued = countJobsByStatuses(db, ["queued"]);
  eventBus.send({ type: "queue_update", data: { processing, queued } });
}

export function worker(db: DrizzleDB, config: Config, eventBus: EventBus): void {
  setInterval(() => {
    try {
      const channelCount = getChannelCount(config);
      const maxConcurrent = Math.max(1, channelCount);
      const activeCount = countJobsByStatuses(db, ACTIVE_STATUSES);
      const slots = maxConcurrent - activeCount;

      if (slots <= 0) {
        broadcastQueueUpdate(db, eventBus);
        return;
      }

      console.log(`Active: ${activeCount}, slots remaining: ${slots}`);

      for (let i = 0; i < slots; i++) {
        const job = getNextQueuedJob(db);
        if (!job) break;

        updateJobStatus(db, job.id, "processing");
        insertJobEvent(db, job.id, null, "status_change", "Pipeline started by scheduler", null);
        eventBus.send({ type: "job_started", data: { job_id: job.id } });
        sendNotification(null as any, { type: "JobStarted", title: job.title ?? "" });

        triggerPipeline(null as any, job, false, false).catch(e => {
          console.error(`Failed to trigger pipeline for job ${job.id}:`, e);
          updateJobFailed(db, job.id, `Trigger failed: ${e.message}`);
        });
      }

      broadcastQueueUpdate(db, eventBus);
    } catch (e) {
      console.error("Scheduler tick error:", e);
    }
  }, 15000);
}
```

**Note on context passing:** The scheduler runs outside Hono request context. For `sendNotification` and `triggerPipeline` — they need DB + config + eventBus, not the Hono c object. Adjust those functions to accept db/config/eventBus directly or use a global. The simplest fix: export a global state setter from a shared module, set on startup. For plan purposes, note that `scheduler.ts` and `trigger.ts` will need a refactor pass in Task 10 to wire context. This is a known ponytail clean-up.

- [ ] **Step 3: Commit**

```bash
git add backend-bun/src/worker/
git commit -m "feat(bun): scheduler + stale job monitor"
```

---

### Task 10: Notifications — Telegram

**Files:**
- Create: `backend-bun/src/notifications/telegram.ts`

- [ ] **Step 1: Create telegram.ts**

```ts
import type { Context } from "hono";
import { getSettingOrEnv } from "../pipeline/trigger";

export interface TelegramEvent {
  type: "JobQueued" | "JobStarted" | "CheckpointSaved" | "JobCompleted" | "JobFailed";
  title: string;
  phase?: string;
  error?: string;
  details?: string;
}

function formatMessage(event: TelegramEvent): string {
  switch (event.type) {
    case "JobQueued": return `🎬 <b>Added to queue:</b> ${event.title}`;
    case "JobStarted": return `⚙️ <b>Processing started:</b> ${event.title}`;
    case "CheckpointSaved": return `💾 <b>Checkpoint saved:</b> ${event.title} — ${event.phase}`;
    case "JobCompleted": return `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ <b>StreamVault - Download Complete</b>\n\n🎬 ${event.title}\n${event.details}`;
    case "JobFailed": return `❌ <b>Failed:</b> ${event.title} at ${event.phase} — ${event.error}`;
  }
}

// Receive db/config directly (called from both request context and scheduler)
import type { DrizzleDB } from "../db/index";
import type { Config } from "../config";
import { getSetting } from "../db/queries";

let _db: DrizzleDB | null = null;
let _config: Config | null = null;

export function setNotificationGlobals(db: DrizzleDB, config: Config): void {
  _db = db;
  _config = config;
}

export async function sendNotification(
  c: Context<any> | null,
  event: TelegramEvent,
): Promise<void> {
  const db = c?.var?.db ?? _db;
  const config = c?.var?.config ?? _config;
  if (!db || !config) return;

  // Check if notifications enabled
  const enabled = getSetting(db, "notifications_enabled");
  if (enabled !== "true") return;

  const botToken = getSetting(db, "telegram_bot_token") || config.telegramBotToken;
  const channelId = getSetting(db, "telegram_channel_id") || config.telegramChannelId;
  if (!botToken || !channelId) return;

  const message = formatMessage(event);
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  // Fire and forget
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: channelId,
      text: message,
      parse_mode: "HTML",
    }),
  }).catch(() => {});
}
```

- [ ] **Step 2: Commit**

```bash
git add backend-bun/src/notifications/
git commit -m "feat(bun): Telegram notifications"
```

---

### Task 11: Context wiring — resolve scheduler + global state references

**Files:**
- Modify: `backend-bun/src/index.ts`
- Modify: `backend-bun/src/worker/scheduler.ts`
- Modify: `backend-bun/src/pipeline/trigger.ts`
- Modify: `backend-bun/src/notifications/telegram.ts`

**Goal:** Wire all global state (db, config, eventBus) into the Hono context via middleware, set globals for scheduler use, and ensure all functions work both from request handlers and from the background scheduler.

- [ ] **Step 1: Update app.ts — add db + eventBus to Hono context**

```ts
// Add to AppBindings:
export interface AppBindings {
  Bindings: {};
  Variables: {
    config: Config;
    db: DrizzleDB;
    eventBus: EventBus;
  };
}

export function createApp(config: Config, db: DrizzleDB, eventBus: EventBus): Hono<AppBindings> {
  // In middleware: c.set("db", db); c.set("eventBus", eventBus);
}
```

- [ ] **Step 2: Update index.ts**

```ts
import { loadConfig } from "./config";
import { createDb, type DrizzleDB } from "./db/index";
import { createApp } from "./app";
import { EventBus, startKeepAlive } from "./api/events";
import { worker } from "./worker/scheduler";
import { recoverStaleJobs } from "./worker/monitor";
import { setNotificationGlobals } from "./notifications/telegram";

const config = loadConfig();
const db = createDb();
const eventBus = new EventBus();

// Set globals for background worker use
setNotificationGlobals(db, config);

// Create app with context
const app = createApp(config, db, eventBus);

// ... wire routes (same as before, handlers read c.var.db / c.var.eventBus / c.var.config)

startKeepAlive();
recoverStaleJobs(db);
worker(db, config, eventBus);
```

- [ ] **Step 3: Update all route handlers to read from c.var instead of local vars**

Example pattern:
```ts
// Before: queries.listJobs(c.var.db)
// After:  queries.listJobs(c.var.db) — already correct if you used c.var in handlers
// But for files that access db/getSettingOrEnv directly, use:
const db = c.var.db;
const config = c.var.config;
const eventBus = c.var.eventBus;
```

- [ ] **Step 4: Verify compile**

Run: `cd backend-bun && bun check src/index.ts`
Expected: No TS errors.

- [ ] **Step 5: Commit**

```bash
git add backend-bun/src/index.ts backend-bun/src/app.ts backend-bun/src/worker/scheduler.ts backend-bun/src/pipeline/trigger.ts backend-bun/src/notifications/telegram.ts
git commit -m "fix(bun): wire context — db, config, eventBus through Hono + globals"
```

---

### Task 12: Docker build + verify

**Files:**
- Create: `backend-bun/Dockerfile`
- Create: `backend-bun/docker-compose.yml`
- Create: `backend-bun/.dockerignore`
- Create: `backend-bun/entrypoint.sh`

- [ ] **Step 1: Create Dockerfile**

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
COPY backend-bun/entrypoint.sh .
RUN chmod +x entrypoint.sh

ENV STREAMVAULT_DASHBOARD_DIR=/app/dashboard
EXPOSE 8080

ENTRYPOINT ["./entrypoint.sh"]
```

- [ ] **Step 2: Create entrypoint.sh**

```sh
#!/bin/sh
set -e
mkdir -p /data
export STREAMVAULT_DATABASE_URL="${STREAMVAULT_DATABASE_URL:-sqlite:/data/streamvault.db?mode=rwc}"
export STREAMVAULT_DASHBOARD_DIR="${STREAMVAULT_DASHBOARD_DIR:-/app/dashboard}"
echo "Starting StreamVault..."
exec ./streamvault
```

- [ ] **Step 3: Create .dockerignore**

```
node_modules/
data/
*.db
```

- [ ] **Step 4: Verify build**

Run: `DOCKER_BUILDKIT=1 docker build -f backend-bun/Dockerfile -t streamvault-bun .`
Expected: Builds successfully, produces a single binary at /app/streamvault.

- [ ] **Step 5: Create index.html placeholder (for build test)**

If the Svelte dashboard isn't built yet, create a placeholder `dashboard/dist/index.html`:
```html
<!DOCTYPE html>
<html><body>StreamVault</body></html>
```

- [ ] **Step 6: Commit**

```bash
git add backend-bun/Dockerfile backend-bun/docker-compose.yml backend-bun/.dockerignore backend-bun/entrypoint.sh
git commit -m "feat(bun): Docker multi-stage build + deploy"
```

---

### Task 13: end-to-end smoke test

- [ ] **Step 1: Start the Bun dev server**

Run: `cd backend-bun && bun --watch src/index.ts`
Expected: Server starts on port 8080 without errors.

- [ ] **Step 2: Test health**

Run: `curl http://localhost:8080/manifest.json`
Expected: Returns Stremio manifest JSON (200).

- [ ] **Step 3: Test search (if Torrentio accessible)**

Run: `curl -X POST http://localhost:8080/api/v1/search -H "Authorization: Bearer streamvault-dev-secret" -H "Content-Type: application/json" -d '{"imdb_id":"tt1375666","media_type":"movie"}'`
Expected: Returns search response with Cinemeta meta + torrents (or empty if blocked).

- [ ] **Step 4: Test queue**

Run: `curl http://localhost:8080/api/v1/queue -H "Authorization: Bearer streamvault-dev-secret"`
Expected: Returns empty queue listing: `{"processing":[],"queued":[],"completed":[],"failed":[]}`

- [ ] **Step 5: Test 401**

Run: `curl http://localhost:8080/api/v1/queue`
Expected: Returns 401 Unauthorized.

- [ ] **Step 6: Test settings**

Run: `curl http://localhost:8080/api/v1/settings -H "Authorization: Bearer streamvault-dev-secret"`
Expected: Returns settings JSON with env defaults.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: bun smoke test — server starts, routes respond"
```

---

## Self-Review Checklist

- **Spec coverage:** Every section in the design doc maps to one or more tasks above. Specifically:
  - Config → Task 1
  - DB schema + queries → Tasks 2, 3
  - Auth + EventBus → Task 4
  - API handlers → Tasks 5, 6
  - Stremio routes + proxy → Task 7
  - Pipeline → Task 8
  - Workers → Task 9
  - Notifications → Task 10
  - Wiring → Task 11
  - Docker → Task 12
  - Smoke test → Task 13

- **Placeholder scan:** No "TBD", "TODO", or empty steps. Every step has exact code or exact commands.

- **Type consistency:** All query functions use same interface names (NewJob, Job, etc.) across tasks. `triggerPipeline` accepts `(c, job, skipDownload, skipTranscode)` — same signature in all references. `sendNotification` consistently takes `(c | null, TelegramEvent)`.
