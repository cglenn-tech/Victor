-- ============================================================
-- Victor — Observations: structured fields
-- Migration 019
-- ============================================================
-- Extends the observations table (018) to hold the structured
-- output of the self-hosted vision model (one observation per
-- ~5-screenshot batch). `summary` remains the observation text.

ALTER TABLE observations ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';
ALTER TABLE observations ADD COLUMN IF NOT EXISTS start_time TIMESTAMPTZ;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS end_time TIMESTAMPTZ;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS applications JSONB NOT NULL DEFAULT '[]';
ALTER TABLE observations ADD COLUMN IF NOT EXISTS entities JSONB NOT NULL DEFAULT '[]';
ALTER TABLE observations ADD COLUMN IF NOT EXISTS activity_type TEXT;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS is_approved BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS observations_episode_idx ON observations (episode_id);
CREATE INDEX IF NOT EXISTS observations_user_approved_idx
  ON observations (user_id, is_approved, observed_at DESC);
