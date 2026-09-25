// Explicit ingestion schema: device payloads cannot set ownership, approval or edits.
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
  return value as Record<string, unknown>
}

function text(value: unknown, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid text')
  return value.trim()
}

function date(value: unknown): string {
  const s = text(value, 40)
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(s) || !Number.isFinite(Date.parse(s))) throw new Error('Invalid timestamp')
  return new Date(s).toISOString()
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('Invalid list')
  return value.map(v => text(v, 300))
}

export function episodePayload(value: unknown) {
  const v = record(value)
  const start = date(v.started_at), end = date(v.ended_at)
  const wallSeconds = (Date.parse(end) - Date.parse(start)) / 1000
  const active = v.active_seconds ?? Number(v.duration_minutes) * 60
  if (wallSeconds < 0 || wallSeconds > 86400 || typeof active !== 'number' || !Number.isFinite(active) || active < 0 || active > wallSeconds + 1) throw new Error('Invalid duration')
  if (!Array.isArray(v.key_observations) || v.key_observations.length > 5000) throw new Error('Invalid observations')
  if (v.work_type !== 'project' && v.work_type !== 'administrative') throw new Error('Invalid work type')
  const revision = v.agent_revision ?? 0
  if (!Number.isSafeInteger(revision) || Number(revision) < 0) throw new Error('Invalid revision')
  return {
    id: text(v.id, 100), case_name: text(v.case_name, 500),
    issue_worked_on: v.issue_worked_on ? text(v.issue_worked_on) : null,
    work_type: v.work_type, started_at: start, ended_at: end,
    duration_minutes: active / 60, active_seconds: active,
    key_observations: v.key_observations.map(o => {
      const item = record(o)
      return { timestamp: text(item.timestamp, 40), text: text(item.text, 10000) }
    }),
    created_at: date(v.created_at), agent_revision: revision,
    is_reportable: v.is_reportable !== false,
    observation_count: Number.isSafeInteger(v.observation_count) && Number(v.observation_count) >= 0 ? v.observation_count : v.key_observations.length,
  }
}

export function observationPayload(value: unknown) {
  const v = record(value)
  const id = text(v.id, 36)
  if (!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)) throw new Error('Invalid observation ID')
  const start = date(v.start_time ?? v.observed_at), end = date(v.end_time ?? v.observed_at)
  if (end < start) throw new Error('Invalid observation interval')
  return {
    id, episode_id: text(v.episode_id, 100), title: text(v.title, 500),
    summary: text(v.summary, 10000), observed_at: start, start_time: start, end_time: end,
    applications: strings(v.applications ?? []), entities: strings(v.entities ?? []),
    activity_type: text(v.activity_type ?? 'other', 100),
  }
}
