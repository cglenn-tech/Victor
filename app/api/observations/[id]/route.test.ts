import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase-server', () => ({ getServerClient: vi.fn() }))
vi.mock('@/lib/supabase-admin', () => ({ getAdminClient: vi.fn() }))

import { getServerClient } from '@/lib/supabase-server'
import { getAdminClient } from '@/lib/supabase-admin'
import { PATCH, DELETE } from './route'

const USER = { id: 'usr-1', email: 'test@example.com' }

function mockAuth(user: unknown) {
  vi.mocked(getServerClient).mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) },
    from: vi.fn(),
  } as Awaited<ReturnType<typeof getServerClient>>)
}

function mockAdmin(options: {
  existing?: { id: string; user_id: string } | null
  lookupError?: unknown
  updateError?: { message: string } | null
  deleteError?: { message: string } | null
  updated?: Record<string, unknown>
} = {}) {
  const { existing = null, lookupError = null, updateError = null, deleteError = null, updated = {} } = options

  const mockEq2 = vi.fn().mockResolvedValue({ data: existing, error: lookupError })
  const mockEq1 = vi.fn().mockReturnValue({ single: mockEq2 })

  const updateSingle = vi.fn().mockResolvedValue({ data: updated, error: updateError })
  const updateEq = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single: updateSingle }) })

  const deleteEq = vi.fn().mockResolvedValue({ error: deleteError })

  vi.mocked(getAdminClient).mockReturnValue({
    from: vi.fn().mockImplementation(() => ({
      select: vi.fn().mockReturnValue({ eq: mockEq1 }),
      update: vi.fn().mockReturnValue({ eq: updateEq }),
      delete: vi.fn().mockReturnValue({ eq: deleteEq }),
    })),
  } as unknown as ReturnType<typeof getAdminClient>)
}

function mockServerDelete(error: { message: string } | null = null) {
  vi.mocked(getServerClient).mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: USER } }) },
    from: vi.fn().mockImplementation(() => ({
      delete: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error }) }),
    })),
  } as unknown as Awaited<ReturnType<typeof getServerClient>>)
}

const PARAMS = { params: Promise.resolve({ id: 'obs-1' }) }

describe('/api/observations/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('PATCH', () => {
    it('returns 401 when unauthenticated', async () => {
      mockAuth(null)
      mockAdmin()
      const res = await PATCH(
        new Request('http://localhost/api/observations/obs-1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ summary: 'x' }),
        }),
        PARAMS,
      )
      expect(res.status).toBe(401)
    })

    it('returns 404 when observation does not exist', async () => {
      mockAuth(USER)
      mockAdmin({ existing: null })
      const res = await PATCH(
        new Request('http://localhost/api/observations/obs-1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ summary: 'x' }),
        }),
        PARAMS,
      )
      expect(res.status).toBe(404)
    })

    it('returns 403 when observation belongs to another user', async () => {
      mockAuth(USER)
      mockAdmin({ existing: { id: 'obs-1', user_id: 'usr-other' } })
      const res = await PATCH(
        new Request('http://localhost/api/observations/obs-1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ summary: 'x' }),
        }),
        PARAMS,
      )
      expect(res.status).toBe(403)
    })

    it('edits summary and returns the observation', async () => {
      mockAuth(USER)
      const updated = { id: 'obs-1', summary: 'Edited text' }
      mockAdmin({ existing: { id: 'obs-1', user_id: USER.id }, updated })

      const res = await PATCH(
        new Request('http://localhost/api/observations/obs-1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'T', summary: 'Edited text' }),
        }),
        PARAMS,
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.observation.summary).toBe('Edited text')
    })
  })

  describe('DELETE', () => {
    it('returns 401 when unauthenticated', async () => {
      mockAuth(null)
      const res = await DELETE(new Request('http://localhost/x'), PARAMS)
      expect(res.status).toBe(401)
    })

    it('returns 204 on success', async () => {
      mockServerDelete(null)
      const res = await DELETE(new Request('http://localhost/x'), PARAMS)
      expect(res.status).toBe(204)
    })

    it('returns 500 when the delete fails', async () => {
      mockServerDelete({ message: 'boom' })
      const res = await DELETE(new Request('http://localhost/x'), PARAMS)
      expect(res.status).toBe(500)
    })
  })
})
