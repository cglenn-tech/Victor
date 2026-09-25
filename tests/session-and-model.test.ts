import { beforeEach, it, expect, vi } from 'vitest'
vi.mock('@/lib/supabase-server', () => ({ getServerClient: vi.fn() }))
vi.mock('@/lib/supabase-admin', () => ({ getAdminClient: vi.fn() }))
vi.mock('@/lib/device-auth', () => ({ getDeviceFromToken: vi.fn() }))
vi.mock('@/lib/model-client', () => ({ isModelConfigured: vi.fn(), chatCompletion: vi.fn() }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: vi.fn() }))
import { getServerClient } from '@/lib/supabase-server'
import { getAdminClient } from '@/lib/supabase-admin'
import { getDeviceFromToken } from '@/lib/device-auth'
import { chatCompletion, isModelConfigured } from '@/lib/model-client'
import { rateLimit } from '@/lib/rate-limit'
import { POST as command } from '@/app/api/device/session/route'
import { GET as heartbeat, POST as resetSession } from '@/app/api/device/heartbeat/route'
import { POST as analyze } from '@/app/api/agent/analyze/route'
let update: ReturnType<typeof vi.fn>, eq: ReturnType<typeof vi.fn>
let row: { recording_requested: boolean; browser_seen_at: string }
let user: { id: string } | null
beforeEach(() => {
  vi.clearAllMocks()
  user = { id: 'owner-a' }
  row = { recording_requested: true, browser_seen_at: new Date().toISOString() }
  update = vi.fn().mockReturnThis(); eq = vi.fn().mockReturnThis()
  const query = { update, eq, is: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), single: async () => ({ data: row, error: null }), then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [{ id: 'device-a' }], error: null }).then(resolve) }
  vi.mocked(getAdminClient).mockReturnValue({ from: () => query } as unknown as ReturnType<typeof getAdminClient>)
  vi.mocked(getServerClient).mockResolvedValue({ auth: { getUser: async () => ({ data: { user } }) } } as unknown as Awaited<ReturnType<typeof getServerClient>>)
  vi.mocked(getDeviceFromToken).mockResolvedValue({ id: 'device-a', user_id: 'owner-a', installation_id: null })
  vi.mocked(isModelConfigured).mockReturnValue(true)
  vi.mocked(rateLimit).mockResolvedValue(false)
  vi.mocked(chatCompletion).mockResolvedValue('{"summary":"fictional"}')
})
const req = (body: unknown) => new Request('http://localhost/test', { method: 'POST', body: JSON.stringify(body) })
it('scopes sign-out stop to the authenticated account and heartbeat never starts capture', async () => {
  expect((await command(req({ action: 'stop' }))).status).toBe(200)
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ recording_requested: false }))
  expect(eq).toHaveBeenCalledWith('user_id', 'owner-a')
  update.mockClear()
  await command(req({ action: 'heartbeat' }))
  expect(update.mock.calls[0][0]).not.toHaveProperty('recording_requested')
  user = null
  expect((await command(req({ action: 'start', deviceId: 'device-a' }))).status).toBe(401)
})
it('requires configuration to start and expires capture after ten minutes', async () => {
  vi.mocked(isModelConfigured).mockReturnValue(false)
  expect((await command(req({ action: 'start', deviceId: 'device-a' }))).status).toBe(503)
  expect(update).not.toHaveBeenCalled()
  vi.mocked(isModelConfigured).mockReturnValue(true)
  expect((await (await heartbeat(req({}))).json()).recording_allowed).toBe(true)
  row.browser_seen_at = new Date(Date.now() - 601_000).toISOString()
  expect((await (await heartbeat(req({}))).json()).recording_allowed).toBe(false)
  row = { recording_requested: false, browser_seen_at: new Date().toISOString() }
  expect((await (await heartbeat(req({}))).json()).recording_allowed).toBe(false)
})
it('records the running version and returns authenticated account identity on startup', async () => {
  const request = new Request('http://localhost/test', { method: 'POST', headers: { 'X-Victor-Version': '1.1.1' } })
  const response = await resetSession(request)
  expect(await response.json()).toEqual({ ok: true, user_id: 'owner-a', device_id: 'device-a' })
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ app_version: '1.1.1', recording_requested: false, last_seen_at: expect.any(String) }))
  update.mockClear()
  await heartbeat(new Request('http://localhost/test', { headers: { 'X-Victor-Version': 'invalid' } }))
  expect(update.mock.calls[0][0]).not.toHaveProperty('app_version')
})
it('authenticates image requests, allows only inline images and never calls the model for invalid input', async () => {
  vi.mocked(getDeviceFromToken).mockResolvedValue(null)
  expect((await analyze(req({}))).status).toBe(401)
  vi.mocked(getDeviceFromToken).mockResolvedValue({ id: 'd', user_id: 'u', installation_id: null })
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Describe visible work' }, { type: 'image_url', image_url: { url: 'https://outside.invalid/image.jpg' } }] }]
  expect((await analyze(req({ messages }))).status).toBe(400)
  expect(chatCompletion).not.toHaveBeenCalled()
  messages[0].content[1].image_url!.url = 'data:image/jpeg;base64,/9j/2Q=='
  expect((await analyze(req({ messages }))).status).toBe(200)
  expect(chatCompletion).toHaveBeenCalledTimes(1)
})
it('returns a visible service failure when the model is unavailable', async () => {
  vi.mocked(isModelConfigured).mockReturnValue(false)
  expect((await analyze(req({}))).status).toBe(503)
  expect(chatCompletion).not.toHaveBeenCalled()
})
