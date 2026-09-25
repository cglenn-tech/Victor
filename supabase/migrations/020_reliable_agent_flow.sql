-- Forward-only upgrade. Apply once after 019; do not rerun the early schema resets.
BEGIN;
ALTER TABLE public.observations
  ADD COLUMN IF NOT EXISTS device_id UUID REFERENCES public.devices(id),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE public.episodes
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS agent_revision BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS observation_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS recording_requested BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS browser_seen_at TIMESTAMPTZ;

-- Tombstones keep retries from recreating records a lawyer removed.
ALTER POLICY "users read own episodes" ON public.episodes
  USING (auth.uid() = user_id AND deleted_at IS NULL);
ALTER POLICY "users read own observations" ON public.observations
  USING (auth.uid() = user_id AND deleted_at IS NULL);

-- Restrict both the caller and the device/owner pair inside the transaction.
CREATE OR REPLACE FUNCTION public.sync_agent_episode(p_device_id UUID, p_user_id UUID, p_episode JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM devices WHERE id = p_device_id AND user_id = p_user_id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Invalid device' USING ERRCODE = '42501';
  END IF;
  INSERT INTO episodes (id, user_id, device_id, case_name, issue_worked_on, work_type,
    started_at, ended_at, duration_minutes, active_seconds, key_observations, created_at,
    agent_revision, is_reportable, observation_count)
  VALUES (p_episode->>'id', p_user_id, p_device_id, p_episode->>'case_name',
    p_episode->>'issue_worked_on', p_episode->>'work_type',
    (p_episode->>'started_at')::timestamptz, (p_episode->>'ended_at')::timestamptz,
    (p_episode->>'duration_minutes')::numeric, (p_episode->>'active_seconds')::numeric,
    p_episode->'key_observations', (p_episode->>'created_at')::timestamptz,
    (p_episode->>'agent_revision')::bigint, (p_episode->>'is_reportable')::boolean,
    (p_episode->>'observation_count')::integer)
  ON CONFLICT (id) DO UPDATE SET
    case_name = EXCLUDED.case_name, issue_worked_on = EXCLUDED.issue_worked_on,
    work_type = EXCLUDED.work_type, ended_at = EXCLUDED.ended_at,
    duration_minutes = EXCLUDED.duration_minutes, active_seconds = EXCLUDED.active_seconds,
    key_observations = EXCLUDED.key_observations, agent_revision = EXCLUDED.agent_revision,
    is_reportable = EXCLUDED.is_reportable, observation_count = EXCLUDED.observation_count
  WHERE episodes.user_id = p_user_id AND episodes.device_id = p_device_id
    AND episodes.edited_at IS NULL AND episodes.deleted_at IS NULL
    AND EXCLUDED.agent_revision >= episodes.agent_revision
    AND (EXCLUDED.agent_revision > episodes.agent_revision OR EXCLUDED.ended_at >= episodes.ended_at);
  IF EXISTS (SELECT 1 FROM episodes WHERE id = p_episode->>'id'
    AND (user_id IS DISTINCT FROM p_user_id OR device_id IS DISTINCT FROM p_device_id)) THEN
    RAISE EXCEPTION 'Record belongs to another device' USING ERRCODE = '42501';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.sync_agent_observations(p_device_id UUID, p_user_id UUID, p_observations JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o JSONB; parent episodes%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM devices WHERE id = p_device_id AND user_id = p_user_id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Invalid device' USING ERRCODE = '42501';
  END IF;
  FOR o IN SELECT * FROM jsonb_array_elements(p_observations) LOOP
    SELECT * INTO parent FROM episodes WHERE id = o->>'episode_id' FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Sync parent first' USING ERRCODE = '23503'; END IF;
    IF parent.user_id IS DISTINCT FROM p_user_id OR parent.device_id IS DISTINCT FROM p_device_id THEN
      RAISE EXCEPTION 'Invalid parent owner' USING ERRCODE = '42501';
    END IF;
    IF parent.deleted_at IS NOT NULL THEN CONTINUE; END IF;
    INSERT INTO observations (id, user_id, device_id, episode_id, title, summary,
      observed_at, start_time, end_time, applications, entities, activity_type)
    VALUES ((o->>'id')::uuid, p_user_id, p_device_id, parent.id, o->>'title', o->>'summary',
      (o->>'observed_at')::timestamptz, (o->>'start_time')::timestamptz, (o->>'end_time')::timestamptz,
      o->'applications', o->'entities', o->>'activity_type')
    ON CONFLICT (id) DO NOTHING; -- text, approval, deletion and reassignment belong to the user
    IF EXISTS (SELECT 1 FROM observations WHERE id = (o->>'id')::uuid
      AND (user_id IS DISTINCT FROM p_user_id OR device_id IS DISTINCT FROM p_device_id)) THEN
      RAISE EXCEPTION 'Record belongs to another device' USING ERRCODE = '42501';
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.sync_agent_episode(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_agent_observations(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_agent_episode(UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.sync_agent_observations(UUID, UUID, JSONB) TO service_role;

-- Lock and move both records in one transaction; preserve the dropped ID as a tombstone.
CREATE OR REPLACE FUNCTION public.merge_work_episodes(p_user_id UUID, p_keep TEXT, p_drop TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE k episodes%ROWTYPE; d episodes%ROWTYPE;
BEGIN
  IF p_keep = p_drop THEN RAISE EXCEPTION 'Choose two different entries' USING ERRCODE = '22023'; END IF;
  PERFORM 1 FROM episodes WHERE id IN (p_keep, p_drop) ORDER BY id FOR UPDATE;
  SELECT * INTO k FROM episodes WHERE id = p_keep AND user_id = p_user_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Entry not found' USING ERRCODE = '42501'; END IF;
  SELECT * INTO d FROM episodes WHERE id = p_drop AND user_id = p_user_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Entry not found' USING ERRCODE = '42501'; END IF;
  IF k.started_at < d.ended_at AND d.started_at < k.ended_at THEN
    RAISE EXCEPTION 'Resolve overlapping time before merging' USING ERRCODE = '22023';
  END IF;
  UPDATE episodes SET started_at = least(k.started_at, d.started_at), ended_at = greatest(k.ended_at, d.ended_at),
    active_seconds = coalesce(k.active_seconds, k.duration_minutes * 60) + coalesce(d.active_seconds, d.duration_minutes * 60),
    duration_minutes = (coalesce(k.active_seconds, k.duration_minutes * 60) + coalesce(d.active_seconds, d.duration_minutes * 60)) / 60,
    key_observations = k.key_observations || d.key_observations,
    observation_count = k.observation_count + d.observation_count, edited_at = now()
    WHERE id = p_keep RETURNING * INTO k;
  UPDATE observations SET episode_id = p_keep WHERE episode_id = p_drop AND user_id = p_user_id;
  UPDATE episode_screenshots SET episode_id = p_keep WHERE episode_id = p_drop AND user_id = p_user_id;
  UPDATE episodes SET deleted_at = now(), edited_at = now(), is_reportable = false WHERE id = p_drop;
  RETURN to_jsonb(k);
END $$;
REVOKE ALL ON FUNCTION public.merge_work_episodes(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_work_episodes(UUID, TEXT, TEXT) TO service_role;
COMMIT;
