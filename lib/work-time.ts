import type { Episode } from '@/lib/types'

export function activeMinutes(ep: Episode): number {
  const value = ep.active_seconds == null ? Number(ep.duration_minutes) : Number(ep.active_seconds) / 60
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function dateInZone(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso))
  const get = (type: string) => parts.find(p => p.type === type)!.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

export function periodBounds(start: string, end: string, timeZone: string) {
  const valid = (s: string) => /^\d{4}-\d\d-\d\d$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s
  if (!valid(start) || !valid(end) || start > end || Date.parse(end) - Date.parse(start) > 366 * 86400000) throw new Error('Choose a valid date range of up to one year')
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
  function midnight(day: string) {
    const target = Date.parse(day + 'T00:00:00Z')
    let instant = target
    for (let i = 0; i < 4; i++) {
      const parts = fmt.formatToParts(new Date(instant))
      const get = (type: string) => Number(parts.find(p => p.type === type)!.value)
      const displayed = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
      const delta = target - displayed
      instant += delta
      if (!delta) break
    }
    return new Date(instant).toISOString()
  }
  const nextDay = new Date(Date.parse(end) + 86400000).toISOString().slice(0, 10)
  return { start: midnight(start), end: midnight(nextDay) }
}
