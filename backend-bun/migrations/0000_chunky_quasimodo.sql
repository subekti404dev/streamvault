CREATE TABLE IF NOT EXISTS `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `cinemeta_cache` (
	`imdb_id` text NOT NULL,
	`media_type` text NOT NULL,
	`title` text,
	`poster_url` text,
	`overview` text,
	`year` integer,
	`total_seasons` integer,
	`cached_at` text DEFAULT (datetime('now')) NOT NULL,
	PRIMARY KEY(`imdb_id`, `media_type`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `hls_chunks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`filename` text NOT NULL,
	`discord_url` text,
	`discord_message_id` text,
	`duration_seconds` real,
	`file_size_bytes` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_hls_chunks_job_id` ON `hls_chunks` (`job_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `job_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`phase` text,
	`event_type` text NOT NULL,
	`message` text,
	`progress_pct` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_job_events_job_id` ON `job_events` (`job_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`imdb_id` text NOT NULL,
	`media_type` text NOT NULL,
	`season` integer,
	`episode` integer,
	`title` text,
	`poster_url` text,
	`magnet_uri` text,
	`infohash` text,
	`torrent_name` text,
	`file_idx` integer,
	`file_size_bytes` integer,
	`status` text DEFAULT 'queued' NOT NULL,
	`current_phase` text,
	`progress_pct` integer DEFAULT 0,
	`transcode_pct` integer DEFAULT 0,
	`upload_pct` integer DEFAULT 0,
	`last_checkpoint` text,
	`gh_run_id` text,
	`gh_artifact_id_dl` text,
	`gh_artifact_id_tc` text,
	`gh_artifact_dl_url` text,
	`gh_artifact_tc_url` text,
	`discord_channel_id` text,
	`video_resolution` text,
	`duration_seconds` real,
	`error_message` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`started_at` text,
	`completed_at` text,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_jobs_status` ON `jobs` (`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_jobs_imdb_id` ON `jobs` (`imdb_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_jobs_created_at` ON `jobs` (`created_at`);