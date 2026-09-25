import { getServerClient } from '@/lib/supabase-server'
import { getAdminClient } from '@/lib/supabase-admin'
import { isModelConfigured } from '@/lib/model-client'

// Durable controls supplement Realtime: a dropped broadcast cannot leave capture running.
export async function POST(request: Request) {
  const client = await getServerClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  let body
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }) }
  if (!body || !['start', 'stop', 'heartbeat'].includes(body.action) || (body.action === 'start' && typeof body.deviceId !== 'string')) return Response.json({ error: 'Invalid command' }, { status: 400 })
  if (body.action === 'start' && !isModelConfigured()) return Response.json({ error: 'The vision service needs to be configured before recording can start.' }, { status: 503 })
  const patch: Record<string, unknown> = { browser_seen_at: new Date().toISOString() }
  if (body.action !== 'heartbeat') patch.recording_requested = body.action === 'start'
  let query = getAdminClient().from('devices').update(patch).eq('user_id', user.id).is('revoked_at', null)
  if (body.deviceId) query = query.eq('id', body.deviceId)
  const { data, error } = await query.select('id')
  if (error) return Response.json({ error: 'Unable to update desktop session' }, { status: 500 })
  if (body.action === 'start' && !data?.length) return Response.json({ error: 'Linked device not found' }, { status: 404 })
  return Response.json({ ok: true })
}
