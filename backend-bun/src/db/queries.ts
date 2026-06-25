import { eq, desc, and, inArray, sql } from "drizzle-orm";
import { jobs, jobEvents, hlsChunks, cinemetaCache, appSettings } from "./schema";
import { notFound } from "../error";
import type { DrizzleDB } from "./index";

// ── Types (match Rust structs) ──

export interface Job {
  id: string;
  imdbId: string;
  mediaType: string;
  season: number | null;
  episode: number | null;
  title: string | null;
  posterUrl: string | null;
  magnetUri: string | null;
  infohash: string | null;
  torrentName: string | null;
  fileIdx: number | null;
  fileSizeBytes: number | null;
  status: string;
  currentPhase: string | null;
  progressPct: number | null;
  transcodePct: number | null;
  uploadPct: number | null;
  lastCheckpoint: string | null;
  ghRunId: string | null;
  ghArtifactIdDl: string | null;
  ghArtifactIdTc: string | null;
  ghArtifactDlUrl: string | null;
  ghArtifactTcUrl: string | null;
  discordChannelId: string | null;
  videoResolution: string | null;
  durationSeconds: number | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface NewJob {
  id: string;
  imdbId: string;
  mediaType: string;
  season: number | null;
  episode: number | null;
  title: string | null;
  posterUrl: string | null;
  magnetUri: string | null;
  infohash: string | null;
  torrentName: string | null;
  fileIdx: number | null;
  fileSizeBytes: number | null;
}

export interface JobEvent {
  id: number;
  jobId: string;
  phase: string | null;
  eventType: string;
  message: string | null;
  progressPct: number | null;
  createdAt: string;
}

export interface HlsChunkRow {
  id: number;
  jobId: string;
  chunkIndex: number;
  filename: string;
  discordUrl: string | null;
  discordMessageId: string | null;
  durationSeconds: number | null;
  fileSizeBytes: number | null;
  createdAt: string;
}

export interface NewHlsChunk {
  jobId: string;
  chunkIndex: number;
  filename: string;
  discordUrl: string | null;
  discordMessageId: string | null;
  durationSeconds: number | null;
  fileSizeBytes: number | null;
}

export interface CinemetaCacheRow {
  imdbId: string;
  mediaType: string;
  title: string | null;
  posterUrl: string | null;
  overview: string | null;
  year: number | null;
  totalSeasons: number | null;
  cachedAt: string;
}

export interface AppSettingRow {
  key: string;
  value: string | null;
}

export interface LibraryJob {
  id: string;
  title: string | null;
  season: number | null;
  episode: number | null;
  status: string;
  videoResolution: string | null;
  torrentName: string | null;
  durationSeconds: number | null;
  createdAt: string;
}

export interface LibraryGroup {
  imdbId: string;
  title: string | null;
  posterUrl: string | null;
  mediaType: string;
  jobCount: number;
  jobs: LibraryJob[];
}

export interface LibraryResponse {
  items: LibraryGroup[];
  total: number;
  page: number;
  limit: number;
}

export interface LibraryDetail {
  imdbId: string;
  title: string | null;
  posterUrl: string | null;
  mediaType: string;
  jobs: LibraryJob[];
}

// Helper to cast Drizzle row to our interface
// ponytail: Drizzle's BunSQLite driver returns plain objects matching column names
// These casts are safe because the schema defines the exact shape
function castJob(row: Record<string, unknown>): Job {
  return row as unknown as Job;
}

function castJobs(rows: Record<string, unknown>[]): Job[] {
  return rows as unknown as Job[];
}

function castJobEvents(rows: Record<string, unknown>[]): JobEvent[] {
  return rows as unknown as JobEvent[];
}

function castHlsChunks(rows: Record<string, unknown>[]): HlsChunkRow[] {
  return rows as unknown as HlsChunkRow[];
}

function castCinemeta(row: Record<string, unknown> | undefined): CinemetaCacheRow | undefined {
  return row as unknown as CinemetaCacheRow | undefined;
}

function castSettings(rows: Record<string, unknown>[]): AppSettingRow[] {
  return rows as unknown as AppSettingRow[];
}

// ── Jobs ──

export function insertJob(db: DrizzleDB, job: NewJob): void {
  db.insert(jobs).values({
    id: job.id,
    imdbId: job.imdbId,
    mediaType: job.mediaType,
    season: job.season,
    episode: job.episode,
    title: job.title,
    posterUrl: job.posterUrl,
    magnetUri: job.magnetUri,
    infohash: job.infohash,
    torrentName: job.torrentName,
    fileIdx: job.fileIdx,
    fileSizeBytes: job.fileSizeBytes,
    status: "queued",
    progressPct: 0,
    transcodePct: 0,
    uploadPct: 0,
  }).run();
}

export function getJob(db: DrizzleDB, id: string): Job {
  const row = db.select().from(jobs).where(eq(jobs.id, id)).get();
  if (!row) throw notFound(`Job ${id} not found`);
  return castJob(row as unknown as Record<string, unknown>);
}

export function listJobs(db: DrizzleDB): Job[] {
  const rows = db.select().from(jobs).orderBy(desc(jobs.createdAt)).all();
  return castJobs(rows as unknown as Record<string, unknown>[]);
}

export function listJobsByStatus(db: DrizzleDB, status: string): Job[] {
  const rows = db.select().from(jobs)
    .where(eq(jobs.status, status))
    .orderBy(desc(jobs.createdAt))
    .all();
  return castJobs(rows as unknown as Record<string, unknown>[]);
}

export function listJobsByStatuses(db: DrizzleDB, statuses: string[]): Job[] {
  const rows = db.select().from(jobs)
    .where(inArray(jobs.status, statuses))
    .orderBy(jobs.createdAt)
    .all();
  return castJobs(rows as unknown as Record<string, unknown>[]);
}

export function countJobsByStatuses(db: DrizzleDB, statuses: string[]): number {
  const row = db.select({ value: sql<number>`count(*)` })
    .from(jobs)
    .where(inArray(jobs.status, statuses))
    .get();
  return row?.value ?? 0;
}

export function countJobsByStatus(db: DrizzleDB, status: string): number {
  const row = db.select({ value: sql<number>`count(*)` })
    .from(jobs)
    .where(eq(jobs.status, status))
    .get();
  return row?.value ?? 0;
}

export function getNextQueuedJob(db: DrizzleDB): Job | undefined {
  const row = db.select().from(jobs)
    .where(eq(jobs.status, "queued"))
    .orderBy(jobs.createdAt)
    .limit(1)
    .get();
  return row ? castJob(row as unknown as Record<string, unknown>) : undefined;
}

export function updateJobStatus(db: DrizzleDB, id: string, status: string): void {
  db.update(jobs)
    .set({ status, updatedAt: sql`(datetime('now'))` })
    .where(eq(jobs.id, id))
    .run();
}

export function updateJobPhase(db: DrizzleDB, id: string, phase: string): void {
  db.update(jobs)
    .set({ currentPhase: phase, updatedAt: sql`(datetime('now'))` })
    .where(eq(jobs.id, id))
    .run();
}

export function updateJobProgress(db: DrizzleDB, id: string, phase: string, pct: number): void {
  const update: Record<string, unknown> = { updatedAt: sql`(datetime('now'))` };
  if (phase === "transcode") {
    update.transcodePct = pct;
  } else if (phase === "upload") {
    update.uploadPct = pct;
  } else {
    update.progressPct = pct;
  }
  db.update(jobs).set(update).where(eq(jobs.id, id)).run();
}


export function updateJobGhRun(db: DrizzleDB, id: string, runId: string): void {
  db.update(jobs).set({
    ghRunId: runId,
    status: "processing",
    startedAt: sql`(datetime('now'))`,
    updatedAt: sql`(datetime('now'))`,
  }).where(eq(jobs.id, id)).run();
}

export function updateJobCompleted(db: DrizzleDB, id: string, resolution: string, duration: number): void {
  db.update(jobs).set({
    status: "completed",
    videoResolution: resolution,
    durationSeconds: duration,
    completedAt: sql`(datetime('now'))`,
    updatedAt: sql`(datetime('now'))`,
  }).where(eq(jobs.id, id)).run();
}

export function updateJobFailed(db: DrizzleDB, id: string, errorMsg: string): void {
  db.update(jobs).set({
    status: "failed",
    errorMessage: errorMsg,
    updatedAt: sql`(datetime('now'))`,
  }).where(eq(jobs.id, id)).run();
}

export function deleteJob(db: DrizzleDB, id: string): void {
  db.delete(jobs).where(eq(jobs.id, id)).run();
}

export function deleteJobsByImdbId(db: DrizzleDB, imdbId: string): number {
  const result = db.delete(jobs).where(eq(jobs.imdbId, imdbId)).run();
  return result.changes;
}

// ── Job Events ──

export function insertJobEvent(
  db: DrizzleDB,
  jobId: string,
  phase: string | null,
  eventType: string,
  message: string,
  progressPct: number | null,
): void {
  db.insert(jobEvents).values({
    jobId,
    phase,
    eventType,
    message,
    progressPct,
  }).run();
}

export function getJobEvents(db: DrizzleDB, jobId: string): JobEvent[] {
  const rows = db.select().from(jobEvents)
    .where(eq(jobEvents.jobId, jobId))
    .orderBy(desc(jobEvents.createdAt))
    .all();
  return castJobEvents(rows as unknown as Record<string, unknown>[]);
}

// ── HLS Chunks ──

export function insertHlsChunk(db: DrizzleDB, chunk: NewHlsChunk): void {
  db.insert(hlsChunks).values({
    jobId: chunk.jobId,
    chunkIndex: chunk.chunkIndex,
    filename: chunk.filename,
    discordUrl: chunk.discordUrl,
    discordMessageId: chunk.discordMessageId,
    durationSeconds: chunk.durationSeconds,
    fileSizeBytes: chunk.fileSizeBytes,
  }).run();
}

export function getHlsChunks(db: DrizzleDB, jobId: string): HlsChunkRow[] {
  const rows = db.select().from(hlsChunks)
    .where(eq(hlsChunks.jobId, jobId))
    .orderBy(hlsChunks.chunkIndex)
    .all();
  return castHlsChunks(rows as unknown as Record<string, unknown>[]);
}

// ── Cinemeta Cache ──

export function getCachedMeta(db: DrizzleDB, imdbId: string, mediaType: string): CinemetaCacheRow | undefined {
  const row = db.select().from(cinemetaCache)
    .where(and(eq(cinemetaCache.imdbId, imdbId), eq(cinemetaCache.mediaType, mediaType)))
    .get();
  return castCinemeta(row as unknown as Record<string, unknown> | undefined);
}

export function upsertCachedMeta(
  db: DrizzleDB,
  meta: { imdbId: string; mediaType: string; title?: string | null; posterUrl?: string | null; overview?: string | null; year?: number | null; totalSeasons?: number | null },
): void {
  db.insert(cinemetaCache).values({
    imdbId: meta.imdbId,
    mediaType: meta.mediaType,
    title: meta.title,
    posterUrl: meta.posterUrl,
    overview: meta.overview,
    year: meta.year,
    totalSeasons: meta.totalSeasons,
  }).onConflictDoUpdate({
    target: [cinemetaCache.imdbId, cinemetaCache.mediaType],
    set: {
      title: meta.title,
      posterUrl: meta.posterUrl,
      overview: meta.overview,
      year: meta.year,
      totalSeasons: meta.totalSeasons,
      cachedAt: sql`(datetime('now'))`,
    },
  }).run();
}

// ── App Settings ──

export function getAllSettings(db: DrizzleDB): AppSettingRow[] {
  const rows = db.select().from(appSettings).all();
  return castSettings(rows as unknown as Record<string, unknown>[]);
}

export function getSetting(db: DrizzleDB, key: string): string | undefined {
  const row = db.select().from(appSettings)
    .where(eq(appSettings.key, key))
    .get();
  return row?.value ?? undefined;
}

export function upsertSetting(db: DrizzleDB, key: string, value: string): void {
  db.insert(appSettings).values({ key, value })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value },
    }).run();
}

// ── Library ──

export function getCompletedJobsGrouped(
  db: DrizzleDB,
  mediaType: string | null,
  page: number,
  limit: number,
): LibraryResponse {
  const offset = (page - 1) * limit;

  // Count distinct imdb_ids
  const totalRow = mediaType
    ? db.select({ value: sql<number>`count(distinct ${jobs.imdbId})` })
        .from(jobs)
        .where(and(eq(jobs.status, "completed"), eq(jobs.mediaType, mediaType)))
        .get()
    : db.select({ value: sql<number>`count(distinct ${jobs.imdbId})` })
        .from(jobs)
        .where(eq(jobs.status, "completed"))
        .get();

  const total = totalRow?.value ?? 0;

  // Get grouped data
  const groupRows = mediaType
    ? db.select({
        imdbId: jobs.imdbId,
        title: jobs.title,
        posterUrl: jobs.posterUrl,
        mediaType: jobs.mediaType,
        jobCount: sql<number>`count(*)`,
      })
        .from(jobs)
        .where(and(eq(jobs.status, "completed"), eq(jobs.mediaType, mediaType)))
        .groupBy(jobs.imdbId)
        .orderBy(jobs.title)
        .limit(limit)
        .offset(offset)
        .all()
    : db.select({
        imdbId: jobs.imdbId,
        title: jobs.title,
        posterUrl: jobs.posterUrl,
        mediaType: jobs.mediaType,
        jobCount: sql<number>`count(*)`,
      })
        .from(jobs)
        .where(eq(jobs.status, "completed"))
        .groupBy(jobs.imdbId)
        .orderBy(jobs.title)
        .limit(limit)
        .offset(offset)
        .all();

  const items: LibraryGroup[] = groupRows.map((group) => {
    // Get child jobs for this imdb_id
    const childJobRows = db.select({
      id: jobs.id,
      title: jobs.title,
      videoResolution: jobs.videoResolution,
      torrentName: jobs.torrentName,
      durationSeconds: jobs.durationSeconds,
      createdAt: jobs.createdAt,
    })
      .from(jobs)
      .where(and(eq(jobs.imdbId, group.imdbId), eq(jobs.status, "completed")))
      .orderBy(jobs.season, jobs.episode)
      .all();

    const childJobs = childJobRows as unknown as LibraryJob[];

    // Poster: prefer job poster, fallback to cinemeta_cache
    let posterUrl = group.posterUrl;
    if (!posterUrl) {
      const cacheRow = db.select({ posterUrl: cinemetaCache.posterUrl })
        .from(cinemetaCache)
        .where(and(eq(cinemetaCache.imdbId, group.imdbId), eq(cinemetaCache.mediaType, group.mediaType)))
        .get();
      posterUrl = cacheRow?.posterUrl ?? null;
    }

    return {
      imdbId: group.imdbId,
      title: group.title,
      posterUrl,
      mediaType: group.mediaType,
      jobCount: group.jobCount,
      jobs: childJobs,
    };
  });

  return { items, total, page, limit };
}

export function requeueJob(db: DrizzleDB, jobId: string): boolean {
  // Check eligibility first (Drizzle update.run() returns void in TS for bun-sqlite)
  const eligible = db.select({ id: jobs.id })
    .from(jobs)
    .where(and(
      eq(jobs.id, jobId),
      inArray(jobs.status, ["completed", "failed"]),
    ))
    .get();
  if (!eligible) return false;
  db.update(jobs)
    .set({ status: "queued", updatedAt: sql`(datetime('now'))` })
    .where(eq(jobs.id, jobId))
    .run();
  return true;
}

export function getLibraryDetail(db: DrizzleDB, imdbId: string): LibraryDetail {
  const jobRows = db.select({
    id: jobs.id,
    title: jobs.title,
    season: jobs.season,
    episode: jobs.episode,
    videoResolution: jobs.videoResolution,
    torrentName: jobs.torrentName,
    durationSeconds: jobs.durationSeconds,
    createdAt: jobs.createdAt,
  })
    .from(jobs)
    .where(and(eq(jobs.imdbId, imdbId), eq(jobs.status, "completed")))
    .orderBy(jobs.season, jobs.episode)
    .all();

  const jobItems = jobRows as unknown as LibraryJob[];
  if (jobItems.length === 0) {
    throw notFound(`No completed jobs for ${imdbId}`);
  }

  // Poster from job (where NOT NULL) or cinemeta_cache
  let posterUrl: string | null = null;
  const jobPosterRow = db.select({ posterUrl: jobs.posterUrl })
    .from(jobs)
    .where(and(eq(jobs.imdbId, imdbId), sql`${jobs.posterUrl} IS NOT NULL`))
    .limit(1)
    .get();
  if (jobPosterRow?.posterUrl) {
    posterUrl = jobPosterRow.posterUrl;
  } else {
    const cacheRow = db.select({ posterUrl: cinemetaCache.posterUrl })
      .from(cinemetaCache)
      .where(eq(cinemetaCache.imdbId, imdbId))
      .get();
    posterUrl = cacheRow?.posterUrl ?? null;
  }

  // Determine media_type from season field presence
  const mediaType = jobItems.some((j) => j.season !== null) ? "series" : "movie";

  return {
    imdbId,
    title: jobItems[0]?.title ?? null,
    posterUrl,
    mediaType,
    jobs: jobItems,
  };
}
