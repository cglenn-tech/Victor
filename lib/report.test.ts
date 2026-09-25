import { describe, it, expect } from 'vitest'
import { buildReport, reviewedEpisodes, fmtDur } from './report'
import { periodBounds } from './work-time'
import type { Episode, Observation } from './types'

const alpha: Episode = { id: 'alpha', device_id: 'device', case_name: 'Client Alpha', work_type: 'project', started_at: '2026-09-24T13:00:00Z', ended_at: '2026-09-24T14:00:00Z', duration_minutes: 60, active_seconds: 1800, key_observations: [{ timestamp: '13:00', text: 'OLD INCORRECT SUMMARY' }], created_at: '2026-09-24T13:00:00Z' }
const observation: Observation = { id: 'obs', user_id: 'owner', episode_id: alpha.id, observed_at: alpha.started_at, created_at: alpha.started_at, title: 'Payment records', summary: 'Reviewed the corrected payment ledger.', is_approved: true }
const bounds = periodBounds('2026-09-24', '2026-09-24', 'America/New_York')

describe('reviewed work report', () => {
  it('renders corrections, keeps two clients separate, and subtracts idle time', () => {
    const beta = { ...alpha, id: 'beta', case_name: 'Client Beta', started_at: '2026-09-24T15:00:00Z', ended_at: '2026-09-24T16:00:00Z', active_seconds: 1200 }
    const { ready } = reviewedEpisodes([alpha, beta], [observation, { ...observation, id: 'obs2', episode_id: 'beta', summary: 'Drafted the Beta agreement.' }])
    const result = buildReport(ready, 'Test week', 'America/New_York', false, bounds)
    expect(result.report).toContain('Reviewed the corrected payment ledger.')
    expect(result.report).not.toContain('OLD INCORRECT')
    expect(result.report).toContain('9:00 AM')
    expect(result.summary.groups).toHaveLength(2)
    expect(result.summary.totalMinutes).toBe(50)
  })
  it('does not revive deleted text or silently include unapproved work', () => {
    expect(reviewedEpisodes([alpha], [{ ...observation, is_approved: false }]).needsReview).toBe(1)
    expect(reviewedEpisodes([alpha], [{ ...observation, deleted_at: alpha.ended_at }]).ready).toEqual([])
    expect(reviewedEpisodes([alpha], []).needsReview).toBe(1)
    expect(reviewedEpisodes([{ ...alpha, observation_count: 2 }], [observation]).needsReview).toBe(1)
  })
  it('includes manual records without a model and counts duplicate IDs once', () => {
    const manual = { ...alpha, device_id: null }
    const { ready } = reviewedEpisodes([manual, manual], [])
    const result = buildReport(ready, 'Test', 'UTC', false, bounds)
    expect(result.summary.totalMinutes).toBe(30)
  })
  it('uses identical rounded values in the text and summary', () => {
    const result = buildReport([{ ...alpha, active_seconds: 1300 }], 'Test', 'UTC', true, bounds)
    expect(result.summary.totalMinutes).toBe(15)
    expect(result.report).toContain('Total recorded time: 15 min')
    expect(fmtDur(59.9)).toBe('1 hr')
  })
  it('handles daylight saving boundaries and clips cross-period intervals', () => {
    expect(periodBounds('2026-03-08', '2026-03-08', 'America/New_York')).toEqual({ start: '2026-03-08T05:00:00.000Z', end: '2026-03-09T04:00:00.000Z' })
    expect(periodBounds('2026-11-01', '2026-11-01', 'America/New_York')).toEqual({ start: '2026-11-01T04:00:00.000Z', end: '2026-11-02T05:00:00.000Z' })
    const result = buildReport([{ ...alpha, started_at: '2026-09-24T03:30:00Z', ended_at: '2026-09-24T04:30:00Z', active_seconds: 3600 }], 'Test', 'America/New_York', false, bounds)
    expect(result.summary.totalMinutes).toBe(30)
    expect(result.report).toContain('proportional estimate')
    expect(() => periodBounds('2026-02-30', '2026-03-01', 'UTC')).toThrow()
  })
})
