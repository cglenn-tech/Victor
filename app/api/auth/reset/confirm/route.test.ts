import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn() }))

import { createServerClient } from '@supabase/ssr'
import { POST } from './route'

function mockSupabase(options: { verifyError?: { message: string; status?: number } | null } = {}) {
  const verifyOtp = vi.fn().mockResolvedValue({
    data: options.verifyError
      ? { user: null }
      : { user: { id: 'usr-1', email: 'test@example.com' } },
    error: options.verifyError ?? null,
  })
  vi.mocked(createServerClient).mockReturnValue({
    auth: { verifyOtp },
  } as unknown as ReturnType<typeof createServerClient>)
  return { verifyOtp }
}

function req(body: Record<string, unknown>) {
  return {
    json: async () => body,
    cookies: { getAll: () => [] },
  } as unknown as Parameters<typeof POST>[0]
}

describe('POST /api/auth/reset/confirm (recovery-only exchange)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('exchanges type=recovery and calls verifyOtp with recovery', async () => {
    const { verifyOtp } = mockSupabase()
    const res = await POST(req({ token_hash: 'th-1', type: 'recovery' }))
    expect(res.status).toBe(200)
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'th-1', type: 'recovery' })
  })

  it.each(['email', 'signup', 'invite', 'email_change', 'magiclink'])(
    'rejects type=%s with 400 and never calls Supabase (no session minted)',
    async (type) => {
      const { verifyOtp } = mockSupabase()
      const res = await POST(req({ token_hash: 'th-1', type }))
      expect(res.status).toBe(400)
      expect(verifyOtp).not.toHaveBeenCalled()
    },
  )

  it('returns 400 when token_hash is missing', async () => {
    mockSupabase()
    const res = await POST(req({ type: 'recovery' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 with a clear message when the token is expired/reused', async () => {
    mockSupabase({ verifyError: { message: 'Token has expired or is invalid', status: 400 } })
    const res = await POST(req({ token_hash: 'th-1', type: 'recovery' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/invalid or has expired/i)
  })
})
