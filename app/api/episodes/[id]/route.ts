import { getServerClient } from '@/lib/supabase-server'
import { getAdminClient } from '@/lib/supabase-admin'
import type { Episode } from '@/lib/types'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // RLS ensures user can only delete their own episodes
  const { error } = await getAdminClient().from('episodes').update({ deleted_at: new Date().toISOString(), is_reportable: false }).eq('id', id).eq('user_id', user.id)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return new Response(null, { status: 204 })
}

const PATCHABLE = [
  'case_name', 'work_type', 'issue_worked_on', 'key_observations',
  'started_at', 'ended_at', 'duration_minutes', 'is_reportable',
] as const

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = getAdminClient()

  // Verify ownership
  const { data: existing, error: lookupErr } = await admin
    .from('episodes')
    .select('id, user_id, started_at, ended_at')
    .is('deleted_at', null)
    .eq('id', id)
    .single()

  if (lookupErr || !existing) {
    return Response.json({ error: 'Not found' }, { status: 404 })
  }
  if (existing.user_id !== user.id) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body
  try { body = await request.json() } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }) }
  if (!body || typeof body !== 'object' ||
      ('case_name' in body && (typeof body.case_name !== 'string' || !body.case_name.trim() || body.case_name.length > 500)) ||
      ('work_type' in body && !['project', 'administrative'].includes(body.work_type)) ||
      ('issue_worked_on' in body && body.issue_worked_on !== null && (typeof body.issue_worked_on !== 'string' || body.issue_worked_on.length > 2000)) ||
      ('is_reportable' in body && typeof body.is_reportable !== 'boolean') ||
      ('key_observations' in body && (!Array.isArray(body.key_observations) || body.key_observations.some((o: unknown) => !o || typeof o !== 'object' || typeof (o as {text?: unknown}).text !== 'string')))) {
    return Response.json({ error: 'Invalid edit' }, { status: 400 })
  }
  const patch: Record<string, unknown> = { edited_at: new Date().toISOString() }
  for (const key of PATCHABLE) {
    if (key in body) patch[key] = body[key]
  }

  const start = Date.parse(String(patch.started_at ?? existing.started_at))
  const end = Date.parse(String(patch.ended_at ?? existing.ended_at))
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return Response.json({ error: 'Invalid time interval' }, { status: 400 })
  if (('started_at' in patch || 'ended_at' in patch) && !('duration_minutes' in patch)) patch.duration_minutes = (end - start) / 60000
  if ('duration_minutes' in patch) {
    if (typeof patch.duration_minutes !== 'number' || !Number.isFinite(patch.duration_minutes) || patch.duration_minutes < 0) return Response.json({ error: 'Invalid duration' }, { status: 400 })
    patch.active_seconds = patch.duration_minutes * 60
  }

  const { data, error } = await admin
    .from('episodes')
    .update(patch)
    .eq('id', id)
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .select('*')
    .single()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ episode: data as Episode })
}
