import { describe, expect, it } from 'vitest'
import { hasRecentHeartbeat, isAgentState, needsAgentUpdate, type DeviceStatus } from './agent-status'

describe('desktop connection evidence', () => {
  it('only recommends a download for a known older version', () => {
    for (const version of [undefined, null, '', 'unknown', '1.1', 'bad.version']) {
      expect(needsAgentUpdate(version, '1.1.1')).toBe(false)
    }
    expect(needsAgentUpdate('1.1.0', '1.1.1')).toBe(true)
    expect(needsAgentUpdate('1.1.1', '1.1.1')).toBe(false)
    expect(needsAgentUpdate('1.10.0', '1.1.1')).toBe(false)
  })

  it('expires a heartbeat even if a device was linked previously', () => {
    const now = Date.now()
    const device: DeviceStatus = { id: 'd', name: 'My Mac', app_version: '1.1.1', recording_requested: false, last_seen_at: new Date(now-5000).toISOString() }
    expect(hasRecentHeartbeat(device, now)).toBe(true)
    expect(hasRecentHeartbeat(device, now+90_000)).toBe(false)
    expect(hasRecentHeartbeat({ ...device, last_seen_at: null }, now)).toBe(false)
    expect(hasRecentHeartbeat({ ...device, last_seen_at: 'invalid' }, now)).toBe(false)
    expect(hasRecentHeartbeat({ ...device, last_seen_at: new Date(now+60_000).toISOString() }, now)).toBe(false)
  })

  it('accepts the idle status already sent in agent presence', () => {
    expect(isAgentState('idle')).toBe(true)
    expect(isAgentState('recording')).toBe(true)
    expect(isAgentState(undefined)).toBe(false)
    expect(isAgentState('anything')).toBe(false)
  })
})
