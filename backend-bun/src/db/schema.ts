import { sqliteTable, text, integer, real, primaryKey, index } from "drizzle-orm/sqlite-core";
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
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  statusIdx: index("idx_jobs_status").on(t.status),
  imdbIdIdx: index("idx_jobs_imdb_id").on(t.imdbId),
  createdAtIdx: index("idx_jobs_created_at").on(t.createdAt),
}));

export const jobEvents = sqliteTable("job_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: text("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  phase: text("phase"),
  eventType: text("event_type").notNull(),
  message: text("message"),
  progressPct: integer("progress_pct"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  jobIdIdx: index("idx_job_events_job_id").on(t.jobId),
}));

export const hlsChunks = sqliteTable("hls_chunks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: text("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  chunkIndex: integer("chunk_index").notNull(),
  filename: text("filename").notNull(),
  discordUrl: text("discord_url"),
  discordMessageId: text("discord_message_id"),
  durationSeconds: real("duration_seconds"),
  fileSizeBytes: integer("file_size_bytes"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  jobIdIdx: index("idx_hls_chunks_job_id").on(t.jobId),
}));

export const cinemetaCache = sqliteTable("cinemeta_cache", {
  imdbId: text("imdb_id").notNull(),
  mediaType: text("media_type").notNull(),
  title: text("title"),
  posterUrl: text("poster_url"),
  overview: text("overview"),
  year: integer("year"),
  totalSeasons: integer("total_seasons"),
  cachedAt: text("cached_at").notNull().default(sql`(datetime('now'))`),
}, (t) => ({
  pk: primaryKey({ columns: [t.imdbId, t.mediaType] }),
}));

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value"),
});
