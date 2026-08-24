ALTER TABLE `hls_chunks` ADD COLUMN `tg_file_id` text;--> statement-breakpoint
ALTER TABLE `hls_chunks` ADD COLUMN `storage_provider` text NOT NULL DEFAULT 'discord';