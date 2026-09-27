import { getServerClient } from '@/lib/supabase-server'
import { reportIsCurrent } from '@/lib/report-validity'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const client = await getServerClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const { data, error } = await client.from('weekly_reports').select('content, period_start, period_end, source_episode_ids, created_at')
    .eq('id', id).eq('user_id', user.id).single()
  if (error || !data) return Response.json({ error: 'Report not found' }, { status: 404 })
  if (!await reportIsCurrent(user.id, data)) return Response.json({ error: 'This report contains changed or excluded work. Generate it again.' }, { status: 409 })
  const from = String(data.period_start ?? '').replace(/[^\d-]/g, '')
  const to = String(data.period_end ?? '').replace(/[^\d-]/g, '')
  return new Response(data.content, { headers: {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename="Victor-${from}-${to}.txt"`,
    'Cache-Control': 'private, no-store',
  } })
}
