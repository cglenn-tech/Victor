import { createHash } from 'crypto'
import type { NextRequest } from 'next/server'
import { getAdminClient } from '@/lib/supabase-admin'

async function getDeviceFromToken(authHeader: string | null) {
  if (!authHeader?.startsWith('Bearer ')) return null
  const rawToken = authHeader.slice(7)
  const tokenHash = createHash('sha256').update(rawToken).digest('hex')

  const admin = getAdminClient()
  const { data: device } = await admin
    .from('devices')
    .select('id, user_id')
    .eq('token_hash', tokenHash)
    .is('revoked_at', null)
    .single()

  if (!device) return null

  // Update last_seen_at (fire-and-forget)
  admin.from('devices').update({ last_seen_at: new Date().toISOString() }).eq('id', device.id)

  return device
}

// Agent-side observations are structured batches (~5 screenshots each).
// The agent sends only completed observations — never screenshots.
export async function POST(request: NextRequest) {
  const device = await getDeviceFromToken(request.headers.get('authorization'))
  if (!device) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { observations?: unknown }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!Array.isArray(body.observations) || body.observations.length === 0) {
    return Response.json({ error: 'observations must be a non-empty array' }, { status: 400 })
  }
  if (body.observations.length > 50) {
    return Response.json({ error: 'Too many observations in one request' }, { status: 413 })
  }

  const rows = body.observations.map((o) => ({
    ...(o as Record<string, unknown>),
    user_id: device.user_id,
    device_id: device.id,
  }))

  const admin = getAdminClient()
  const { error } = await admin
    .from('observations')
    .upsert(rows, { onConflict: 'id' })

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, count: rows.length })
}
