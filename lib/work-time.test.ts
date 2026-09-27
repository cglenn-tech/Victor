import { describe, expect, it } from 'vitest'
import { minutesInPeriod, periodBounds } from './work-time'
import type { Episode } from './types'
const ep = { id: 'work', case_name: 'Case', work_type: 'project', started_at: '2026-09-14T14:00:00Z', ended_at: '2026-09-14T14:15:00Z', created_at: '2026-09-26T20:00:00Z', duration_minutes: 15, key_observations: [] } as Episode
describe('recorded work dates', () => {
  it('keeps late uploads in the week they were captured', () => {
    expect(minutesInPeriod(ep, periodBounds('2026-09-21', '2026-09-27', 'America/New_York'))).toBe(0)
    expect(minutesInPeriod(ep, periodBounds('2026-09-14', '2026-09-20', 'America/New_York'))).toBe(15)
  })
  it('clips across a local week boundary and excludes voided or malformed work', () => {
    const bounds = periodBounds('2026-09-21', '2026-09-27', 'America/New_York')
    const crossing = { ...ep, started_at: '2026-09-21T03:50:00Z', ended_at: '2026-09-21T04:10:00Z', duration_minutes: 20 }
    expect(minutesInPeriod(crossing, bounds)).toBe(10)
    expect(minutesInPeriod({ ...crossing, is_reportable: false }, bounds)).toBe(0)
    expect(minutesInPeriod({ ...crossing, deleted_at: '2026-09-26T20:00:00Z' }, bounds)).toBe(0)
    expect(minutesInPeriod({ ...crossing, started_at: 'unknown' }, bounds)).toBe(0)
  })
  it('uses a 23-hour day across the spring DST transition', () => {
    const bounds = periodBounds('2026-03-08', '2026-03-08', 'America/New_York')
    expect((Date.parse(bounds.end) - Date.parse(bounds.start)) / 3600000).toBe(23)
  })
})
