import { getDeviceFromToken } from '@/lib/device-auth'
import type { NextRequest } from 'next/server'
import { getAdminClient } from '@/lib/supabase-admin'

export async function POST(request: NextRequest) {
  const device = await getDeviceFromToken(request.headers.get('authorization'))
  if (!device) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { ids?: string[] }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { ids } = body
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500 || ids.some(id => typeof id !== 'string')) {
    return Response.json({ error: 'Missing ids' }, { status: 400 })
  }

  const admin = getAdminClient()
  const { error } = await admin
    .from('episodes')
    .update({ is_reportable: false })
    .in('id', ids)
    .eq('user_id', device.user_id)
    .eq('device_id', device.id)
    .is('edited_at', null)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}
