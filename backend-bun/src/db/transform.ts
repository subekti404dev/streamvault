// Map Drizzle camelCase keys → Rust serde snake_case keys
// Frontend (dashboard) was built for Rust backend which serializes
// struct field names as-is (snake_case).
const SNAKE_MAP: Record<string, string> = {
  imdbId: "imdb_id",
  mediaType: "media_type",
  posterUrl: "poster_url",
  magnetUri: "magnet_uri",
  torrentName: "torrent_name",
  fileIdx: "file_idx",
  fileSizeBytes: "file_size_bytes",
  sizeBytes: "size_bytes",
  currentPhase: "current_phase",
  progressPct: "progress_pct",
  transcodePct: "transcode_pct",
  uploadPct: "upload_pct",
  lastCheckpoint: "last_checkpoint",
  ghRunId: "gh_run_id",
  ghArtifactIdDl: "gh_artifact_id_dl",
  ghArtifactIdTc: "gh_artifact_id_tc",
  ghArtifactDlUrl: "gh_artifact_dl_url",
  ghArtifactTcUrl: "gh_artifact_tc_url",
  discordChannelId: "discord_channel_id",
  videoResolution: "video_resolution",
  durationSeconds: "duration_seconds",
  errorMessage: "error_message",
  createdAt: "created_at",
  startedAt: "started_at",
  completedAt: "completed_at",
  updatedAt: "updated_at",
  // JobEvent fields
  jobId: "job_id",
  eventType: "event_type",
  jobCount: "job_count",
};

// ponytail: `any` input — callers pass typed objects (Job, JobEvent[], LibraryResponse)
// that don't extend Record<string,unknown> but are plain enough at runtime
export function toSnake(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(toSnake);
  if (typeof obj !== "object") return obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = SNAKE_MAP[k] ?? k;
    out[key] = toSnake(v);
  }
  return out;
}

export function toSnakeList(arr: any[] | null | undefined): any[] {
  if (!arr) return [];
  return arr.map(toSnake);
}
