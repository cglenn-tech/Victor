import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@/lib/supabase-server', () => ({ getServerClient: vi.fn() }))
vi.mock('@/lib/supabase-admin', () => ({ getAdminClient: vi.fn() }))
import { getServerClient } from '@/lib/supabase-server'
import { getAdminClient } from '@/lib/supabase-admin'
import { PATCH, DELETE } from './route'
const params = { params: Promise.resolve({ id: 'obs-1' }) }
let user: { id: string } | null
let existing: { id: string; user_id: string } | null
let patch: Record<string, unknown>
let failure: null | { message: string }
beforeEach(() => {
  user = { id: 'owner' }; existing = { id: 'obs-1', user_id: 'owner' }; patch = {}; failure = null
  const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), is: vi.fn().mockReturnThis(), update: vi.fn((p) => { patch = p; return query }), single: vi.fn(async () => ({ data: Object.keys(patch).length ? { ...existing, ...patch } : existing, error: failure })), then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: failure }).then(resolve) }
  vi.mocked(getAdminClient).mockReturnValue({ from: () => query } as unknown as ReturnType<typeof getAdminClient>)
  vi.mocked(getServerClient).mockResolvedValue({ auth: { getUser: async () => ({ data: { user } }) }, from: () => query } as unknown as Awaited<ReturnType<typeof getServerClient>>)
})
const request = (body: unknown) => new Request('http://localhost/observation', { method: 'PATCH', body: JSON.stringify(body) })
describe('observation review', () => {
  it('requires sign-in for edits and deletions', async () => {
    user = null
    expect((await PATCH(request({ summary: 'x' }), params)).status).toBe(401)
    expect((await DELETE(request({}), params)).status).toBe(401)
  })
  it('rejects edits to another account', async () => {
    existing!.user_id = 'someone-else'
    expect((await PATCH(request({ summary: 'x' }), params)).status).toBe(403)
  })
  it('requires renewed approval when text changes', async () => {
    const res = await PATCH(request({ summary: 'Corrected text' }), params)
    expect(res.status).toBe(200)
    expect(patch).toMatchObject({ summary: 'Corrected text', is_approved: false })
    expect(patch.edited_at).toBeTruthy()
  })
  it('supports explicit approval and rejects malformed edits', async () => {
    expect((await PATCH(request({ is_approved: true }), params)).status).toBe(200)
    expect(patch).toEqual({ is_approved: true })
    expect((await PATCH(request({ summary: '' }), params)).status).toBe(400)
  })
  it('writes a tombstone so offline retries cannot restore deleted text', async () => {
    expect((await DELETE(request({}), params)).status).toBe(204)
    expect(patch.deleted_at).toBeTruthy()
    expect(patch.is_approved).toBe(false)
    failure = { message: 'DB unavailable' }
    expect((await DELETE(request({}), params)).status).toBe(500)
  })
})
