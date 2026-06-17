-- Migration 0001: Initial schema

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    imdb_id TEXT NOT NULL,
    media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'series')),
    season INTEGER,
    episode INTEGER,
    title TEXT,
    poster_url TEXT,
    magnet_uri TEXT,
    infohash TEXT,
    torrent_name TEXT,
    file_idx INTEGER,
    file_size_bytes INTEGER,
    status TEXT NOT NULL DEFAULT 'queued',
    current_phase TEXT,
    progress_pct INTEGER DEFAULT 0,
    transcode_pct INTEGER DEFAULT 0,
    upload_pct INTEGER DEFAULT 0,
    last_checkpoint TEXT,
    gh_run_id TEXT,
    gh_artifact_id_dl TEXT,
    gh_artifact_id_tc TEXT,
    discord_channel_id TEXT,
    video_resolution TEXT,
    duration_seconds REAL,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    phase TEXT,
    event_type TEXT NOT NULL,
    message TEXT,
    progress_pct INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS hls_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    filename TEXT NOT NULL,
    discord_url TEXT,
    discord_message_id TEXT,
    duration_seconds REAL,
    file_size_bytes INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cinemeta_cache (
    imdb_id TEXT NOT NULL,
    media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'series')),
    title TEXT,
    poster_url TEXT,
    overview TEXT,
    year INTEGER,
    total_seasons INTEGER,
    cached_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (imdb_id, media_type)
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_imdb_id ON jobs(imdb_id);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_events_job_id ON job_events(job_id);
CREATE INDEX IF NOT EXISTS idx_hls_chunks_job_id ON hls_chunks(job_id);