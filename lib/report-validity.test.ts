import { describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/supabase-admin', () => ({ getAdminClient: vi.fn() }))
import { getAdminClient } from './supabase-admin'
import { reportIsCurrent } from './report-validity'
const report = { source_episode_ids: ['test-entry'], created_at: '2026-09-25T21:00:00Z' }
describe('saved report integrity', () => {
  it('invalidates saved reports containing voided, deleted, missing or changed work', async () => {
    for (const rows of [[], [{ id: 'test-entry', is_reportable: false }], [{ id: 'test-entry', deleted_at: '2026-09-26T20:00:00Z' }], [{ id: 'test-entry', edited_at: '2026-09-26T20:00:00Z' }]]) {
      const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), in: vi.fn().mockResolvedValue({ data: rows }) }
      vi.mocked(getAdminClient).mockReturnValue({ from: () => query } as unknown as ReturnType<typeof getAdminClient>)
      expect(await reportIsCurrent('owner', report)).toBe(false)
      expect(query.eq).toHaveBeenCalledWith('user_id', 'owner')
    }
  })
  it('keeps a report whose recorded sources are still valid', async () => {
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), in: vi.fn().mockResolvedValue({ data: [{ id: 'test-entry', is_reportable: true }] }) }
    vi.mocked(getAdminClient).mockReturnValue({ from: () => query } as unknown as ReturnType<typeof getAdminClient>)
    expect(await reportIsCurrent('owner', report)).toBe(true)
  })
})
