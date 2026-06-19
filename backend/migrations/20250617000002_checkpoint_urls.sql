-- Migration 0002: Add checkpoint file URLs for CI resume

ALTER TABLE jobs ADD COLUMN gh_artifact_dl_url TEXT;
ALTER TABLE jobs ADD COLUMN gh_artifact_tc_url TEXT;
