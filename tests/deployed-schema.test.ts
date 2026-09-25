import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { buildReport, reviewedEpisodes } from '../lib/report'
import { periodBounds } from '../lib/work-time'
import type { Episode, Observation } from '../lib/types'

const migration = (name: string) => readFileSync(`supabase/migrations/${name}.sql`, 'utf8')
const owner = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const device = '33333333-3333-4333-8333-333333333333'

it('upgrades the exported deployment schema, preserves unowned history, and saves an owner-only report', async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; CREATE TABLE auth.users (id UUID PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      GRANT USAGE ON SCHEMA auth TO authenticated, anon;
    `)
    for (const name of ['004_final_schema', '005_is_reportable', '006_auth_and_devices',
      '009_episode_screenshots', '012_episode_extended_fields', '017_devices_app_version',
      '018_releases_minimum_version', '019_devices_installation_id']) {
      await db.exec(migration(name))
    }
    // This combination matches the actual column export: auth/device tables
    // exist, but episodes lost ownership and observations/reports never existed.
    await db.exec('ALTER TABLE episodes DROP COLUMN user_id CASCADE, DROP COLUMN device_id CASCADE')
    const actual = (await db.query<{ table_name: string; column_name: string; data_type: string }>(`
      SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' ORDER BY table_name, ordinal_position
    `)).rows.map(r => `${r.table_name},${r.column_name},${r.data_type}`).join('\n')
    const exported = readFileSync('tests/fixtures/deployed-schema.csv', 'utf8').trim().split('\n').slice(1).join('\n')
    expect(actual).toBe(exported)

    // Include a permissive legacy policy to verify the repair cannot expose
    // historical rows just because a deployment kept an old policy name.
    await db.exec(`CREATE POLICY "old public read" ON episodes FOR SELECT USING (true);
      GRANT SELECT ON episodes TO anon, authenticated;`)
    await db.query('INSERT INTO auth.users (id) VALUES ($1),($2)', [owner, other])
    await db.query('INSERT INTO devices (id,user_id,name,token_hash) VALUES ($1,$2,$3,$4)', [device, owner, 'Fictional Mac', 'test-hash'])
    await db.exec(`INSERT INTO episodes (id,case_name,started_at,ended_at,duration_minutes,key_observations,created_at)
      VALUES ('unowned-history','Preserve history','2026-09-24T10:00:00Z','2026-09-24T11:00:00Z',60,
      '[{"text":"Original historical work"}]','2026-09-24T10:00:00Z')`)
    const before = (await db.query<{ row: Record<string, unknown> }>('SELECT to_jsonb(e) AS row FROM episodes e')).rows[0].row
    await db.exec(migration('020_reliable_agent_flow'))
    await db.exec(migration('020_reliable_agent_flow'))
    const after = (await db.query<{ row: Record<string, unknown> }>('SELECT to_jsonb(e) AS row FROM episodes e')).rows[0].row
    for (const [key, value] of Object.entries(before)) expect(after[key]).toEqual(value)
    expect(after.user_id).toBeNull()
    expect(after.device_id).toBeNull()

    const episode = { id: 'new', case_name: 'Alpha', issue_worked_on: null, work_type: 'project',
      started_at: '2026-09-24T13:00:00Z', ended_at: '2026-09-24T14:00:00Z', created_at: '2026-09-24T13:00:00Z',
      active_seconds: 1800, duration_minutes: 30, key_observations: [], agent_revision: 1, is_reportable: true, observation_count: 1 }
    await db.query('SELECT sync_agent_episode($1,$2,$3)', [device, owner, JSON.stringify(episode)])
    const observation = { id: '55555555-5555-4555-8555-555555555555', episode_id: 'new', title: 'Review Alpha', summary: 'Reviewed fictional agreement',
      observed_at: episode.started_at, start_time: episode.started_at, end_time: episode.ended_at, applications: ['Word'], entities: ['Alpha'], activity_type: 'drafting' }
    await db.query('SELECT sync_agent_observations($1,$2,$3)', [device, owner, JSON.stringify([observation])])
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [owner])
    await db.exec('SET ROLE authenticated')
    expect((await db.query('SELECT id FROM episodes')).rows).toEqual([{ id: 'new' }])
    await db.query('UPDATE observations SET summary=$1,is_approved=true,edited_at=now() WHERE id=$2', ['Corrected and approved work', observation.id])
    // Use the same report builder and fields as the real API, then read its saved export.
    const episodes = (await db.query<{ data: Episode }>('SELECT to_jsonb(e) AS data FROM episodes e')).rows
    const observations = (await db.query<{ data: Observation }>('SELECT to_jsonb(o) AS data FROM observations o')).rows
    const reviewed = reviewedEpisodes(episodes.map(r => r.data), observations.map(r => r.data))
    expect(reviewed.needsReview).toBe(0)
    const { report, summary } = buildReport(reviewed.ready, '2026-09-24', 'UTC', false, periodBounds('2026-09-24', '2026-09-24', 'UTC'))
    expect(report).toContain('Corrected and approved work')
    const saved = await db.query<{ id: string }>(`INSERT INTO weekly_reports
      (user_id,week_start,week_end,period_start,period_end,period_label,source_episode_ids,summary_json,content,version)
      VALUES ($1,'2026-09-24','2026-09-24','2026-09-24','2026-09-24','2026-09-24','["new"]',$2,$3,1) RETURNING id`,
      [owner, JSON.stringify(summary), report])
    const reportId = saved.rows[0].id
    expect((await db.query('SELECT content FROM weekly_reports WHERE id=$1', [reportId])).rows).toEqual([{ content: report }])
    await db.exec('RESET ROLE')
    await db.exec(migration('020_reliable_agent_flow'))
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [other])
    await db.exec('SET ROLE authenticated')
    for (const table of ['episodes', 'observations', 'weekly_reports']) expect((await db.query(`SELECT id FROM ${table}`)).rows).toEqual([])
    await db.exec('RESET ROLE; SET ROLE anon')
    expect((await db.query('SELECT id FROM episodes')).rows).toEqual([])
    await db.exec('RESET ROLE')
    expect((await db.query('SELECT content FROM weekly_reports WHERE id=$1', [reportId])).rows).toEqual([{ content: report }])
  } finally {
    await db.close()
  }
}, 30000)
