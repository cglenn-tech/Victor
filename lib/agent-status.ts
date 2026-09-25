export type DeviceStatus = {
  id: string
  name: string
  last_seen_at: string | null
  app_version: string | null
  recording_requested: boolean
}

export const MIN_AGENT_VERSION = process.env.NEXT_PUBLIC_MIN_AGENT_VERSION ?? '1.1.1'

// An absent version is a connection/identification problem, not evidence of an old install.
export function needsAgentUpdate(version: unknown, minimum = MIN_AGENT_VERSION): boolean {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return false
  const actual = version.split('.').map(Number)
  const required = minimum.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== required[i]) return actual[i] < required[i]
  }
  return false
}

export function hasRecentHeartbeat(device: DeviceStatus, now = Date.now()): boolean {
  if (!device.last_seen_at) return false
  const age = now - Date.parse(device.last_seen_at)
  return Number.isFinite(age) && age >= 0 && age < 90_000
}

export const AGENT_STATES = ['connecting', 'idle', 'recording', 'stopping', 'finalizing', 'sync_pending', 'error'] as const
export type AgentState = typeof AGENT_STATES[number]
export function isAgentState(value: unknown): value is AgentState {
  return typeof value === 'string' && (AGENT_STATES as readonly string[]).includes(value)
}
