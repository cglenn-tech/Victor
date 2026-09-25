import { getAdminClient } from '@/lib/supabase-admin'
import { getDeviceFromToken } from '@/lib/device-auth'
import { isModelConfigured } from '@/lib/model-client'

function heartbeatPatch(request: Request) {
  const version = request.headers.get('x-victor-version')
  return { last_seen_at: new Date().toISOString(),
    ...(version && /^\d+\.\d+\.\d+$/.test(version) ? { app_version: version } : {}),
  }
}

export async function GET(request: Request) {
  const device = await getDeviceFromToken(request.headers.get('authorization'))
  if (!device) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const { data, error } = await getAdminClient().from('devices')
    .update(heartbeatPatch(request)).eq('id', device.id)
    .select('recording_requested, browser_seen_at').single()
  if (error || !data) return Response.json({ error: 'Unable to check session' }, { status: 503 })
  const browserRecent = data.browser_seen_at && Date.now() - Date.parse(data.browser_seen_at) < 10 * 60_000
  return Response.json({ ok: true, user_id: device.user_id, device_id: device.id,
    recording_allowed: Boolean(data.recording_requested && browserRecent && isModelConfigured()),
    model_configured: isModelConfigured(),
  }, { headers: { 'Cache-Control': 'no-store' } })
}

// A fresh desktop process always starts paused; never resume an earlier login's session.
export async function POST(request: Request) {
  const device = await getDeviceFromToken(request.headers.get('authorization'))
  if (!device) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const { error } = await getAdminClient().from('devices').update({ ...heartbeatPatch(request), recording_requested: false }).eq('id', device.id)
  return Response.json({ ok: !error, user_id: device.user_id, device_id: device.id }, { status: error ? 503 : 200, headers: { 'Cache-Control': 'no-store' } })
}
