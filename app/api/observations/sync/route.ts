import { getDeviceFromToken } from '@/lib/device-auth'
import { getAdminClient } from '@/lib/supabase-admin'
import { observationPayload, record } from '@/lib/agent-payload'

export async function POST(request: Request) {
  const device = await getDeviceFromToken(request.headers.get('authorization'))
  if (!device) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  let args
  try {
    const body = record(await request.json())
    if (!Array.isArray(body.observations) || !body.observations.length || body.observations.length > 50) throw new Error('Send 1–50 observations')
    const payload = body.observations.map(observationPayload)
    args = { p_device_id: device.id, p_user_id: device.user_id, p_observations: payload }
  } catch {
    return Response.json({ error: 'Invalid observations payload' }, { status: 400 })
  }
  const admin = getAdminClient()
  const { error } = await admin.rpc('sync_agent_observations', args)
  if (error) {
    const status = error.code === '42501' ? 403 : error.code === '23503' ? 409 : 500
    return Response.json({ error: status === 409 ? 'Episode must sync first' : 'Unable to sync observations' }, { status })
  }
  await admin.from('devices').update({ last_seen_at: new Date().toISOString() }).eq('id', device.id)
  return Response.json({ ok: true })
}
