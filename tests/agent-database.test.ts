import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { beforeAll, afterAll, it, expect } from 'vitest'

let db: PGlite
const owner = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const device = '33333333-3333-4333-8333-333333333333'
const otherDevice = '44444444-4444-4444-8444-444444444444'
const obsId = '55555555-5555-4555-8555-555555555555'
const episode = { id: 'alpha', case_name: 'Alpha', issue_worked_on: null, work_type: 'project', started_at: '2026-09-24T13:00:00Z', ended_at: '2026-09-24T14:00:00Z', created_at: '2026-09-24T13:00:00Z', duration_minutes: 30, active_seconds: 1800, key_observations: [{ timestamp: '13:00', text: 'Original' }], agent_revision: 1, is_reportable: true, observation_count: 1 }
const observation = { id: obsId, episode_id: 'alpha', title: 'Ledger', summary: 'Original', observed_at: episode.started_at, start_time: episode.started_at, end_time: episode.ended_at, applications: ['Word'], entities: ['Alpha'], activity_type: 'drafting' }
const syncEp = (payload = episode, user = owner, dev = device) => db.query('SELECT sync_agent_episode($1, $2, $3)', [dev, user, JSON.stringify(payload)])
const syncObs = (payload = observation, user = owner, dev = device) => db.query('SELECT sync_agent_observations($1, $2, $3)', [dev, user, JSON.stringify([payload])])

beforeAll(async () => {
  db = new PGlite()
  // Minimal pre-020 schema, with the actual migration applied below.
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql AS $$ SELECT null::uuid $$;
    CREATE TABLE devices (id UUID PRIMARY KEY, user_id UUID, revoked_at TIMESTAMPTZ);
    CREATE TABLE episodes (id TEXT PRIMARY KEY, user_id UUID, device_id UUID REFERENCES devices(id), case_name TEXT, issue_worked_on TEXT, work_type TEXT,
      started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ, duration_minutes NUMERIC, active_seconds NUMERIC,
      key_observations JSONB, created_at TIMESTAMPTZ, edited_at TIMESTAMPTZ, is_reportable BOOLEAN DEFAULT true);
    CREATE TABLE observations (id UUID PRIMARY KEY, user_id UUID, episode_id TEXT REFERENCES episodes(id), title TEXT, summary TEXT,
      observed_at TIMESTAMPTZ, start_time TIMESTAMPTZ, end_time TIMESTAMPTZ, applications JSONB, entities JSONB, activity_type TEXT, is_approved BOOLEAN DEFAULT false, edited_at TIMESTAMPTZ);
    CREATE TABLE episode_screenshots (episode_id TEXT REFERENCES episodes(id), user_id UUID);
    ALTER TABLE episodes ENABLE ROW LEVEL SECURITY; ALTER TABLE observations ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "users read own episodes" ON episodes FOR SELECT USING (auth.uid() = user_id);
    CREATE POLICY "users read own observations" ON observations FOR SELECT USING (auth.uid() = user_id);
  `)
  await db.exec(readFileSync('supabase/migrations/020_reliable_agent_flow.sql', 'utf8'))
  await db.query('INSERT INTO devices (id, user_id) VALUES ($1,$2),($3,$4)', [device, owner, otherDevice, other])
}, 30000)
afterAll(async () => { await db?.close() })

it('requires the parent, preserves edits across retries, and rejects account collisions', async () => {
  await expect(syncObs()).rejects.toThrow('Sync parent first')
  await syncEp()
  await syncObs()
  await db.query('UPDATE observations SET summary = $1, is_approved = true WHERE id = $2', ['Corrected', obsId])
  await syncObs()
  expect((await db.query('SELECT summary, is_approved FROM observations')).rows).toEqual([{ summary: 'Corrected', is_approved: true }])
  await expect(syncEp(episode, other, otherDevice)).rejects.toThrow('another device')
  await expect(syncObs(observation, other, otherDevice)).rejects.toThrow('Invalid parent owner')
  await db.query("UPDATE episodes SET case_name = 'User matter', edited_at = now() WHERE id = 'alpha'")
  await syncEp({ ...episode, agent_revision: 2 })
  expect((await db.query('SELECT case_name FROM episodes')).rows).toEqual([{ case_name: 'User matter' }])
})

it('does not resurrect deleted observations or episodes', async () => {
  await db.query('UPDATE observations SET deleted_at = now() WHERE id = $1', [obsId])
  await syncObs()
  expect((await db.query<{ removed: boolean }>('SELECT deleted_at IS NOT NULL AS removed FROM observations')).rows[0].removed).toBe(true)
  await db.query("UPDATE episodes SET deleted_at = now() WHERE id = 'alpha'")
  await syncEp({ ...episode, agent_revision: 3 })
  expect((await db.query<{ removed: boolean }>('SELECT deleted_at IS NOT NULL AS removed FROM episodes')).rows[0].removed).toBe(true)
})

it('moves observations during a transactional merge and blocks duplicate/overlapping merges', async () => {
  const first = { ...episode, id: 'first' }, second = { ...episode, id: 'second', started_at: '2026-09-24T15:00:00Z', ended_at: '2026-09-24T16:00:00Z' }
  await syncEp(first); await syncEp(second)
  await syncObs({ ...observation, id: '66666666-6666-4666-8666-666666666666', episode_id: 'second' })
  await expect(db.query('SELECT merge_work_episodes($1,$2,$3)', [owner, 'first', 'first'])).rejects.toThrow('two different')
  await db.query('SELECT merge_work_episodes($1,$2,$3)', [owner, 'first', 'second'])
  expect((await db.query("SELECT active_seconds::float8 AS seconds FROM episodes WHERE id = 'first'")).rows[0]).toEqual({ seconds: 3600 })
  expect((await db.query("SELECT episode_id FROM observations WHERE id = '66666666-6666-4666-8666-666666666666'")).rows[0]).toEqual({ episode_id: 'first' })
  await syncEp({ ...second, agent_revision: 4 })
  expect((await db.query("SELECT deleted_at IS NOT NULL AS removed FROM episodes WHERE id = 'second'")).rows[0]).toEqual({ removed: true })
  await syncEp({ ...episode, id: 'overlap' })
  await expect(db.query('SELECT merge_work_episodes($1,$2,$3)', [owner, 'first', 'overlap'])).rejects.toThrow('overlapping')
})

it('denies direct browser execution of privileged ingestion functions', async () => {
  const { rows } = await db.query(`SELECT has_function_privilege('authenticated', 'sync_agent_episode(uuid,uuid,jsonb)', 'execute') AS permitted`)
  expect(rows[0]).toEqual({ permitted: false })
})

it('accepts a corrected switch boundary from a newer revision and ignores stale retries', async () => {
  await syncEp({ ...episode, id: 'switch-boundary', observation_count: 0 })
  await syncEp({ ...episode, id: 'switch-boundary', ended_at: '2026-09-24T13:20:00Z', active_seconds: 1200, duration_minutes: 20, agent_revision: 2, observation_count: 0 })
  await syncEp({ ...episode, id: 'switch-boundary', observation_count: 0 })
  expect((await db.query("SELECT duration_minutes::float8 AS minutes FROM episodes WHERE id = 'switch-boundary'")).rows[0]).toEqual({ minutes: 20 })
})
