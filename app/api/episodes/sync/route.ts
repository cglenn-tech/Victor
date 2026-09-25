import { getDeviceFromToken } from '@/lib/device-auth'
import { getAdminClient } from '@/lib/supabase-admin'
import { episodePayload, record } from '@/lib/agent-payload'

export async function POST(request: Request) {
  const device = await getDeviceFromToken(request.headers.get('authorization'))
  if (!device) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  let args
  try {
    const payload = episodePayload(await request.json())
    args = { p_device_id: device.id, p_user_id: device.user_id, p_episode: payload }
  } catch {
    return Response.json({ error: 'Invalid episodes payload' }, { status: 400 })
  }
  const admin = getAdminClient()
  const { error } = await admin.rpc('sync_agent_episode', args)
  if (error) {
    const status = error.code === '42501' ? 403 : error.code === '23503' ? 409 : 500
    return Response.json({ error: status === 409 ? 'Episode must sync first' : 'Unable to sync episodes' }, { status })
  }
  await admin.from('devices').update({ last_seen_at: new Date().toISOString() }).eq('id', device.id)
  return Response.json({ ok: true })
}
