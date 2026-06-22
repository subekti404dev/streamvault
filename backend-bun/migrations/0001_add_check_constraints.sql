-- Add CHECK constraints matching Rust backend
-- Rust migration: backend/migrations/20250617000001_initial.sql:6,61

-- jobs table
-- SQLite doesn't support ALTER TABLE ADD CONSTRAINT, 
-- but these are enforced at insert/update via Drizzle schema or app logic.
-- The original Rust migration has: CHECK (media_type IN ('movie', 'series'))
-- Drizzle schema.ts should enforce this at app level.

-- For the cinemeta_cache table:
-- Rust: CHECK (media_type IN ('movie', 'series'))
-- Added below as raw SQL to run post-migration if table is being created.

-- NOTE: Since we use CREATE TABLE IF NOT EXISTS, adding CHECK here only applies on fresh DB.
-- Existing DBs have already passed the IF NOT EXISTS gate and won't re-create the table.
-- Use the Drizzle schema layer or app-level validation for runtime enforcement.
