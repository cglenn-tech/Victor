import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { episodePayload, observationPayload } from './agent-payload'
vi.mock('@/lib/supabase-admin', () => ({ getAdminClient: vi.fn() }))
import { getAdminClient } from './supabase-admin'
import { getDeviceFromToken } from './device-auth'
import { POST as episodeSync } from '@/app/api/episodes/sync/route'
import { POST as observationSync } from '@/app/api/observations/sync/route'
const token = Buffer.alloc(32, 42)
const ep = { id: 'e1', case_name: 'Alpha', work_type: 'project', started_at: '2026-09-24T13:00:00Z', ended_at: '2026-09-24T14:00:00Z', created_at: '2026-09-24T13:00:00Z', duration_minutes: 60, active_seconds: 1800, key_observations: [], agent_revision: 1 }
const obs = { id: '11111111-1111-4111-8111-111111111111', episode_id: 'e1', title: 'Ledger', summary: 'Reviewed ledger.', observed_at: ep.started_at }

describe('device authentication and ingestion', () => {
  it('uses the activation hash in BOTH sync routes and rejects malformed tokens', async () => {
    const expected = createHash('sha256').update(token).digest('hex')
    const eq = vi.fn().mockReturnThis()
    const client = { from: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), eq, is: vi.fn().mockReturnThis(), update: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: { id: 'd1', user_id: 'u1' } }), rpc: vi.fn().mockResolvedValue({ error: null }) }
    vi.mocked(getAdminClient).mockReturnValue(client as unknown as ReturnType<typeof getAdminClient>)
    for (const [handler, body] of [[episodeSync, ep], [observationSync, { observations: [obs] }]] as const) {
      const res = await handler(new Request('http://localhost/sync', { method: 'POST', headers: { Authorization: `Bearer ${token.toString('hex')}` }, body: JSON.stringify(body) }))
      expect(res.status).toBe(200)
    }
    expect(eq).toHaveBeenCalledWith('token_hash', expected)
    expect(client.rpc).toHaveBeenCalledWith('sync_agent_episode', expect.objectContaining({ p_device_id: 'd1', p_user_id: 'u1' }))
    client.from.mockClear()
    expect(await getDeviceFromToken(`Bearer ${token.toString('hex')}oops`)).toBeNull()
    expect(client.from).not.toHaveBeenCalled()
  })
  it('whitelists fields and validates finite durations before any write', () => {
    expect(episodePayload({ ...ep, user_id: 'victim', edited_at: ep.created_at, deleted_at: ep.created_at })).not.toHaveProperty('user_id')
    expect(episodePayload(ep).duration_minutes).toBe(30)
    expect(() => episodePayload({ ...ep, active_seconds: -1 })).toThrow()
    expect(() => episodePayload({ ...ep, active_seconds: Infinity })).toThrow()
    expect(observationPayload({ ...obs, is_approved: true })).not.toHaveProperty('is_approved')
    expect(() => observationPayload({ ...obs, episode_id: null })).toThrow()
  })
})
