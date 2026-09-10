-- ============================================================
-- BuildHarvey — Observations
-- Migration 018
-- ============================================================

-- One observation = a single captured moment from a work session
-- (screenshot reference + summary). Created by the desktop agent
-- or, for now, the demo seed route.

CREATE TABLE IF NOT EXISTS observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  screenshot_path TEXT,
  summary TEXT NOT NULL DEFAULT ''
);

ALTER TABLE observations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users read own observations" ON observations
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "users insert own observations" ON observations
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users update own observations" ON observations
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "users delete own observations" ON observations
  FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS observations_user_idx
  ON observations (user_id, observed_at DESC);
