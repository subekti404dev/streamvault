-- Telegram (Bot API) as alternative HLS chunk storage provider.
-- Additive only: existing Discord columns untouched.
ALTER TABLE hls_chunks ADD COLUMN tg_file_id TEXT;
ALTER TABLE hls_chunks ADD COLUMN storage_provider TEXT NOT NULL DEFAULT 'discord';
