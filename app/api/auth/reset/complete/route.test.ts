import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase-server', () => ({ getServerClient: vi.fn() }))

import { getServerClient } from '@/lib/supabase-server'
import { POST } from './route'

const USER = { id: 'usr-1', email: 'test@example.com' }

function mockAuth(options: {
  user?: unknown
  updateError?: { message: string; status?: number } | null
  signOutError?: { message: string } | null
} = {}) {
  const {
    user = USER,
    updateError = null,
    signOutError = null,
  } = options

  const updateUser = vi.fn().mockResolvedValue({ error: updateError })
  const signOut = vi.fn().mockResolvedValue({ error: signOutError })

  vi.mocked(getServerClient).mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
      updateUser,
      signOut,
    },
  } as unknown as Awaited<ReturnType<typeof getServerClient>>)

  return { updateUser, signOut }
}

function req(body: Record<string, unknown>) {
  return new Request('http://localhost:3000/api/auth/reset/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/auth/reset/complete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when there is no session (never updates a bare visitor)', async () => {
    const { updateUser } = mockAuth({ user: null })
    const res = await POST(req({ password: 'newpass1', confirmPassword: 'newpass1' }))
    expect(res.status).toBe(401)
    expect(updateUser).not.toHaveBeenCalled()
  })

  it('rejects an empty or short password before calling Supabase', async () => {
    const { updateUser } = mockAuth()
    const res = await POST(req({ password: 'abc', confirmPassword: 'abc' }))
    expect(res.status).toBe(400)
    expect(updateUser).not.toHaveBeenCalled()
  })

  it('rejects mismatched confirmation before calling Supabase', async () => {
    const { updateUser } = mockAuth()
    const res = await POST(req({ password: 'validpass1', confirmPassword: 'different' }))
    expect(res.status).toBe(400)
    expect(updateUser).not.toHaveBeenCalled()
  })

  it('surfaces the real Supabase error instead of swallowing it', async () => {
    mockAuth({ updateError: { message: 'Password has been found in an online data breach', status: 422 } })
    const res = await POST(req({ password: 'breachedpw', confirmPassword: 'breachedpw' }))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toContain('data breach')
  })

  it('updates the password and revokes other sessions', async () => {
    const { updateUser, signOut } = mockAuth()
    const res = await POST(req({ password: 'newpass1', confirmPassword: 'newpass1' }))
    expect(res.status).toBe(200)
    expect(updateUser).toHaveBeenCalledWith({ password: 'newpass1' })
    expect(signOut).toHaveBeenCalledWith({ scope: 'others' })
    const body = await res.json()
    expect(body).toEqual({ ok: true, sessionsRevoked: true })
  })

  it('still succeeds (logged) if revocation fails — password change already happened', async () => {
    const { signOut } = mockAuth({ signOutError: { message: 'boom' } })
    const res = await POST(req({ password: 'newpass1', confirmPassword: 'newpass1' }))
    expect(res.status).toBe(200)
    expect(signOut).toHaveBeenCalled()
    const body = await res.json()
    expect(body.sessionsRevoked).toBe(false)
  })
})
