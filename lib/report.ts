import type { Episode, Observation } from '@/lib/types'
import { activeMinutes, dateInZone } from '@/lib/work-time'

export function fmtDur(minutes: number): string {
  const total = Math.round(minutes)
  const h = Math.floor(total / 60), m = total % 60
  return h ? `${h} hr${m ? ` ${m} min` : ''}` : `${m} min`
}

// All live observations in an episode must be reviewed before its time is included.
// No fallback to stale agent text when observations were deleted or unapproved.
export function reviewedEpisodes(episodes: Episode[], observations: Observation[]) {
  const byEpisode = new Map<string, Observation[]>()
  for (const o of observations) {
    if (!o.episode_id) continue
    const list = byEpisode.get(o.episode_id) ?? []
    list.push(o)
    byEpisode.set(o.episode_id, list)
  }
  const ready: Episode[] = []
  const seen = new Set<string>()
  let needsReview = 0
  for (const ep of episodes) {
    if (seen.has(ep.id) || ep.deleted_at || ep.is_reportable === false) continue
    seen.add(ep.id)
    const allRows = byEpisode.get(ep.id) ?? []
    const rows = allRows.filter(o => !o.deleted_at)
    if (allRows.length && !rows.length) continue
    if (rows.some(o => !o.is_approved) || (ep.device_id && !rows.length) || (ep.observation_count ?? 0) > allRows.length) {
      needsReview++
      continue
    }
    const keys = rows.length ? rows.map(o => ({ timestamp: o.start_time ?? o.observed_at, text: `${o.title ? o.title + ': ' : ''}${o.summary}` })) : ep.key_observations
    if (!keys?.length || !ep.case_name?.trim() || activeMinutes(ep) <= 0) continue
    ready.push({ ...ep, key_observations: keys })
  }
  return { ready, needsReview }
}

export function buildReport(episodes: Episode[], periodLabel: string, timeZone: string, roundTo15: boolean, bounds: { start: string; end: string }) {
  type Group = { title: string; is_administrative: boolean; episodes: Episode[]; totalMinutes: number }
  const groups = new Map<string, Group>()
  const seen = new Set<string>()
  let clipped = false
  for (const ep of episodes) {
    if (seen.has(ep.id)) continue
    seen.add(ep.id)
    const from = Math.max(Date.parse(ep.started_at), Date.parse(bounds.start))
    const to = Math.min(Date.parse(ep.ended_at), Date.parse(bounds.end))
    const wall = Date.parse(ep.ended_at) - Date.parse(ep.started_at)
    if (to <= from || wall <= 0) continue
    const fraction = (to - from) / wall
    if (fraction < 1) clipped = true
    const raw = activeMinutes(ep) * fraction
    const minutes = roundTo15 ? Math.round(raw / 15) * 15 : raw
    const admin = ep.work_type === 'administrative'
    const title = admin ? 'Administrative work' : ep.case_name.trim()
    const unassigned = !ep.edited_at && title.startsWith('Unassigned:')
    const key = unassigned ? ep.id : `${admin}:${title.toLowerCase().replace(/\s+/g, ' ')}`
    const group = groups.get(key) ?? { title, is_administrative: admin, episodes: [], totalMinutes: 0 }
    group.episodes.push({ ...ep, started_at: new Date(from).toISOString(), ended_at: new Date(to).toISOString(), duration_minutes: minutes })
    group.totalMinutes += minutes
    groups.set(key, group)
  }
  const all = [...groups.values()]
  const caseMinutes = all.filter(g => !g.is_administrative).reduce((s, g) => s + g.totalMinutes, 0)
  const adminMinutes = all.filter(g => g.is_administrative).reduce((s, g) => s + g.totalMinutes, 0)
  const summary = { periodLabel, timeZone, roundTo15, groups: all.map(g => ({ title: g.title, is_administrative: g.is_administrative, totalMinutes: g.totalMinutes, episode_ids: g.episodes.map(e => e.id) })), caseMinutes, adminMinutes, totalMinutes: caseMinutes + adminMinutes }
  const time = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit' })
  const lines = [`Work report: ${periodLabel}`, `Time zone: ${timeZone}`, 'Recorded time estimates; review before billing.', '']
  for (const g of all) lines.push(`${g.title}: ${fmtDur(g.totalMinutes)}`)
  lines.push('', `Case/project time: ${fmtDur(caseMinutes)}`, `Administrative time: ${fmtDur(adminMinutes)}`, `Total recorded time: ${fmtDur(summary.totalMinutes)}`)
  for (const g of all) {
    lines.push('', `${g.title} — ${fmtDur(g.totalMinutes)}`)
    let day = ''
    for (const ep of g.episodes.sort((a,b) => a.started_at.localeCompare(b.started_at))) {
      const nextDay = dateInZone(ep.started_at, timeZone)
      if (nextDay !== day) { day = nextDay; lines.push('', day) }
      lines.push(`  ${time(ep.started_at)}–${time(ep.ended_at)} (${fmtDur(ep.duration_minutes)})`)
      for (const o of ep.key_observations) if (o.text) lines.push(`  ${o.text}`)
    }
  }
  if (roundTo15) lines.push('', 'Each entry rounded to the nearest 15 minutes; all totals use those same values.')
  if (clipped) lines.push('', 'Intervals crossing the report boundary use a proportional estimate of active time.')
  return { report: lines.join('\n'), summary }
}
