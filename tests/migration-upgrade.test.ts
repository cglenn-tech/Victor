import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const migration = (name: string) => readFileSync(`supabase/migrations/${name}.sql`, 'utf8')
const owner = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const device = '33333333-3333-4333-8333-333333333333'
const observationId = '55555555-5555-4555-8555-555555555555'

it.each(['missing', '018', '019'])('upgrades %s observations, preserves work and can be rerun', async (version) => {
  const db = new PGlite()
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (id UUID PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      GRANT USAGE ON SCHEMA auth TO authenticated;
    `)
    // Real historical SQL in an isolated database, rather than an idealized
    // schema that already contains every prerequisite (the original blind spot).
    for (const name of ['004_final_schema', '005_is_reportable', '006_auth_and_devices', '009_episode_screenshots']) {
      await db.exec(migration(name))
    }
    await db.query('INSERT INTO auth.users (id) VALUES ($1),($2)', [owner, other])
    await db.query('INSERT INTO devices (id,user_id,name,token_hash) VALUES ($1,$2,$3,$4)', [device, owner, 'Fictional Mac', 'test-hash'])
    await db.query(`INSERT INTO episodes (id, user_id, case_name, started_at, ended_at, duration_minutes, key_observations, created_at)
      VALUES ('legacy', $1, 'Preserve this matter', '2026-09-24T13:00:00Z', '2026-09-24T14:00:00Z', 60,
      '[{"text":"Preserve original work"}]', '2026-09-24T13:00:00Z')`, [owner])
    if (version !== 'missing') {
      await db.exec(migration('018_observations'))
      await db.query('INSERT INTO observations (id,user_id,summary) VALUES ($1,$2,$3)', [observationId, owner, 'Keep my correction'])
      if (version === '019') {
        await db.exec(migration('019_observations_structured'))
        await db.exec(`UPDATE observations SET is_approved = true, edited_at = now(), episode_id = 'legacy'`)
      }
    }
    await db.exec(migration('020_reliable_agent_flow'))
    // An interrupted rollout or retry must not delete work or collide on policies.
    await db.exec(migration('020_reliable_agent_flow'))
    expect((await db.query('SELECT case_name, duration_minutes::float8 AS minutes FROM episodes')).rows).toEqual([
      { case_name: 'Preserve this matter', minutes: 60 },
    ])
    expect((await db.query('SELECT name, token_hash FROM devices')).rows).toEqual([
      { name: 'Fictional Mac', token_hash: 'test-hash' },
    ])
    if (version !== 'missing') {
      expect((await db.query('SELECT summary,is_approved FROM observations')).rows).toEqual([
        { summary: 'Keep my correction', is_approved: version === '019' },
      ])
    }
    const episode = { id: 'new', case_name: 'Alpha', issue_worked_on: null, work_type: 'project',
      started_at: '2026-09-24T15:00:00Z', ended_at: '2026-09-24T16:00:00Z', created_at: '2026-09-24T15:00:00Z',
      active_seconds: 1800, duration_minutes: 30, key_observations: [], agent_revision: 1, is_reportable: true, observation_count: 1 }
    await db.query('SELECT sync_agent_episode($1,$2,$3)', [device, owner, JSON.stringify(episode)])
    const observation = { id: '66666666-6666-4666-8666-666666666666', episode_id: 'new', title: 'Fictional review', summary: 'Reviewed Alpha',
      observed_at: episode.started_at, start_time: episode.started_at, end_time: episode.ended_at, applications: ['Word'], entities: ['Alpha'], activity_type: 'drafting' }
    await db.query('SELECT sync_agent_observations($1,$2,$3)', [device, owner, JSON.stringify([observation])])
    // New tables have both grants and owner-scoped RLS, including after a rerun.
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [owner])
    await db.exec('SET ROLE authenticated')
    expect((await db.query('SELECT id FROM observations')).rows).toHaveLength(version === 'missing' ? 1 : 2)
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [other])
    expect((await db.query('SELECT id FROM observations')).rows).toEqual([])
    await expect(db.query('SELECT sync_agent_episode($1,$2,$3)', [device, owner, JSON.stringify(episode)])).rejects.toThrow('permission denied')
    await db.exec('RESET ROLE')
    await db.query('SELECT merge_work_episodes($1,$2,$3)', [owner, 'legacy', 'new'])
    expect((await db.query("SELECT episode_id FROM observations WHERE id = $1", [observation.id])).rows).toEqual([{ episode_id: 'legacy' }])
  } finally {
    await db.close()
  }
}, 30000)
