import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase-server', () => ({ getServerClient: vi.fn() }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: vi.fn() }))

import { getServerClient } from '@/lib/supabase-server'
import { rateLimit } from '@/lib/rate-limit'
import { POST } from './route'

function mockAuth(options: { resetError?: { message: string; status?: number } | null } = {}) {
  const resetPasswordForEmail = vi.fn().mockResolvedValue({
    error: options.resetError ?? null,
  })
  vi.mocked(getServerClient).mockResolvedValue({
    auth: { resetPasswordForEmail },
  } as unknown as Awaited<ReturnType<typeof getServerClient>>)
  return { resetPasswordForEmail }
}

function req(body: Record<string, unknown>) {
  return new Request('http://localhost:3000/api/auth/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/auth/reset', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(rateLimit).mockResolvedValue(false)
  })

  it('returns 400 when email is missing', async () => {
    mockAuth()
    const res = await POST(req({}) as never)
    expect(res.status).toBe(400)
  })

  it('rate limits per email and returns 429', async () => {
    mockAuth()
    vi.mocked(rateLimit).mockResolvedValue(true)
    const res = await POST(req({ email: 'someone@example.com' }) as never)
    expect(res.status).toBe(429)
    expect(vi.mocked(rateLimit)).toHaveBeenCalledWith('reset:someone@example.com', 3, 3600)
  })

  it('sends the reset email with a server-derived /auth/reset redirect', async () => {
    const { resetPasswordForEmail } = mockAuth()
    const res = await POST(req({ email: 'someone@example.com' }) as never)
    expect(res.status).toBe(200)
    expect(resetPasswordForEmail).toHaveBeenCalledWith('someone@example.com', {
      redirectTo: 'http://localhost:3000/auth/reset',
    })
  })

  it('returns generic ok when supabase errors (does not reveal account existence)', async () => {
    mockAuth({ resetError: { message: 'user not found', status: 400 } })
    const res = await POST(req({ email: 'nobody@example.com' }) as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true })
  })

  it('surfaces 429 when supabase itself rate limits', async () => {
    mockAuth({ resetError: { message: 'rate limit exceeded', status: 429 } })
    const res = await POST(req({ email: 'someone@example.com' }) as never)
    expect(res.status).toBe(429)
  })
})
