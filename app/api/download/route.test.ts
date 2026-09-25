import { beforeEach, it, expect, vi } from 'vitest'
vi.mock('@/lib/supabase-server', () => ({ getServerClient: vi.fn() }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: vi.fn() }))
import { getServerClient } from '@/lib/supabase-server'
import { rateLimit } from '@/lib/rate-limit'
import { POST } from './route'
let user: { id: string; email_confirmed_at: string | null } | null
beforeEach(() => {
  user = { id: 'owner', email_confirmed_at: '2026-09-24' }
  vi.mocked(getServerClient).mockResolvedValue({ auth: { getUser: async () => ({ data: { user }, error: null }) } } as unknown as Awaited<ReturnType<typeof getServerClient>>)
  vi.mocked(rateLimit).mockResolvedValue(false)
})
it('requires a signed-in, verified account', async () => {
  user = null
  expect((await POST()).status).toBe(401)
  user = { id: 'owner', email_confirmed_at: null }
  expect((await POST()).status).toBe(403)
})
it('limits repeat downloads', async () => {
  vi.mocked(rateLimit).mockResolvedValue(true)
  expect((await POST()).status).toBe(429)
})
it('returns the current GitHub DMG distribution URL', async () => {
  const res = await POST()
  expect(res.status).toBe(200)
  expect((await res.json()).url).toBe('https://github.com/cglenn-tech/Victor/releases/latest/download/Victor-mac.dmg')
})
